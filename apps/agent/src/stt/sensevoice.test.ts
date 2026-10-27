import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCallConfig } from '../config.js';
import { type AsrError, type AsrTranscript, SenseVoiceSTT, asrMetadataOf } from './sensevoice.js';

interface Captured {
  method: string;
  url: string;
  contentType: string | undefined;
  authorization: string | undefined;
  body: Buffer;
}

type Handler = (req: Captured, res: ServerResponse) => void;

initializeLogger({ pretty: false, level: 'silent' });

/** Minimal stand-in for the ASR service's OpenAI-compatible transcription endpoint. */
let server: Server;
let baseUrl: string;
let handler: Handler;
let requests: Captured[];

beforeEach(async () => {
  requests = [];
  handler = (_req, res) => json(res, 200, { text: '', raw_text: [''], elapsed_seconds: 0.001 });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured: Captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 100 ms of a 440 Hz tone at 48 kHz, as LiveKit delivers microphone audio. */
function toneFrame(sampleRate = 48000, channels = 1, ms = 100): AudioFrame {
  const samples = (sampleRate * ms) / 1000;
  const data = new Int16Array(samples * channels);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    for (let c = 0; c < channels; c++) data[i * channels + c] = v;
  }
  return new AudioFrame(data, sampleRate, channels, samples);
}

function makeStt(extra: Partial<ConstructorParameters<typeof SenseVoiceSTT>[0]> = {}) {
  return new SenseVoiceSTT({ baseUrl: `${baseUrl}/v1`, timeoutMs: 2000, language: 'zh', ...extra });
}

describe('SenseVoiceSTT request', () => {
  /** Parses the multipart body the plugin sent: the WAV `file` part and the text fields. */
  async function sentForm(req: Captured) {
    const form = await new Response(new Uint8Array(req.body), {
      headers: { 'Content-Type': req.contentType ?? '' },
    }).formData();
    const file = form.get('file') as File;
    const wav = Buffer.from(await file.arrayBuffer());
    return { form, file, wav, samples: (wav.length - 44) / 2 };
  }

  it('POSTs a 16 kHz mono WAV as multipart `file` to /v1/audio/transcriptions, downsampled from 48 kHz', async () => {
    await makeStt().recognize([toneFrame(), toneFrame()]);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/audio/transcriptions');
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const { form, file, wav, samples } = await sentForm(req);
    expect(form.get('response_format')).toBe('json');
    expect(form.get('language')).toBe('zh');
    expect(file.type).toBe('audio/wav');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    // 200 ms at 16 kHz (resampler may trim a few edge samples)
    expect(samples).toBeGreaterThan(3100);
    expect(samples).toBeLessThanOrEqual(3200);
    const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, samples);
    expect(Math.max(...pcm)).toBeGreaterThan(5000); // the tone survives resampling
  });

  it('keeps a base URL path prefix', async () => {
    await makeStt({ baseUrl: `${baseUrl}/asr/v1` }).recognize(toneFrame());
    expect(requests[0]!.url).toBe('/asr/v1/audio/transcriptions');
  });

  it('sends no key or model to SenseVoice; a hosted ASR gets both and may answer with plain `{ text }`', async () => {
    await makeStt().recognize(toneFrame());
    expect(requests[0]!.authorization).toBeUndefined();
    expect((await sentForm(requests[0]!)).form.get('model')).toBeNull();

    handler = (_req, res) => json(res, 200, { text: '你好呀', usage: { cost: 0.00001 } });
    const hosted = makeStt({ baseUrl: `${baseUrl}/api/v1`, apiKey: 'sk-or-test', model: 'qwen/qwen3-asr-1.7b' });
    const event = await hosted.recognize(toneFrame());
    const req = requests[1]!;
    expect(req.url).toBe('/api/v1/audio/transcriptions');
    expect(req.authorization).toBe('Bearer sk-or-test');
    expect((await sentForm(req)).form.get('model')).toBe('qwen/qwen3-asr-1.7b');
    expect(event.alternatives?.[0]?.text).toBe('你好呀');
    expect(asrMetadataOf(event)).toMatchObject({ emotion: 'unknown', events: [] });
    expect(hosted.model).toBe('qwen/qwen3-asr-1.7b');
  });

  it('downmixes stereo input to mono', async () => {
    await makeStt().recognize(toneFrame(48000, 2));
    const { samples } = await sentForm(requests[0]!);
    expect(samples).toBeLessThanOrEqual(1600);
    expect(samples).toBeGreaterThan(1500);
  });
});

describe('SenseVoiceSTT result', () => {
  it('decodes text, plus emotion and events from the raw SenseVoice tags', async () => {
    handler = (_req, res) =>
      json(res, 200, {
        text: '今天天气怎么样。',
        raw_text: ['<|zh|><|HAPPY|><|Speech|><|Laughter|><|withitn|>今天天气怎么样。'],
        elapsed_seconds: 0.0874,
      });
    const seen: AsrTranscript[] = [];

    const ev = await makeStt({ onTranscript: (t) => seen.push(t) }).recognize(toneFrame());

    expect(ev.type).toBe(2 /* FINAL_TRANSCRIPT */);
    expect(ev.alternatives?.[0]?.text).toBe('今天天气怎么样。');
    expect(ev.alternatives?.[0]?.language).toBe('zh');
    expect(asrMetadataOf(ev)).toEqual({ emotion: 'happy', events: ['speech', 'laughter'], inferenceMs: 87, audioMs: 100 });
    expect(seen).toEqual([
      { text: '今天天气怎么样。', emotion: 'happy', events: ['speech', 'laughter'], inferenceMs: 87, audioMs: 100 },
    ]);
  });

  it('maps unknown tags to emotion "unknown" / dropped events, and tolerates a missing raw_text', async () => {
    handler = (_req, res) => json(res, 200, { text: '嗯', raw_text: '<|zh|><|EMO_UNKNOWN|><|Speech|><|Whistle|>嗯' });
    const ev = await makeStt().recognize(toneFrame());
    expect(asrMetadataOf(ev)?.emotion).toBe('unknown');
    expect(asrMetadataOf(ev)?.events).toEqual(['speech']);

    handler = (_req, res) => json(res, 200, { text: '好的' });
    const bare = await makeStt().recognize(toneFrame());
    expect(bare.alternatives?.[0]?.text).toBe('好的');
    expect(asrMetadataOf(bare)).toMatchObject({ emotion: 'unknown', events: [], inferenceMs: 0 });
  });

  it('reads a hosted ASR\'s inline cues (Fish Audio) and strips them and the speaker marker', async () => {
    handler = (_req, res) => json(res, 200, { text: '<|speaker:0|>[开心][laughter]哈哈，今天真是太开心了。' });
    const ev = await makeStt().recognize(toneFrame());
    expect(ev.alternatives?.[0]?.text).toBe('哈哈，今天真是太开心了。');
    expect(asrMetadataOf(ev)).toMatchObject({ emotion: 'happy', events: ['laughter'] });

    handler = (_req, res) => json(res, 200, { text: '<|speaker:0|> [frustrated, sighing]我都说了三遍了 [嘟囔]' });
    const angry = await makeStt().recognize(toneFrame());
    expect(angry.alternatives?.[0]?.text).toBe('我都说了三遍了');
    expect(asrMetadataOf(angry)).toMatchObject({ emotion: 'angry', events: [] });
  });

  it('strips any SenseVoice tags left in text', async () => {
    handler = (_req, res) => json(res, 200, { text: '<|zh|><|NEUTRAL|>你好' });
    const ev = await makeStt().recognize(toneFrame());
    expect(ev.alternatives?.[0]?.text).toBe('你好');
  });

  it('returns an empty transcript (and no onTranscript call) when nothing was recognized', async () => {
    const seen: AsrTranscript[] = [];
    const ev = await makeStt({ onTranscript: (t) => seen.push(t) }).recognize(toneFrame());
    expect(ev.alternatives?.[0]?.text).toBe('');
    expect(seen).toEqual([]);
  });
});

describe('SenseVoiceSTT errors', () => {
  async function recognizeError(stt = makeStt()): Promise<AsrError> {
    const errors: unknown[] = [];
    stt.on('error', (e) => errors.push(e));
    const error = await stt.recognize(toneFrame()).then(
      () => {
        throw new Error('expected recognize to fail');
      },
      (e: unknown) => e as AsrError,
    );
    expect(error.name).toBe('AsrError');
    // also surfaced as a recoverable stt_error for AgentSession listeners
    expect(errors).toEqual([expect.objectContaining({ type: 'stt_error', recoverable: true, error })]);
    return error;
  }

  it('service error status → kind "service" with status and the FastAPI detail message', async () => {
    handler = (_req, res) => json(res, 400, { detail: 'response_format must be json or text' });
    const error = await recognizeError();
    expect(error).toMatchObject({ kind: 'service', status: 400 });
    expect(error.message).toContain('response_format must be json or text');
  });

  it('timeout → kind "timeout"', async () => {
    handler = () => {}; // never answers
    const error = await recognizeError(makeStt({ timeoutMs: 200 }));
    expect(error.kind).toBe('timeout');
  });

  it('service down → kind "unreachable"', async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const error = await recognizeError();
    expect(error.kind).toBe('unreachable');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); // for afterEach
  });

  it('malformed 200 body → kind "bad_response"', async () => {
    handler = (_req, res) => json(res, 200, { transcript: 'x' });
    const error = await recognizeError();
    expect(error.kind).toBe('bad_response');
  });
});

describe('ASR config', () => {
  it('switches between SenseVoice and OpenRouter by ASR_BACKEND, with per-backend defaults', () => {
    const local = loadCallConfig({ ASR_API_KEY: 'ignored', ASR_MODEL: 'ignored' });
    expect(local).toMatchObject({ asrBackend: 'sensevoice', asrBaseUrl: 'http://127.0.0.1:8001/v1' });
    expect(local.asrApiKey).toBeUndefined();
    expect(local.asrModel).toBeUndefined();
    expect(loadCallConfig({ ASR_BASE_URL: 'http://192.168.31.82:8001/v1' }).asrBaseUrl).toBe('http://192.168.31.82:8001/v1');

    expect(loadCallConfig({ ASR_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'sk-or-shared' })).toMatchObject({
      asrBaseUrl: 'https://openrouter.ai/api/v1', asrApiKey: 'sk-or-shared', asrModel: 'fish-audio/transcribe-1-pro',
    });
    expect(loadCallConfig({ ASR_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'sk-or-shared', ASR_API_KEY: 'sk-or-asr' }).asrApiKey).toBe('sk-or-asr');
    expect(() => loadCallConfig({ ASR_BACKEND: 'openrouter' })).toThrow(/ASR_API_KEY: required/);
    expect(() => loadCallConfig({ ASR_URL: 'https://openrouter.ai/api' })).toThrow(/ASR_URL → ASR_BASE_URL/);
  });
});

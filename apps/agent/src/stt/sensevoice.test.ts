import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AsrError, type AsrTranscript, SenseVoiceSTT, asrMetadataOf } from './sensevoice.js';

interface Captured {
  method: string;
  url: string;
  contentType: string | undefined;
  body: Buffer;
}

type Handler = (req: Captured, res: ServerResponse) => void;

initializeLogger({ pretty: false, level: 'silent' });

/** Minimal stand-in for services/asr implementing its HTTP contract. */
let server: Server;
let baseUrl: string;
let handler: Handler;
let requests: Captured[];

beforeEach(async () => {
  requests = [];
  handler = (_req, res) => json(res, 200, { text: '', emotion: 'neutral', events: [], duration_ms: 1 });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured: Captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
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
  return new SenseVoiceSTT({ baseUrl, timeoutMs: 2000, language: 'zh', ...extra });
}

describe('SenseVoiceSTT request', () => {
  it('POSTs 16 kHz mono s16le PCM to /asr, downsampled from a 48 kHz frame', async () => {
    await makeStt().recognize([toneFrame(), toneFrame()]);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/asr');
    expect(req.contentType).toBe('audio/pcm;rate=16000;channels=1');
    // 200 ms at 16 kHz, 2 bytes per sample (resampler may trim a few edge samples)
    expect(req.body.length % 2).toBe(0);
    expect(req.body.length / 2).toBeGreaterThan(3100);
    expect(req.body.length / 2).toBeLessThanOrEqual(3200);
    const pcm = new Int16Array(req.body.buffer, req.body.byteOffset, req.body.length / 2);
    expect(Math.max(...pcm)).toBeGreaterThan(5000); // the tone survives resampling
  });

  it('downmixes stereo input to mono', async () => {
    await makeStt().recognize(toneFrame(48000, 2));
    expect(requests[0]!.body.length / 2).toBeLessThanOrEqual(1600);
    expect(requests[0]!.body.length / 2).toBeGreaterThan(1500);
  });
});

describe('SenseVoiceSTT result', () => {
  it('decodes text, emotion and events into a final transcript', async () => {
    handler = (_req, res) =>
      json(res, 200, { text: '今天天气怎么样。', emotion: 'happy', events: ['speech', 'laughter'], duration_ms: 87 });
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

  it('maps unexpected emotion/event values to unknown / dropped', async () => {
    handler = (_req, res) => json(res, 200, { text: '嗯', emotion: 'bored', events: ['speech', 'whistle'], duration_ms: 5 });
    const ev = await makeStt().recognize(toneFrame());
    expect(asrMetadataOf(ev)?.emotion).toBe('unknown');
    expect(asrMetadataOf(ev)?.events).toEqual(['speech']);
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

  it('service error status → kind "service" with status and error code', async () => {
    handler = (_req, res) => json(res, 500, { error: 'inference_failed', message: 'boom' });
    const error = await recognizeError();
    expect(error).toMatchObject({ kind: 'service', status: 500, code: 'inference_failed' });
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

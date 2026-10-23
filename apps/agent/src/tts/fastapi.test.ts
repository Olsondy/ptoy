import { initializeLogger, tts } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { sleep } from '../../test/fakes/http.js';
import {
  FAKE_FASTAPI_MS_PER_CHAR,
  FAKE_FASTAPI_SAMPLE_RATE,
  type FakeTtsFastApi,
  type FakeTtsFastApiOptions,
  startFakeTtsFastApi,
} from '../../test/fakes/tts-fastapi.js';
import { loadConversationConfig } from '../config.js';
import { TtsError } from './backend.js';
import { IndexTtsFastApiBackend, type IndexTtsFastApiOptions } from './fastapi.js';
import { createTtsBackend } from './index.js';
import { IndexTTS } from './plugin.js';

initializeLogger({ pretty: false, level: 'silent' });

let server: FakeTtsFastApi | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(fake: FakeTtsFastApiOptions = {}, backend: Partial<IndexTtsFastApiOptions> = {}) {
  server = await startFakeTtsFastApi(fake);
  const be = new IndexTtsFastApiBackend({ url: server.url, emotionControl: 'reference', timeoutMs: 2000, ...backend });
  const plugin = new IndexTTS({ backend: be, sampleRate: 24000 });
  const errors: Parameters<tts.TTSCallbacks['error']>[0][] = [];
  plugin.on('error', (e) => errors.push(e));
  return { server, backend: be, plugin, errors };
}

const never = () => new AbortController().signal;

async function collect(stream: AsyncIterable<{ frame: { samplesPerChannel: number; sampleRate: number } }>) {
  let samples = 0;
  let sampleRate = 0;
  for await (const ev of stream) {
    samples += ev.frame.samplesPerChannel;
    sampleRate = ev.frame.sampleRate;
  }
  return { samples, sampleRate, ms: sampleRate ? (samples / sampleRate) * 1000 : 0 };
}

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as TtsError);

describe('IndexTTS FastAPI backend request', () => {
  it('posts the text with a request id and, in reference mode, no emotion', async () => {
    const { server, backend } = await setup();
    await backend.synthesize({ text: '你好呀。', emotion: '喜' }, never());
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toEqual({ text: '你好呀。', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('in vector mode sends the segment emotion', async () => {
    const { server, backend } = await setup({}, { emotionControl: 'vector' });
    await backend.synthesize({ text: '太好了！', emotion: '喜' }, never());
    await backend.synthesize({ text: '嗯。', emotion: '平静' }, never());
    expect(server.calls.map((c) => c.emotion)).toEqual(['喜', '平静']);
    expect(server.calls[0]!.request_id).not.toBe(server.calls[1]!.request_id);
  });

  it('sends the emotion strength as emo_alpha in vector mode', async () => {
    const { server, backend } = await setup({}, { emotionControl: 'vector', emotionWeight: 0.8 });
    await backend.synthesize({ text: '太好了！', emotion: '喜' }, never());
    expect(server.calls[0]).toMatchObject({ emotion: '喜', emo_alpha: 0.8 });
  });

  it('decodes s16le PCM at the X-Sample-Rate', async () => {
    const { backend } = await setup();
    const audio = await backend.synthesize({ text: '一二三。', emotion: '平静' }, never());
    expect(audio.sampleRate).toBe(FAKE_FASTAPI_SAMPLE_RATE);
    expect(audio.channels).toBe(1);
    expect(audio.samples.length).toBe(Math.round((FAKE_FASTAPI_SAMPLE_RATE * FAKE_FASTAPI_MS_PER_CHAR * 4) / 1000));
    expect(audio.samples[0]).toBe(0);
    expect(audio.samples[1]).toBe(Math.round(Math.sin((2 * Math.PI * 440) / FAKE_FASTAPI_SAMPLE_RATE) * 6000));
  });

  it('through the plugin the audio is resampled to the output rate', async () => {
    const { plugin } = await setup();
    const audio = await collect(plugin.synthesize('你好呀，朋友。'));
    expect(audio.sampleRate).toBe(24000);
    expect(audio.ms).toBeGreaterThan(7 * FAKE_FASTAPI_MS_PER_CHAR - 10);
    expect(audio.ms).toBeLessThan(7 * FAKE_FASTAPI_MS_PER_CHAR + 10);
  });
});

describe('IndexTTS FastAPI cancellation', () => {
  it('aborting a running request calls /cancel with its id and the plugin drops the audio', async () => {
    const { server, plugin, errors } = await setup({ synthMs: 1000 });
    const abort = new AbortController();
    const result = collect(plugin.synthesize('这句话会被打断。', undefined, abort.signal));
    await sleep(100);
    expect(server.calls).toHaveLength(1);
    abort.abort();
    expect((await result).samples).toBe(0);
    await sleep(100);
    expect(server.cancels).toEqual([server.calls[0]!.request_id]);
    expect(errors).toEqual([]);
  });

  it('backend rejects with the abort reason', async () => {
    const { backend } = await setup({ synthMs: 1000 });
    const abort = new AbortController();
    const p = failure(backend.synthesize({ text: '你好。', emotion: '平静' }, abort.signal));
    await sleep(50);
    abort.abort(new Error('interrupted'));
    expect(((await p) as unknown as Error).message).toBe('interrupted');
  });

  it('a timeout also cancels server-side and is a `timeout` TtsError', async () => {
    const { server, backend } = await setup({ synthMs: 1000 }, { timeoutMs: 100 });
    const error = await failure(backend.synthesize({ text: '你好。', emotion: '平静' }, never()));
    expect(error).toBeInstanceOf(TtsError);
    expect(error!.kind).toBe('timeout');
    await sleep(50);
    expect(server.cancels).toEqual([server.calls[0]!.request_id]);
  });

  it('a completed request is not cancelled', async () => {
    const { server, backend } = await setup();
    await backend.synthesize({ text: '你好。', emotion: '平静' }, never());
    expect(server.cancels).toEqual([]);
  });
});

describe('IndexTTS FastAPI failures', () => {
  const synth = async (fake: FakeTtsFastApiOptions) => {
    const { backend } = await setup(fake);
    return failure(backend.synthesize({ text: '你好。', emotion: '平静' }, never()));
  };

  it('an HTTP error is a `service` TtsError with status and detail', async () => {
    const error = await synth({ fail: () => 'http500' });
    expect(error).toBeInstanceOf(TtsError);
    expect(error!.kind).toBe('service');
    expect(error!.status).toBe(500);
    expect(error!.message).toContain('CUDA out of memory');
  });

  it('a partial sample or a missing sample rate is `bad_response`', async () => {
    expect((await synth({ fail: () => 'odd' }))!.kind).toBe('bad_response');
    expect((await synth({ fail: () => 'no_rate' }))!.kind).toBe('bad_response');
  });

  it('a closed port is `unreachable`', async () => {
    const be = new IndexTtsFastApiBackend({ url: 'http://127.0.0.1:9', emotionControl: 'reference', timeoutMs: 1000 });
    const error = await failure(be.synthesize({ text: '你好。', emotion: '平静' }, never()));
    expect(error).toBeInstanceOf(TtsError);
    expect(error!.kind).toBe('unreachable');
  });

  it('the plugin surfaces failures as a non-retried tts_error', async () => {
    const { server, plugin, errors } = await setup({ fail: () => 'http500' });
    expect((await collect(plugin.synthesize('你好。'))).samples).toBe(0);
    expect(server.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe('tts_error');
  });

  it('prewarm never throws, even when the service is down', async () => {
    const be = new IndexTtsFastApiBackend({ url: 'http://127.0.0.1:9', emotionControl: 'reference', timeoutMs: 500 });
    await expect(be.prewarm()).resolves.toBeUndefined();
  });
});

describe('TTS_BACKEND=fastapi config', () => {
  it('selects the FastAPI backend without requiring TTS_REF_AUDIO', () => {
    const config = loadConversationConfig({ TTS_BACKEND: 'fastapi', TTS_FASTAPI_URL: 'http://10.0.0.2:8002' });
    expect(config.tts).toEqual({
      backend: 'fastapi',
      url: 'http://10.0.0.2:8002',
      emotionControl: 'vector',
      emotionWeight: 0.8,
      timeoutMs: 20000,
    });
    expect(createTtsBackend(config.tts).name).toBe('indextts-fastapi');
  });

  it('gradio still requires TTS_REF_AUDIO', () => {
    expect(() => loadConversationConfig({ TTS_BACKEND: 'gradio' })).toThrow(/TTS_REF_AUDIO/);
  });
});

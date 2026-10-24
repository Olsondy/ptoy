import { initializeLogger } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeRequest, type FakeServer, json, sleep, startFakeServer } from '../../test/fakes/http.js';
import { loadConversationConfig } from '../config.js';
import { TtsError } from './backend.js';
import { createTtsBackend } from './index.js';
import { OpenRouterTtsBackend, type OpenRouterTtsOptions } from './openrouter.js';
import { encodeWav } from './wav.js';

initializeLogger({ pretty: false, level: 'silent' });

const CLIP = encodeWav({ samples: Int16Array.from([0, 1000, -1000, 0]), sampleRate: 44100, channels: 1 });

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(
  respond: (req: FakeRequest, res: Parameters<Parameters<typeof startFakeServer>[0]>[1]) => void | Promise<void> = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(CLIP);
  },
  opts: Partial<OpenRouterTtsOptions> = {},
) {
  const calls: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  server = await startFakeServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/audio/speech') return json(res, 404, { error: 'not found' });
    calls.push({ auth: req.headers.authorization, body: JSON.parse(req.body.toString()) as Record<string, unknown> });
    return respond(req, res);
  });
  const backend = new OpenRouterTtsBackend({
    url: `${server.url}/api/v1/`,
    apiKey: 'sk-or-test',
    model: 'fish-audio/s2.1-pro',
    emotionControl: 'vector',
    timeoutMs: 2000,
    ...opts,
  });
  return { backend, calls };
}

const never = () => new AbortController().signal;
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as TtsError);

describe('OpenRouter TTS backend', () => {
  it('asks for wav with the key, model and voice, and decodes the clip', async () => {
    const { backend, calls } = await setup(undefined, { voice: 'fish-voice-1' });
    const audio = await backend.synthesize({ text: '你好呀。', emotion: '平静' }, never());
    expect(calls).toEqual([
      {
        auth: 'Bearer sk-or-test',
        body: { model: 'fish-audio/s2.1-pro', input: '你好呀。', response_format: 'wav', voice: 'fish-voice-1' },
      },
    ]);
    expect(audio).toMatchObject({ sampleRate: 44100, channels: 1 });
    expect(Array.from(audio.samples)).toEqual([0, 1000, -1000, 0]);
  });

  it('in vector mode turns a non-calm emotion into a style hint; reference mode sends the text as is', async () => {
    const { backend, calls } = await setup();
    await backend.synthesize({ text: '太好了！', emotion: '喜' }, never());
    await backend.synthesize({ text: '嗯。', emotion: '平静' }, never());
    const plain = new OpenRouterTtsBackend({
      url: `${server!.url}/api/v1`,
      apiKey: 'k',
      model: 'm',
      emotionControl: 'reference',
      timeoutMs: 2000,
    });
    await plain.synthesize({ text: '太好了！', emotion: '喜' }, never());
    expect(calls.map((c) => c.body.input)).toEqual(['[开心] 太好了！', '嗯。', '太好了！']);
    expect(calls[0]!.body).not.toHaveProperty('voice');
  });

  it('puts the character style before every sentence, joined with the emotion hint', async () => {
    const { backend, calls } = await setup(undefined, { style: '亲密中文耳语' });
    await backend.synthesize({ text: '嗯。', emotion: '平静' }, never());
    await backend.synthesize({ text: '太好了！', emotion: '喜' }, never());
    expect(calls.map((c) => c.body.input)).toEqual(['[亲密中文耳语] 嗯。', '[亲密中文耳语，开心] 太好了！']);
  });

  it('reports an error status as a service failure', async () => {
    const { backend } = await setup((_req, res) => json(res, 402, { error: { message: 'Insufficient credits' } }));
    const error = await failure(backend.synthesize({ text: '嗯。', emotion: '平静' }, never()));
    expect(error).toBeInstanceOf(TtsError);
    expect(error).toMatchObject({ kind: 'service', status: 402 });
    expect(error?.message).toContain('Insufficient credits');
  });

  it('reports non-wav audio as a bad response', async () => {
    const { backend } = await setup((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('ID3 not a wav'));
    });
    const error = await failure(backend.synthesize({ text: '嗯。', emotion: '平静' }, never()));
    expect(error).toMatchObject({ kind: 'bad_response' });
  });

  it('times out, and an abort rejects with the abort reason', async () => {
    const { backend } = await setup(async (_req, res) => {
      await sleep(500);
      res.end(CLIP);
    }, { timeoutMs: 50 });
    expect(await failure(backend.synthesize({ text: '嗯。', emotion: '平静' }, never()))).toMatchObject({ kind: 'timeout' });

    const controller = new AbortController();
    const pending = failure(backend.synthesize({ text: '嗯。', emotion: '平静' }, controller.signal));
    controller.abort(new Error('interrupted'));
    expect((await pending)?.message).toBe('interrupted');
  });
});

describe('OpenRouter TTS config', () => {
  const env = {
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    TTS_BACKEND: 'openrouter',
    TTS_OPENROUTER_API_KEY: 'sk-or-test',
  };

  it('maps the character voice to its provider voice id', async () => {
    const config = loadConversationConfig({ ...env, TTS_OPENROUTER_VOICES: 'xiaoyou-default=abc, zhixin = def' });
    expect(config.tts).toMatchObject({
      backend: 'openrouter',
      url: 'https://openrouter.ai/api/v1',
      model: 'fish-audio/s2.1-pro',
      voices: { 'xiaoyou-default': 'abc', zhixin: 'def' },
    });
    server = await startFakeServer((req, res) => {
      const body = JSON.parse(req.body.toString()) as { voice?: string };
      res.writeHead(body.voice === 'def' ? 200 : 400);
      res.end(body.voice === 'def' ? CLIP : undefined);
    });
    const backend = createTtsBackend({ ...config.tts, url: server.url } as typeof config.tts, 'zhixin');
    await expect(backend.synthesize({ text: '嗯。', emotion: '平静' }, never())).resolves.toMatchObject({ sampleRate: 44100 });
  });

  it('requires the key and well-formed voice pairs', () => {
    const { TTS_OPENROUTER_API_KEY: _key, ...noKey } = env;
    expect(() => loadConversationConfig(noKey)).toThrow(/TTS_OPENROUTER_API_KEY/);
    expect(() => loadConversationConfig({ ...env, TTS_OPENROUTER_VOICES: 'xiaoyou-default' })).toThrow(
      /TTS_OPENROUTER_VOICES/,
    );
  });
});

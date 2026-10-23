import { USERDATA_TIMED_TRANSCRIPT, initializeLogger, tts } from '@livekit/agents';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FAKE_MS_PER_CHAR, type FakeGradio, type FakeGradioOptions, startFakeGradio } from '../../test/fakes/gradio.js';
import { sleep } from '../../test/fakes/http.js';
import { TtsError } from './backend.js';
import { IndexTtsGradioBackend, type IndexTtsGradioOptions } from './gradio.js';
import { IndexTTS } from './plugin.js';
import { decodeWav, encodeWav } from './wav.js';

initializeLogger({ pretty: false, level: 'silent' });

const dir = mkdtempSync(join(tmpdir(), 'ptoy-tts-'));
const refPath = join(dir, 'ref.wav');
writeFileSync(refPath, encodeWav({ samples: new Int16Array(2205), sampleRate: 22050, channels: 1 }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let gradio: FakeGradio | undefined;
afterEach(async () => {
  await gradio?.close();
  gradio = undefined;
});

async function setup(fake: FakeGradioOptions = {}, backend: Partial<IndexTtsGradioOptions> = {}) {
  gradio = await startFakeGradio(fake);
  const be = new IndexTtsGradioBackend({
    url: gradio.url,
    refAudioPath: refPath,
    language: 'ZH',
    emotionControl: 'reference',
    timeoutMs: 2000,
    ...backend,
  });
  const plugin = new IndexTTS({ backend: be, sampleRate: 24000 });
  const errors: Parameters<tts.TTSCallbacks['error']>[0][] = [];
  plugin.on('error', (e) => errors.push(e));
  return { gradio, backend: be, plugin, errors };
}

async function collect(stream: AsyncIterable<{ frame: { samplesPerChannel: number; sampleRate: number } }>) {
  let samples = 0;
  let sampleRate = 0;
  for await (const ev of stream) {
    samples += ev.frame.samplesPerChannel;
    sampleRate = ev.frame.sampleRate;
  }
  return { samples, sampleRate, ms: sampleRate ? (samples / sampleRate) * 1000 : 0 };
}

describe('IndexTTS Gradio backend request', () => {
  it('calls /gen_single with our text, language and reference, keeping WebUI defaults for the rest', async () => {
    const { gradio, backend } = await setup();
    await backend.synthesize({ text: '你好呀。', emotion: '平静' }, new AbortController().signal);

    expect(gradio.calls).toHaveLength(1);
    const call = gradio.calls[0]!;
    expect(call.text).toBe('你好呀。');
    expect(call.lang_choice).toBe('ZH');
    expect(call.emo_control_method).toBe('与音色参考音频相同');
    expect(call.prompt).toEqual({ path: 'C:\\gradio\\tmp\\ref.wav', meta: { _type: 'gradio.FileData' } });
    expect(call.emo_ref_path).toBeNull();
    expect(call.emo_weight).toBe(0.65);
    expect(call.max_text_tokens_per_segment).toBe(80);
    expect(call.param_18).toBe(true);
  });

  it('uploads the reference audio once and reuses its server path', async () => {
    const { gradio, backend } = await setup();
    const signal = new AbortController().signal;
    await backend.synthesize({ text: '一。', emotion: '平静' }, signal);
    await backend.synthesize({ text: '二。', emotion: '平静' }, signal);
    expect(gradio.uploads).toBe(1);
    expect(gradio.calls).toHaveLength(2);
  });

  it('in vector mode sends the segment emotion as the one-hot emotion vector with emo_weight', async () => {
    const { gradio, backend } = await setup({}, { emotionControl: 'vector', emotionWeight: 0.8 });
    await backend.synthesize({ text: '太好了！', emotion: '喜' }, new AbortController().signal);
    await backend.synthesize({ text: '对不起。', emotion: '哀' }, new AbortController().signal);
    const vec = (call: Record<string, unknown>) => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => call[`vec${i}`]);
    const [happy, sad] = gradio.calls;
    expect(happy!.emo_control_method).toBe('使用情感向量控制');
    expect(vec(happy!)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(happy!.emo_weight).toBe(0.8);
    expect(vec(sad!)).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
  });

  it('in vector mode speaks 平静 with the reference audio (no vector)', async () => {
    const { gradio, backend } = await setup({}, { emotionControl: 'vector', emotionWeight: 0.8 });
    await backend.synthesize({ text: '好的。', emotion: '平静' }, new AbortController().signal);
    const call = gradio.calls[0]!;
    expect(call.emo_control_method).toBe('与音色参考音频相同');
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((i) => call[`vec${i}`])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(call.emo_weight).toBe(0.65);
  });
});

describe('IndexTTS plugin audio', () => {
  it('decodes the 22.05 kHz wav and resamples it to the output rate', async () => {
    const { plugin } = await setup();
    const audio = await collect(plugin.synthesize('你好呀，朋友。'));
    expect(audio.sampleRate).toBe(24000);
    // 7 chars × 100 ms of fake audio (resampler may trim a few edge samples)
    expect(audio.ms).toBeGreaterThan(7 * FAKE_MS_PER_CHAR - 10);
    expect(audio.ms).toBeLessThan(7 * FAKE_MS_PER_CHAR + 10);
  });

  it('stream() segments the reply: short first segment, tags parsed out, one request at a time', async () => {
    const { gradio, plugin } = await setup({ synthMs: 40 }, { emotionControl: 'vector' });
    const stream = plugin.stream();
    for (const t of ['[喜', ']好呀', '，今天', '过得怎么样？', '[哀]我', '有点累。']) stream.pushText(t);
    stream.endInput();
    let samples = 0;
    const timed: { text: string; startTime?: number }[] = [];
    for await (const ev of stream) {
      if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
      samples += ev.frame.samplesPerChannel;
      const t = ev.frame.userdata[USERDATA_TIMED_TRANSCRIPT] as { text: string; startTime?: number }[] | undefined;
      if (t) timed.push(...t);
    }
    expect(gradio.calls.map((c) => c.text)).toEqual(['好呀，', '今天过得怎么样？', '我有点累。']);
    // [喜] applies to its sentence (both segments before the 。/？), [哀] to the last one.
    expect(gradio.calls.map((c) => [c.vec1, c.vec3])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(gradio.maxConcurrent).toBe(1);
    expect(timed.map((t) => t.text)).toEqual(['好呀，', '今天过得怎么样？', '我有点累。']);
    // Each transcript starts where the previous segment's audio ended (fake: 100 ms per char).
    expect(timed.map((t) => Math.round((t.startTime ?? 0) * 10) / 10)).toEqual([0, 0.3, 1.1]);
    expect(samples).toBeGreaterThan(0);
  });
});

describe('IndexTTS cancellation', () => {
  it('drops the audio of a synthesis cancelled mid-request and reports no error', async () => {
    const { gradio, plugin, errors } = await setup({ synthMs: 300 });
    const abort = new AbortController();
    const stream = plugin.synthesize('这句话会被打断。', undefined, abort.signal);
    const result = collect(stream);
    await sleep(100);
    expect(gradio.calls).toHaveLength(1);
    abort.abort();
    expect((await result).samples).toBe(0);
    await sleep(300);
    expect(errors).toEqual([]);
  });

  it('a request cancelled while queued never reaches the backend', async () => {
    const { gradio, plugin } = await setup({ synthMs: 200 });
    const first = collect(plugin.synthesize('第一句。'));
    const abort = new AbortController();
    const second = collect(plugin.synthesize('第二句。', undefined, abort.signal));
    await sleep(50);
    abort.abort();
    expect((await second).samples).toBe(0);
    expect((await first).samples).toBeGreaterThan(0);
    const third = await collect(plugin.synthesize('第三句。'));
    expect(third.samples).toBeGreaterThan(0);
    expect(gradio.calls.map((c) => c.text)).toEqual(['第一句。', '第三句。']);
  });
});

describe('IndexTTS failures', () => {
  const synth = async (fake: FakeGradioOptions, backend: Partial<IndexTtsGradioOptions> = {}) => {
    const { backend: be } = await setup(fake, backend);
    return be.synthesize({ text: '你好。', emotion: '平静' }, new AbortController().signal).then(
      () => undefined,
      (e: unknown) => e,
    );
  };

  it('an SSE error event is a `service` TtsError, and the next call re-uploads the reference', async () => {
    let n = 0;
    const { gradio, backend } = await setup({ fail: () => (n++ === 0 ? 'error' : undefined) });
    const signal = new AbortController().signal;
    const error = await backend.synthesize({ text: '一。', emotion: '平静' }, signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TtsError);
    expect((error as TtsError).kind).toBe('service');
    await backend.synthesize({ text: '二。', emotion: '平静' }, signal);
    expect(gradio.uploads).toBe(2);
  });

  it('an HTTP error is a `service` TtsError with the status', async () => {
    const error = (await synth({ fail: () => 'http500' })) as TtsError;
    expect(error).toBeInstanceOf(TtsError);
    expect(error.kind).toBe('service');
    expect(error.status).toBe(500);
  });

  it('a non-wav result is `bad_response`', async () => {
    const error = (await synth({ fail: () => 'garbage' })) as TtsError;
    expect(error.kind).toBe('bad_response');
  });

  it('no answer within the timeout is `timeout`', async () => {
    const error = (await synth({ synthMs: 500 }, { timeoutMs: 100 })) as TtsError;
    expect(error.kind).toBe('timeout');
  });

  it('a closed port is `unreachable`', async () => {
    const be = new IndexTtsGradioBackend({
      url: 'http://127.0.0.1:9',
      refAudioPath: refPath,
      language: 'ZH',
      emotionControl: 'reference',
      timeoutMs: 1000,
    });
    const error = (await be.synthesize({ text: '你好。', emotion: '平静' }, new AbortController().signal).catch(
      (e: unknown) => e,
    )) as TtsError;
    expect(error).toBeInstanceOf(TtsError);
    expect(error.kind).toBe('unreachable');
  });

  it('the plugin surfaces backend failures as a non-retried tts_error', async () => {
    const { gradio, plugin, errors } = await setup({ fail: () => 'error' });
    expect((await collect(plugin.synthesize('你好。'))).samples).toBe(0);
    expect(gradio.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe('tts_error');
    expect(errors[0]!.error).toBeInstanceOf(TtsError);
  });
});

describe('wav decoding', () => {
  it('reads 16-bit PCM and 32-bit float', () => {
    const pcm = decodeWav(encodeWav({ samples: Int16Array.from([0, 1000, -1000]), sampleRate: 22050, channels: 1 }));
    expect(pcm).toEqual({ samples: Int16Array.from([0, 1000, -1000]), sampleRate: 22050, channels: 1 });

    const float = new Uint8Array(44 + 8);
    float.set(encodeWav({ samples: new Int16Array(4), sampleRate: 16000, channels: 1 }).subarray(0, 44));
    const view = new DataView(float.buffer);
    view.setUint16(20, 3, true);
    view.setUint16(34, 32, true);
    view.setFloat32(44, 0.5, true);
    view.setFloat32(48, -1, true);
    expect(Array.from(decodeWav(float).samples)).toEqual([16384, -32767]);
  });

  it('rejects non-wav input', () => {
    expect(() => decodeWav(new TextEncoder().encode('hello world!'))).toThrow();
  });
});

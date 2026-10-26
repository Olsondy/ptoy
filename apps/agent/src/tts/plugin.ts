import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, log, shortuuid, tts } from '@livekit/agents';
import { AudioFrame, AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';
import { DEFAULT_EMOTION, type SegmenterOptions } from '@ptoy/segmenter';
import type { PcmAudio, TtsBackend, TtsSegment } from './backend.js';
import { SegmentedSynthesizeStream } from './segment-stream.js';

export interface IndexTTSOptions {
  readonly backend: TtsBackend;
  /** Output sample rate (the agent's audio track rate); backend audio is resampled to it. */
  readonly sampleRate: number;
  /** Segmentation of `stream()` input; defaults to the `@ptoy/segmenter` defaults (short first segment). */
  readonly segmenter?: SegmenterOptions;
  /** Gets each `stream()` reply's first `<bg:…>` level (ADR 0013), before its audio is synthesized. */
  readonly onAmbience?: (level: string) => void;
}

/** Interleaved s16 → mono by averaging channels. */
function toMono(audio: PcmAudio): Int16Array {
  if (audio.channels === 1) return audio.samples;
  const n = Math.floor(audio.samples.length / audio.channels);
  const mono = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < audio.channels; c++) sum += audio.samples[i * audio.channels + c] ?? 0;
    mono[i] = Math.round(sum / audio.channels);
  }
  return mono;
}

const FRAME_MS = 20;

/** Mono s16 at `sampleRate`, cut into 20 ms frames (resampled if the backend's rate differs). */
export function toFrames(audio: PcmAudio, sampleRate: number): AudioFrame[] {
  const mono = toMono(audio);
  let pcm = mono;
  if (audio.sampleRate !== sampleRate && mono.length > 0) {
    const resampler = new AudioResampler(audio.sampleRate, sampleRate, 1, AudioResamplerQuality.HIGH);
    try {
      const out = [...resampler.push(new AudioFrame(mono, audio.sampleRate, 1, mono.length)), ...resampler.flush()];
      const total = out.reduce((n, f) => n + f.samplesPerChannel, 0);
      pcm = new Int16Array(total);
      let offset = 0;
      for (const f of out) {
        pcm.set(f.data.subarray(0, f.samplesPerChannel), offset);
        offset += f.samplesPerChannel;
      }
    } finally {
      resampler.close();
    }
  }
  const step = (sampleRate * FRAME_MS) / 1000;
  const frames: AudioFrame[] = [];
  for (let i = 0; i < pcm.length; i += step) {
    const chunk = pcm.slice(i, Math.min(i + step, pcm.length));
    frames.push(new AudioFrame(chunk, sampleRate, 1, chunk.length));
  }
  return frames;
}

/**
 * LiveKit TTS plugin for IndexTTS2: "text + emotion → audio" over a swappable {@link TtsBackend}.
 *
 * - `synthesize(text)` speaks with the default emotion; `synthesizeSegment({ text, emotion })`
 *   is the emotion-aware entry point.
 * - `stream()` runs the LLM text through `@ptoy/segmenter` ({@link SegmentedSynthesizeStream}):
 *   short first segment, `[情绪]` tags parsed and removed, one `synthesizeSegment` per segment
 *   with segment-level timed transcripts, which drive the subtitle sync.
 * - Requests are serialized (the GPU is shared with the LLM): the stream asks for the next
 *   segment while the previous one is still synthesizing, but the backend sees one at a time.
 * - Cancellation (interruption, session close) aborts the backend request and drops its audio.
 */
export class IndexTTS extends tts.TTS {
  label = 'ptoy.IndexTTS';
  readonly #backend: TtsBackend;
  readonly #segmenter: SegmenterOptions | undefined;
  readonly #onAmbience: ((level: string) => void) | undefined;
  readonly #logger = log().child({ tts: 'indextts' });
  /** Tail of the serialization chain. */
  #lock: Promise<void> = Promise.resolve();

  constructor(opts: IndexTTSOptions) {
    super(opts.sampleRate, 1, { streaming: true, alignedTranscript: true });
    this.#backend = opts.backend;
    this.#segmenter = opts.segmenter;
    this.#onAmbience = opts.onAmbience;
  }

  override get model(): string {
    return 'IndexTTS2';
  }

  override get provider(): string {
    return this.#backend.name;
  }

  get backend(): TtsBackend {
    return this.#backend;
  }

  override prewarm(): void {
    void this.#backend.prewarm?.();
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return this.synthesizeSegment({ text, emotion: DEFAULT_EMOTION }, connOptions, abortSignal);
  }

  synthesizeSegment(segment: TtsSegment, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): IndexTTSChunkedStream {
    // Never retry: a retry re-occupies the shared GPU and arrives too late to be useful.
    const opts = { ...DEFAULT_API_CONNECT_OPTIONS, ...connOptions, maxRetry: 0 };
    return new IndexTTSChunkedStream(this, segment, opts, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SegmentedSynthesizeStream(this, this.#segmenter, options?.connOptions, this.#onAmbience);
  }

  /**
   * Runs `fn` once all earlier requests finished. Returns `undefined` without running it if
   * `signal` aborted while waiting.
   * @internal
   */
  async _exclusive<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T | undefined> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([previous, aborted]);
    if (signal.aborted) {
      // Keep the chain ordered: release our slot only once the previous holder is done.
      void previous.then(release);
      return undefined;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** @internal */
  get _logger() {
    return this.#logger;
  }
}

export class IndexTTSChunkedStream extends tts.ChunkedStream {
  label = 'ptoy.IndexTTSChunkedStream';
  readonly #tts: IndexTTS;
  readonly #segment: TtsSegment;

  constructor(tts: IndexTTS, segment: TtsSegment, connOptions: APIConnectOptions, abortSignal?: AbortSignal) {
    super(segment.text, tts, connOptions, abortSignal);
    this.#tts = tts;
    this.#segment = segment;
  }

  protected async run(): Promise<void> {
    const signal = this.abortSignal;
    const queuedAt = performance.now();
    let startedAt = queuedAt;
    try {
      const audio = await this.#tts._exclusive(signal, () => {
        startedAt = performance.now();
        return this.#tts.backend.synthesize(this.#segment, signal);
      });
      // Cancelled while queued or synthesizing: drop the result.
      if (!audio || signal.aborted) return;
      const frames = toFrames(audio, this.#tts.sampleRate);
      this.#tts._logger.debug(
        {
          text: this.#segment.text,
          emotion: this.#segment.emotion,
          waitMs: Math.round(startedAt - queuedAt),
          synthMs: Math.round(performance.now() - startedAt),
          audioMs: Math.round((audio.samples.length / audio.channels / audio.sampleRate) * 1000),
        },
        'tts segment synthesized',
      );
      const requestId = shortuuid();
      frames.forEach((frame, i) => {
        this.queue.put({ requestId, segmentId: requestId, frame, final: i === frames.length - 1 });
      });
    } catch (error) {
      if (signal.aborted) return;
      this.#tts._logger.error(
        { err: (error as Error).message, kind: (error as { kind?: string }).kind, text: this.#segment.text },
        'tts synthesis failed',
      );
      throw error;
    } finally {
      this.queue.close();
    }
  }
}

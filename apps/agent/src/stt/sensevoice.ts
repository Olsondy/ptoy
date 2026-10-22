import { APIError, type AudioBuffer, log, mergeFrames, stt } from '@livekit/agents';
import { AudioFrame, AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';

/** The ASR service only accepts 16 kHz mono s16le (services/asr/README.md). */
export const ASR_SAMPLE_RATE = 16000;

/** SenseVoice emotion classes as returned by the ASR service. */
export type AsrEmotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'unknown';

/** SenseVoice audio events as returned by the ASR service. */
export type AsrEvent = 'speech' | 'bgm' | 'applause' | 'laughter' | 'cry' | 'sneeze' | 'breath' | 'cough';

const EMOTIONS: ReadonlySet<string> = new Set<AsrEmotion>([
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'unknown',
]);
const EVENTS: ReadonlySet<string> = new Set<AsrEvent>([
  'speech',
  'bgm',
  'applause',
  'laughter',
  'cry',
  'sneeze',
  'breath',
  'cough',
]);

/**
 * Non-text part of one recognized utterance. Attached to every FINAL_TRANSCRIPT as
 * `alternatives[0].metadata` (read it with {@link asrMetadataOf}) and passed to `onTranscript`.
 */
export interface AsrMetadata {
  readonly emotion: AsrEmotion;
  readonly events: readonly AsrEvent[];
  /** Server-side inference time reported by the ASR service. */
  readonly inferenceMs: number;
  /** Duration of the utterance audio sent to the service. */
  readonly audioMs: number;
}

export interface AsrTranscript extends AsrMetadata {
  readonly text: string;
}

/**
 * Why a recognition failed:
 * - `timeout`: no response within `timeoutMs`
 * - `unreachable`: connection refused / DNS / socket error
 * - `service`: the service answered with an error status (`status`, `code` from its `{ error }` body)
 * - `bad_response`: 200 but the body is not the documented `{ text, emotion, events, duration_ms }`
 */
export type AsrErrorKind = 'timeout' | 'unreachable' | 'service' | 'bad_response';

/** Thrown by {@link SenseVoiceSTT.recognize}; an `APIError`, so the framework treats it as a provider error. */
export class AsrError extends APIError {
  readonly kind: AsrErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(kind: AsrErrorKind, message: string, opts: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { retryable: kind === 'timeout' || kind === 'unreachable', body: opts.code ?? null });
    this.name = 'AsrError';
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export interface SenseVoiceSTTOptions {
  /** Base URL of the ASR service, e.g. `http://localhost:8100`. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /**
   * Language reported on transcripts. The service strips SenseVoice's language tag, so this is a
   * fixed hint; the end-of-turn model uses it to pick its per-language threshold.
   */
  readonly language?: string;
  /** Called for every non-empty recognized utterance (text + emotion + events). */
  readonly onTranscript?: (transcript: AsrTranscript) => void;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const METADATA_KEY = 'ptoy.asr';

/** Reads the emotion/events the plugin attached to a FINAL_TRANSCRIPT event (or its `SpeechData`). */
export function asrMetadataOf(source: stt.SpeechEvent | stt.SpeechData | undefined): AsrMetadata | undefined {
  const data = source && 'type' in source ? source.alternatives?.[0] : source;
  const value = data?.metadata?.[METADATA_KEY];
  return value && typeof value === 'object' ? (value as AsrMetadata) : undefined;
}

/** Interleaved s16 -> mono by averaging channels. */
function downmix(frame: AudioFrame): AudioFrame {
  if (frame.channels === 1) return frame;
  const mono = new Int16Array(frame.samplesPerChannel);
  for (let i = 0; i < frame.samplesPerChannel; i++) {
    let sum = 0;
    for (let c = 0; c < frame.channels; c++) sum += frame.data[i * frame.channels + c] ?? 0;
    mono[i] = Math.round(sum / frame.channels);
  }
  return new AudioFrame(mono, frame.sampleRate, 1, frame.samplesPerChannel);
}

/** Converts one utterance to the 16 kHz mono s16le the ASR service expects. */
export function toAsrPcm(buffer: AudioBuffer): Int16Array {
  const mono = downmix(mergeFrames(buffer));
  if (mono.sampleRate === ASR_SAMPLE_RATE) return mono.data;
  const resampler = new AudioResampler(mono.sampleRate, ASR_SAMPLE_RATE, 1, AudioResamplerQuality.HIGH);
  try {
    const out = [...resampler.push(mono), ...resampler.flush()];
    return out.length === 0 ? new Int16Array(0) : mergeFrames(out).data;
  } finally {
    resampler.close();
  }
}

function parseResult(body: unknown): { text: string; emotion: AsrEmotion; events: AsrEvent[]; durationMs: number } {
  if (!body || typeof body !== 'object') throw new AsrError('bad_response', 'ASR response is not a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string') throw new AsrError('bad_response', 'ASR response has no string `text`');
  const emotion = typeof b.emotion === 'string' && EMOTIONS.has(b.emotion) ? (b.emotion as AsrEmotion) : 'unknown';
  const events = Array.isArray(b.events)
    ? b.events.filter((e): e is AsrEvent => typeof e === 'string' && EVENTS.has(e))
    : [];
  const durationMs = typeof b.duration_ms === 'number' ? b.duration_ms : 0;
  return { text: b.text.trim(), emotion, events, durationMs };
}

async function readErrorBody(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    return {
      code: typeof body.error === 'string' ? body.error : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Non-streaming STT backed by the SenseVoice ASR service (`POST /asr`).
 *
 * It recognizes one whole utterance per call, so `AgentSession` wraps it in `stt.StreamAdapter`
 * with the session's VAD: the VAD cuts utterances, each one becomes one FINAL_TRANSCRIPT.
 * Failures throw {@link AsrError} and are also emitted as a recoverable `stt_error`
 * (`AgentSession` `error` event), because the stream adapter only logs recognition failures.
 */
export class SenseVoiceSTT extends stt.STT {
  label = 'ptoy.SenseVoiceSTT';
  readonly #opts: SenseVoiceSTTOptions;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #logger = log().child({ stt: 'sensevoice' });

  constructor(opts: SenseVoiceSTTOptions) {
    super({ streaming: false, interimResults: false });
    this.#opts = opts;
    this.#endpoint = new URL('/asr', opts.baseUrl).toString();
    this.#fetch = opts.fetch ?? fetch;
  }

  override get model(): string {
    return 'SenseVoiceSmall';
  }

  override get provider(): string {
    return 'ptoy-asr';
  }

  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const pcm = toAsrPcm(buffer);
    const audioMs = Math.round((pcm.length / ASR_SAMPLE_RATE) * 1000);
    try {
      const { text, emotion, events, durationMs } = await this.#post(pcm, abortSignal);
      const metadata: AsrMetadata = { emotion, events, inferenceMs: durationMs, audioMs };
      this.#logger.debug({ text, emotion, events, inferenceMs: durationMs, audioMs }, 'asr result');
      if (text) this.#opts.onTranscript?.({ text, ...metadata });
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text,
            language: (this.#opts.language ?? 'zh') as stt.SpeechData['language'],
            startTime: 0,
            endTime: audioMs / 1000,
            confidence: text ? 1 : 0,
            metadata: { [METADATA_KEY]: metadata },
          },
        ],
      };
    } catch (error) {
      const asrError =
        error instanceof AsrError ? error : new AsrError('unreachable', 'ASR request failed', { cause: error });
      this.#logger.error(
        { kind: asrError.kind, status: asrError.status, code: asrError.code, audioMs, err: asrError.message },
        'asr recognition failed',
      );
      this.emit('error', {
        type: 'stt_error',
        timestamp: Date.now(),
        label: this.label,
        error: asrError,
        recoverable: true,
      });
      throw asrError;
    }
  }

  async #post(pcm: Int16Array, abortSignal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'Content-Type': `audio/pcm;rate=${ASR_SAMPLE_RATE};channels=1` },
        body: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        signal,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new AsrError('timeout', `ASR did not respond within ${this.#opts.timeoutMs}ms`, { cause: error });
      }
      throw new AsrError('unreachable', `ASR service unreachable at ${this.#endpoint}`, { cause: error });
    }
    if (!res.ok) {
      const { code, message } = await readErrorBody(res);
      throw new AsrError('service', `ASR service responded ${res.status}${message ? `: ${message}` : ''}`, {
        status: res.status,
        code,
      });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      if (timeout.aborted) {
        throw new AsrError('timeout', `ASR did not respond within ${this.#opts.timeoutMs}ms`, { cause: error });
      }
      throw new AsrError('bad_response', 'ASR response is not valid JSON', { cause: error });
    }
    return parseResult(body);
  }

  stream(): stt.SpeechStream {
    throw new Error('SenseVoiceSTT is non-streaming; pass a VAD so AgentSession wraps it in stt.StreamAdapter');
  }
}

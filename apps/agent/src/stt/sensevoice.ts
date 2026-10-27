import { APIError, type AudioBuffer, log, mergeFrames, stt } from '@livekit/agents';
import { AudioFrame, AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';

/** Audio is sent as a 16 kHz mono 16-bit WAV, SenseVoice's native rate. */
export const ASR_SAMPLE_RATE = 16000;

/** OpenAI-compatible transcription endpoint, relative to `ASR_BASE_URL`. */
const TRANSCRIPTIONS_PATH = 'audio/transcriptions';

/** SenseVoice emotion classes, from the `<|EMOTION|>` tag in the service's `raw_text`. */
export type AsrEmotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'unknown';

/** SenseVoice audio events, from the `<|Event|>` tag in the service's `raw_text`. */
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
 * - `service`: the service answered with an error status (`status`, `code` from an `{ error }` body if any)
 * - `bad_response`: 200 but the body has no string `text`
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
  /** API base of the ASR service, e.g. `http://127.0.0.1:8001/v1` (the plugin appends `/audio/transcriptions`). */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /**
   * Spoken language, sent to the service (`auto` lets SenseVoice detect it, which can mistake
   * short Chinese utterances for Korean or Japanese) and reported on transcripts; the
   * end-of-turn model uses it to pick its per-language threshold.
   */
  readonly language?: string;
  /** Bearer token for a hosted OpenAI-compatible ASR (OpenRouter); SenseVoice needs none. */
  readonly apiKey?: string;
  /** `model` form field for a hosted ASR, e.g. `qwen/qwen3-asr-1.7b`; SenseVoice needs none. */
  readonly model?: string;
  /** Called for every non-empty recognized utterance (text + emotion + events). */
  readonly onTranscript?: (transcript: AsrTranscript) => void;
  /**
   * Recognized text for which this returns true is reported as empty (no transcript, no turn),
   * e.g. a "嗯" while the agent is talking. Asked when the result arrives.
   */
  readonly ignore?: (text: string) => boolean;
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

/** Converts one utterance to 16 kHz mono s16le. */
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

/** Wraps 16 kHz mono s16le PCM in a WAV container. */
export function toWav(pcm: Int16Array): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.byteLength;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(ASR_SAMPLE_RATE, 24);
  header.writeUInt32LE(ASR_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}

const TAG = /<\|([^|>]*)\|>/g;

/** Reads emotion and events from SenseVoice's raw tags, e.g. `<|zh|><|NEUTRAL|><|Speech|><|withitn|>…`. */
function parseTags(raw: string): { emotion: AsrEmotion; events: AsrEvent[] } {
  let emotion: AsrEmotion = 'unknown';
  const events: AsrEvent[] = [];
  for (const [, tag = ''] of raw.matchAll(TAG)) {
    const name = tag.toLowerCase();
    if (emotion === 'unknown' && EMOTIONS.has(name)) emotion = name as AsrEmotion;
    else if (EVENTS.has(name) && !events.includes(name as AsrEvent)) events.push(name as AsrEvent);
  }
  return { emotion, events };
}

/** Bracketed delivery cue a hosted ASR keeps inline in `text`, e.g. Fish Audio's `[高兴]` or `[laughter]`. */
const CUE = /\[([^[\]]{1,24})\]/g;

/** Cue keywords → emotion, checked in order (cues are free-form, Chinese or English). */
const CUE_EMOTIONS: readonly (readonly [RegExp, AsrEmotion])[] = [
  [/惊喜|惊讶|吃惊|震惊|surpris|amaz|astonish|shock/i, 'surprised'],
  [/高兴|开心|快乐|兴奋|喜悦|愉快|欢快|happy|joy|excit|cheer|delight/i, 'happy'],
  [/难过|伤心|悲伤|委屈|沮丧|失落|低落|sad|upset|sorrow|depress|disappoint/i, 'sad'],
  [/生气|愤怒|恼火|不耐烦|烦躁|angry|anger|annoy|frustrat|irritat|furious/i, 'angry'],
  [/害怕|恐惧|紧张|担心|焦虑|fear|afraid|scared|nervous|anxious|worr/i, 'fearful'],
  [/厌恶|恶心|嫌弃|disgust/i, 'disgusted'],
  [/平静|中性|neutral|calm/i, 'neutral'],
];

/** Cue keywords → audio event. */
const CUE_EVENTS: readonly (readonly [RegExp, AsrEvent])[] = [
  [/笑|laugh|giggl|chuckl/i, 'laughter'],
  [/哭|啜泣|抽泣|cry|sob/i, 'cry'],
  [/咳|cough/i, 'cough'],
  [/喷嚏|sneez/i, 'sneeze'],
  [/呼吸|喘|叹气|breath|sigh|gasp/i, 'breath'],
  [/鼓掌|掌声|applau|clap/i, 'applause'],
  [/音乐|music|bgm/i, 'bgm'],
];

/**
 * Reads emotion and events from bracketed cues (first emotion cue wins, like SenseVoice's single tag).
 * Unrecognized cues are dropped.
 */
function parseCues(text: string): { emotion: AsrEmotion; events: AsrEvent[] } {
  let emotion: AsrEmotion = 'unknown';
  const events: AsrEvent[] = [];
  for (const [, cue = ''] of text.matchAll(CUE)) {
    const cueEmotion = CUE_EMOTIONS.find(([pattern]) => pattern.test(cue))?.[1];
    if (cueEmotion !== undefined) {
      if (emotion === 'unknown') emotion = cueEmotion;
      continue;
    }
    const event = CUE_EVENTS.find(([pattern]) => pattern.test(cue))?.[1];
    if (event !== undefined && !events.includes(event)) events.push(event);
  }
  return { emotion, events };
}

function parseResult(body: unknown): { text: string; emotion: AsrEmotion; events: AsrEvent[]; durationMs: number } {
  if (!body || typeof body !== 'object') throw new AsrError('bad_response', 'ASR response is not a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string') throw new AsrError('bad_response', 'ASR response has no string `text`');
  const raw = Array.isArray(b.raw_text) ? b.raw_text.filter((r) => typeof r === 'string').join('') : b.raw_text;
  // SenseVoice tags its `raw_text`; a hosted ASR without one may put cues in `text` (Fish Audio transcribe-1-pro).
  const { emotion, events } = typeof raw === 'string' ? parseTags(raw) : parseCues(b.text);
  const durationMs = typeof b.elapsed_seconds === 'number' ? Math.round(b.elapsed_seconds * 1000) : 0;
  return { text: b.text.replace(TAG, '').replace(CUE, '').trim(), emotion, events, durationMs };
}

async function readErrorBody(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; detail?: unknown };
    const detail = typeof body.detail === 'string' ? body.detail : undefined;
    return {
      code: typeof body.error === 'string' ? body.error : undefined,
      message: typeof body.message === 'string' ? body.message : detail,
    };
  } catch {
    return {};
  }
}

/**
 * Non-streaming STT backed by a SenseVoice ASR service with an OpenAI-compatible
 * `POST /v1/audio/transcriptions` (multipart `file`, `response_format=json` → `{ text, raw_text, elapsed_seconds }`).
 * With `apiKey` + `model` the same request goes to a hosted endpoint (OpenRouter, `ASR_BASE_URL=https://openrouter.ai/api/v1`),
 * which answers `{ text }` and no inference time. Emotion/events then come from bracketed cues in `text`
 * (`fish-audio/transcribe-1-pro`: `<|speaker:0|>[高兴]…`); models without cues give emotion `unknown`.
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
    this.#endpoint = new URL(TRANSCRIPTIONS_PATH, opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`).toString();
    this.#fetch = opts.fetch ?? fetch;
  }

  override get model(): string {
    return this.#opts.model ?? 'SenseVoiceSmall';
  }

  override get provider(): string {
    return 'ptoy-asr';
  }

  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const pcm = toAsrPcm(buffer);
    const audioMs = Math.round((pcm.length / ASR_SAMPLE_RATE) * 1000);
    try {
      const result = await this.#post(pcm, abortSignal);
      const { emotion, events, durationMs } = result;
      const ignored = result.text !== '' && this.#opts.ignore?.(result.text) === true;
      const text = ignored ? '' : result.text;
      const metadata: AsrMetadata = { emotion, events, inferenceMs: durationMs, audioMs };
      this.#logger.debug({ text: result.text, ignored, emotion, events, inferenceMs: durationMs, audioMs }, 'asr result');
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
      const form = new FormData();
      form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'utterance.wav');
      form.append('response_format', 'json');
      form.append('language', this.#opts.language ?? 'zh');
      if (this.#opts.model !== undefined) form.append('model', this.#opts.model);
      const headers = this.#opts.apiKey === undefined ? undefined : { Authorization: `Bearer ${this.#opts.apiKey}` };
      res = await this.#fetch(this.#endpoint, { method: 'POST', body: form, headers, signal });
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

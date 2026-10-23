import { APIError } from '@livekit/agents';
import type { Emotion } from '@ptoy/segmenter';

/** One synthesizable segment: clean text (no tags) + the emotion to speak it with. */
export interface TtsSegment {
  readonly text: string;
  readonly emotion: Emotion;
}

/** Decoded PCM, interleaved s16 at the backend's native rate. */
export interface PcmAudio {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * The seam between the TTS plugin and a concrete IndexTTS deployment.
 *
 * A backend turns one segment into one whole clip (IndexTTS is not streaming). Implementations:
 * `IndexTtsGradioBackend` (WebUI `/gen_single`, stage 1); #14 adds a FastAPI backend.
 * Choosing one is a config change (`TTS_BACKEND`), see `createTtsBackend`.
 *
 * Contract:
 * - Requests arrive one at a time (the plugin serializes them; the GPU is shared).
 * - `signal` aborts the request; a backend should stop waiting and reject (any error is fine,
 *   the plugin drops results of cancelled requests). Backends that can cancel server-side should.
 * - Failures reject with {@link TtsError}.
 */
export interface TtsBackend {
  /** Short name for logs/metrics, e.g. `indextts-gradio`. */
  readonly name: string;
  synthesize(segment: TtsSegment, signal: AbortSignal): Promise<PcmAudio>;
  /** Optional warm-up (e.g. upload the reference audio). Must not throw. */
  prewarm?(): Promise<void>;
}

/**
 * Why a synthesis failed:
 * - `timeout`: no audio within the configured timeout
 * - `unreachable`: connection refused / DNS / socket error
 * - `service`: the backend answered with an error (HTTP status or an error event)
 * - `bad_response`: the answer is not decodable audio
 * - `config`: local misconfiguration (e.g. unreadable reference audio)
 */
export type TtsErrorKind = 'timeout' | 'unreachable' | 'service' | 'bad_response' | 'config';

/** An `APIError`, so the framework reports it as a `tts_error`. Never retried: a retry would re-occupy the GPU. */
export class TtsError extends APIError {
  readonly kind: TtsErrorKind;
  readonly status: number | undefined;

  constructor(kind: TtsErrorKind, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { retryable: false });
    this.name = 'TtsError';
    this.kind = kind;
    this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

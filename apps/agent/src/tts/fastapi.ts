import { log } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { type PcmAudio, type TtsBackend, TtsError, type TtsSegment } from './backend.js';

export interface IndexTtsFastApiOptions {
  /** Service base URL, e.g. `http://192.168.31.82:8002`. */
  readonly url: string;
  /** `reference`: emotion follows the server's speaker reference; `vector`: the segment emotion is sent. */
  readonly emotionControl: 'reference' | 'vector';
  /** Emotion strength sent as `emo_alpha` with a non-calm emotion; omitted → the service default. */
  readonly emotionWeight?: number;
  /** Whole-request timeout (queue + synthesis + download). */
  readonly timeoutMs: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** How long a fire-and-forget `/cancel` may take. */
const CANCEL_TIMEOUT_MS = 2000;

/**
 * IndexTTS FastAPI backend (`services/tts`): `POST /tts` → raw s16le PCM, rate in `X-Sample-Rate`.
 *
 * Every request carries a `request_id`. When the caller aborts (interruption) or the request
 * times out, the backend calls `POST /cancel/{id}` so the server drops the queued job or stops
 * and discards the running one, instead of occupying the GPU with audio nobody will hear.
 * The speaker reference, language and model settings are configured on the server.
 */
export class IndexTtsFastApiBackend implements TtsBackend {
  readonly name = 'indextts-fastapi';
  readonly #opts: IndexTtsFastApiOptions;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #logger = log().child({ tts: 'indextts-fastapi' });

  constructor(opts: IndexTtsFastApiOptions) {
    this.#opts = opts;
    this.#base = opts.url.replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? fetch;
  }

  async prewarm(): Promise<void> {
    try {
      const res = await this.#fetch(`${this.#base}/health`, { signal: AbortSignal.timeout(this.#opts.timeoutMs) });
      const body = (await res.json()) as Record<string, unknown>;
      this.#logger.info(
        { model: body.model, sampleRate: body.sample_rate, outputMode: body.output_mode, diffusion: body.diffusion },
        'tts service ready',
      );
    } catch (error) {
      this.#logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'tts prewarm failed');
    }
  }

  async synthesize(segment: TtsSegment, signal: AbortSignal): Promise<PcmAudio> {
    const requestId = randomUUID();
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const body: Record<string, unknown> = { text: segment.text, request_id: requestId };
    if (this.#opts.emotionControl === 'vector') {
      body.emotion = segment.emotion;
      if (this.#opts.emotionWeight !== undefined) body.emo_alpha = this.#opts.emotionWeight;
    }
    try {
      const res = await this.#fetch(`${this.#base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new TtsError('service', `IndexTTS responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, {
          status: res.status,
        });
      }
      const sampleRate = Number(res.headers.get('x-sample-rate'));
      const channels = Number(res.headers.get('x-channels') ?? '1');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1) {
        throw new TtsError('bad_response', 'IndexTTS response has no valid X-Sample-Rate / X-Channels');
      }
      if (bytes.byteLength % (2 * channels) !== 0) {
        throw new TtsError('bad_response', `IndexTTS returned ${bytes.byteLength} bytes, not whole s16 frames`);
      }
      return { samples: decodeS16le(bytes), sampleRate, channels };
    } catch (error) {
      if (combined.aborted) this.#cancel(requestId);
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof TtsError) throw error;
      if (timeout.aborted) {
        throw new TtsError('timeout', `IndexTTS did not answer within ${this.#opts.timeoutMs}ms`, { cause: error });
      }
      throw new TtsError('unreachable', `IndexTTS unreachable at ${this.#base}`, { cause: error });
    }
  }

  /** Fire-and-forget: frees the GPU from a request nobody waits for. */
  #cancel(requestId: string): void {
    this.#fetch(`${this.#base}/cancel/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    })
      .then(async (res) => {
        const state = res.ok ? ((await res.json()) as { state?: string }).state : `http ${res.status}`;
        this.#logger.debug({ requestId, state }, 'tts request cancelled');
      })
      .catch((error: unknown) => {
        this.#logger.warn({ requestId, err: error instanceof Error ? error.message : String(error) }, 'tts cancel failed');
      });
  }
}

function decodeS16le(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

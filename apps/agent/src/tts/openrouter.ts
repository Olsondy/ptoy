import type { Emotion } from '@ptoy/segmenter';
import { MIMEType } from 'node:util';
import { type PcmAudio, type TtsBackend, TtsError, type TtsSegment } from './backend.js';

export interface OpenRouterTtsOptions {
  /** API base URL, e.g. `https://openrouter.ai/api/v1` (the backend appends `/audio/speech`). */
  readonly url: string;
  readonly apiKey: string;
  /** Speech model, e.g. `fish-audio/s2.1-pro`. */
  readonly model: string;
  /** Provider voice id (a Fish voice model id); omitted → the model's default voice. */
  readonly voice?: string;
  /** Character delivery hint (`tts_style`) put before every sentence, ahead of the emotion hint. */
  readonly style?: string;
  /** `reference`: text only; `vector`: non-calm segments get a Fish `[情绪]` style prefix. */
  readonly emotionControl: 'reference' | 'vector';
  /** Whole-request timeout (queue + synthesis + download). */
  readonly timeoutMs: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Fish speaks bracketed natural-language style hints placed before the text. 平静 gets none:
 * the voice's own delivery is the calm one.
 */
export const FISH_EMOTION_HINTS: Readonly<Record<Emotion, string | undefined>> = {
  喜: '开心',
  怒: '生气',
  哀: '难过',
  惧: '害怕',
  厌恶: '嫌弃',
  低落: '低落',
  惊喜: '惊喜',
  平静: undefined,
};

/**
 * OpenRouter speech backend: `POST {url}/audio/speech` → signed 16-bit little-endian PCM.
 *
 * The cloud replaces IndexTTS on the local GPU. An abort only drops the HTTP request; the
 * provider has no cancel endpoint. The voice is a provider voice id, mapped from the
 * character's `voice:` by `TTS_OPENROUTER_VOICES` (see `createTtsBackend`).
 */
export class OpenRouterTtsBackend implements TtsBackend {
  readonly name = 'openrouter';
  readonly #opts: OpenRouterTtsOptions;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenRouterTtsOptions) {
    this.#opts = opts;
    this.#endpoint = `${opts.url.replace(/\/+$/, '')}/audio/speech`;
    this.#fetch = opts.fetch ?? fetch;
  }

  async synthesize(segment: TtsSegment, signal: AbortSignal): Promise<PcmAudio> {
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const emotion = this.#opts.emotionControl === 'vector' ? FISH_EMOTION_HINTS[segment.emotion] : undefined;
    const hint = [this.#opts.style, emotion].filter(Boolean).join('，');
    const body: Record<string, unknown> = {
      model: this.#opts.model,
      input: hint ? `[${hint}] ${segment.text}` : segment.text,
      response_format: 'pcm',
    };
    if (this.#opts.voice !== undefined) body.voice = this.#opts.voice;
    try {
      const res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new TtsError('service', `OpenRouter TTS responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, {
          status: res.status,
        });
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      try {
        // OpenRouter includes the model's native rate/channels in Content-Type. Fish
        // returns 44100 Hz; assuming 24000 Hz would change the voice pitch and speed.
        const type = new MIMEType(res.headers.get('content-type') ?? '');
        const sampleRate = Number(type.params.get('rate'));
        const channels = Number(type.params.get('channels'));
        if (type.essence !== 'audio/pcm' || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
          || !Number.isInteger(channels) || channels < 1 || channels > 8
          || bytes.length === 0 || bytes.length % (2 * channels) !== 0) {
          throw new Error('Invalid PCM format, metadata or frame length');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const samples = new Int16Array(bytes.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
        return { samples, sampleRate, channels };
      } catch (error) {
        throw new TtsError('bad_response', `OpenRouter TTS returned undecodable audio (${res.headers.get('content-type')})`, {
          cause: error,
        });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof TtsError) throw error;
      if (timeout.aborted) {
        throw new TtsError('timeout', `OpenRouter TTS did not answer within ${this.#opts.timeoutMs}ms`, { cause: error });
      }
      throw new TtsError('unreachable', `OpenRouter TTS unreachable at ${this.#endpoint}`, { cause: error });
    }
  }
}

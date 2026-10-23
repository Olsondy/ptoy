import { log } from '@livekit/agents';
import { emotionVector } from '@ptoy/segmenter';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { type PcmAudio, type TtsBackend, TtsError, type TtsSegment } from './backend.js';
import { decodeWav } from './wav.js';

export interface IndexTtsGradioOptions {
  /** WebUI base URL, e.g. `http://192.168.31.82:7860`. */
  readonly url: string;
  /** Local path of the speaker reference wav. Uploaded once, then referenced by its server path. */
  readonly refAudioPath: string;
  readonly language: 'ZH' | 'EN' | 'JA' | 'AR' | 'ES';
  /** `reference`: emotion follows the speaker reference (segment emotion ignored); `vector`: one-hot emotion vector. */
  readonly emotionControl: 'reference' | 'vector';
  /** Whole-request timeout (queue + synthesis + download). */
  readonly timeoutMs: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const API_NAME = 'gen_single';
const EMO_SAME_AS_REFERENCE = '与音色参考音频相同';
const EMO_VECTOR = '使用情感向量控制';

interface ApiParameter {
  readonly parameter_name: string;
  readonly parameter_has_default?: boolean;
  readonly parameter_default?: unknown;
}

interface FileData {
  readonly path: string;
  readonly url?: string | null;
}

const isFileData = (v: unknown): v is FileData =>
  !!v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string';

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
    throw new TtsError('bad_response', `Gradio answered ${res.url} with invalid JSON`, { cause: error });
  }
}

const gradioFile = (path: string) => ({ path, meta: { _type: 'gradio.FileData' } });

/**
 * IndexTTS WebUI backend: Gradio 5 REST API (`/gradio_api/call/gen_single` + SSE result).
 *
 * The positional argument list is built from the endpoint's own `/gradio_api/info` defaults,
 * overriding only what we control (method, reference, text, language, emotion vector), so the
 * WebUI's other sliders keep their defaults and a WebUI update that adds parameters still works.
 * The reference audio is uploaded once (Gradio keys uploads by content hash) and the returned
 * server path is reused; after a failed synthesis it is re-uploaded in case the cache was cleared.
 * Gradio's `/call` API cannot cancel a queued job, so a cancelled request only stops waiting.
 */
export class IndexTtsGradioBackend implements TtsBackend {
  readonly name = 'indextts-gradio';
  readonly #opts: IndexTtsGradioOptions;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #logger = log().child({ tts: 'indextts-gradio' });
  #params: Promise<readonly ApiParameter[]> | undefined;
  #ref: Promise<string> | undefined;

  constructor(opts: IndexTtsGradioOptions) {
    this.#opts = opts;
    this.#base = opts.url.replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? fetch;
  }

  async prewarm(): Promise<void> {
    const signal = AbortSignal.timeout(this.#opts.timeoutMs);
    try {
      await Promise.all([this.#parameters(signal), this.#refServerPath(signal)]);
    } catch (error) {
      this.#logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'tts prewarm failed');
    }
  }

  async synthesize(segment: TtsSegment, signal: AbortSignal): Promise<PcmAudio> {
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const [params, ref] = await Promise.all([this.#parameters(combined), this.#refServerPath(combined)]);
      const data = this.#buildData(params, ref, segment);
      const eventId = await this.#submit(data, combined);
      const output = await this.#awaitResult(eventId, combined);
      const wav = await this.#download(output, combined);
      try {
        return decodeWav(wav);
      } catch (error) {
        throw new TtsError('bad_response', `IndexTTS returned undecodable audio: ${(error as Error).message}`, {
          cause: error,
        });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      // Next request re-uploads the reference, in case the server dropped its cache.
      this.#ref = undefined;
      if (error instanceof TtsError) throw error;
      if (timeout.aborted) {
        throw new TtsError('timeout', `IndexTTS did not answer within ${this.#opts.timeoutMs}ms`, { cause: error });
      }
      throw new TtsError('unreachable', `IndexTTS unreachable at ${this.#base}`, { cause: error });
    }
  }

  #buildData(params: readonly ApiParameter[], ref: string, segment: TtsSegment): unknown[] {
    const overrides: Record<string, unknown> = {
      emo_control_method: this.#opts.emotionControl === 'vector' ? EMO_VECTOR : EMO_SAME_AS_REFERENCE,
      prompt: gradioFile(ref),
      text: segment.text,
      lang_choice: this.#opts.language,
      emo_ref_path: null,
    };
    if (this.#opts.emotionControl === 'vector') {
      emotionVector(segment.emotion).forEach((v, i) => {
        overrides[`vec${i + 1}`] = v;
      });
    }
    return params.map((p) =>
      p.parameter_name in overrides
        ? overrides[p.parameter_name]
        : p.parameter_has_default
          ? (p.parameter_default ?? null)
          : null,
    );
  }

  #parameters(signal: AbortSignal): Promise<readonly ApiParameter[]> {
    this.#params ??= (async () => {
      const res = await this.#request(`${this.#base}/gradio_api/info`, { signal });
      const body = (await json(res)) as { named_endpoints?: Record<string, { parameters?: ApiParameter[] }> };
      const params = body.named_endpoints?.[`/${API_NAME}`]?.parameters;
      if (!Array.isArray(params) || !params.some((p) => p.parameter_name === 'text')) {
        throw new TtsError('bad_response', `Gradio app at ${this.#base} has no /${API_NAME} endpoint with a text input`);
      }
      return params;
    })();
    this.#params.catch(() => {
      this.#params = undefined;
    });
    return this.#params;
  }

  #refServerPath(signal: AbortSignal): Promise<string> {
    this.#ref ??= (async () => {
      const bytes = await readFile(this.#opts.refAudioPath).catch((error: unknown) => {
        throw new TtsError('config', `cannot read TTS_REF_AUDIO ${this.#opts.refAudioPath}`, { cause: error });
      });
      const form = new FormData();
      form.append('files', new Blob([bytes], { type: 'audio/wav' }), basename(this.#opts.refAudioPath));
      const started = performance.now();
      const res = await this.#request(`${this.#base}/gradio_api/upload`, { method: 'POST', body: form, signal });
      const paths = await json(res);
      const path = Array.isArray(paths) ? paths[0] : undefined;
      if (typeof path !== 'string') throw new TtsError('bad_response', 'Gradio upload returned no file path');
      this.#logger.info(
        { bytes: bytes.byteLength, uploadMs: Math.round(performance.now() - started) },
        'uploaded tts reference audio',
      );
      return path;
    })();
    this.#ref.catch(() => {
      this.#ref = undefined;
    });
    return this.#ref;
  }

  async #submit(data: unknown[], signal: AbortSignal): Promise<string> {
    const res = await this.#request(`${this.#base}/gradio_api/call/${API_NAME}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
      signal,
    });
    const body = (await json(res)) as { event_id?: unknown };
    if (typeof body.event_id !== 'string') throw new TtsError('bad_response', 'Gradio call returned no event_id');
    return body.event_id;
  }

  /** Reads the SSE result stream until `complete` / `error`. */
  async #awaitResult(eventId: string, signal: AbortSignal): Promise<FileData> {
    const res = await this.#request(`${this.#base}/gradio_api/call/${API_NAME}/${eventId}`, { signal });
    const text = await res.text();
    let event = '';
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:') && (event === 'complete' || event === 'error')) {
        const raw = line.slice(5).trim();
        if (event === 'error') {
          throw new TtsError('service', `IndexTTS synthesis failed${raw && raw !== 'null' ? `: ${raw}` : ''}`);
        }
        let output: unknown;
        try {
          output = (JSON.parse(raw) as unknown[])[0];
        } catch (error) {
          throw new TtsError('bad_response', 'Gradio result is not valid JSON', { cause: error });
        }
        // The WebUI returns a `gr.update(value=FileData, visible=True)`.
        const file = isFileData(output) ? output : (output as { value?: unknown } | undefined)?.value;
        if (!isFileData(file)) throw new TtsError('bad_response', 'Gradio result has no audio file');
        return file;
      }
    }
    throw new TtsError('bad_response', 'Gradio result stream ended without a result');
  }

  async #download(file: FileData, signal: AbortSignal): Promise<Uint8Array> {
    // Build the URL from our base: the server-reported `url` may use a host we can't reach.
    const res = await this.#request(`${this.#base}/gradio_api/file=${encodeURIComponent(file.path)}`, { signal });
    return new Uint8Array(await res.arrayBuffer());
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const res = await this.#fetch(url, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TtsError('service', `IndexTTS responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, {
        status: res.status,
      });
    }
    return res;
  }
}

import { z } from 'zod';
import { rejectRenamedEnv } from '../env-renames.js';

const schema = z.object({
  CLOUD_MODEL_CHECKS: z.enum(['true', 'false']).default('false'),
  CLOUD_MODEL_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(2000),
  CLOUD_MODEL_CHECK_CACHE_MS: z.coerce.number().int().min(0).max(30000).default(3000),
  ASR_BACKEND: z.string().default('sensevoice'),
  ASR_BASE_URL: z.string().url().default('http://127.0.0.1:8001/v1'),
  LLM_BASE_URL: z.string().url().default('http://127.0.0.1:8080/v1'),
  TTS_FASTAPI_URL: z.string().url().default('http://127.0.0.1:8002'),
  TTS_BACKEND: z.string().default('gradio'),
});

/** Hosted OpenRouter has no `/health`; it is not a self-hosted model to gate on. */
const isOpenRouter = (url: string) => new URL(url).hostname === 'openrouter.ai';
export interface ModelChecksConfig { enabled: boolean; timeoutMs: number; cacheMs: number; urls: readonly string[] }
export function loadModelChecksConfig(env: NodeJS.ProcessEnv = process.env): ModelChecksConfig {
  rejectRenamedEnv(env);
  const e = schema.parse(env);
  // ASR and LLM bases end in /v1; their /health sits at the service root.
  const health = (base: string, apiBase = false) => {
    const url = new URL(base);
    const path = url.pathname.replace(/\/$/, '');
    url.pathname = (apiBase ? path.replace(/\/v1$/, '') : path) + '/health';
    url.search = ''; url.hash = '';
    return url.href;
  };
  return { enabled: e.CLOUD_MODEL_CHECKS === 'true', timeoutMs: e.CLOUD_MODEL_CHECK_TIMEOUT_MS, cacheMs: e.CLOUD_MODEL_CHECK_CACHE_MS,
    urls: [
      ...(e.ASR_BACKEND === 'openrouter' ? [] : [health(e.ASR_BASE_URL, true)]),
      ...(isOpenRouter(e.LLM_BASE_URL) ? [] : [health(e.LLM_BASE_URL, true)]),
      ...(e.TTS_BACKEND === 'openrouter' ? [] : [health(e.TTS_FASTAPI_URL)]),
    ] };
}

/** Readiness only gates new reservations. A failed probe never terminates an existing call. */
export class ModelAvailability {
  private cached?: { ready: boolean; until: number };
  private pending?: Promise<boolean>;
  constructor(private readonly config: ModelChecksConfig, private readonly request: typeof fetch = fetch, private readonly clock = Date.now) {}
  ready(): Promise<boolean> {
    if (!this.config.enabled) return Promise.resolve(true);
    if (this.cached && this.cached.until > this.clock()) return Promise.resolve(this.cached.ready);
    if (this.pending) return this.pending;
    this.pending = Promise.all(this.config.urls.map(async url => {
      try {
        const response = await this.request(url, { signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'error' });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    })).then(results => {
      const ready = results.every(Boolean);
      this.cached = { ready, until: this.clock() + this.config.cacheMs };
      return ready;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}

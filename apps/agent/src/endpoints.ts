/** OpenRouter's OpenAI-compatible API base, shared by its ASR, LLM and TTS endpoints. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

export const isOpenRouterUrl = (url: string): boolean => new URL(url).hostname === 'openrouter.ai';

/** A service's own key (`ASR_API_KEY`, ...), else the shared `OPENROUTER_API_KEY`. */
export const openRouterKey = (env: NodeJS.ProcessEnv, own: string): string | undefined =>
  env[own] || env.OPENROUTER_API_KEY || undefined;

/** `ASR_BASE_URL` per `ASR_BACKEND`: an API base, the plugin appends `/audio/transcriptions`. */
export const ASR_DEFAULTS = {
  sensevoice: { baseUrl: 'http://127.0.0.1:8001/v1' },
  openrouter: { baseUrl: OPENROUTER_API_BASE, model: 'fish-audio/transcribe-1-pro' },
} as const;

/** `TTS_BASE_URL` per `TTS_BACKEND`: each backend appends its own paths (`/tts`, `/audio/speech`, Gradio's API). */
export const TTS_DEFAULTS = {
  gradio: { baseUrl: 'http://127.0.0.1:7860' },
  fastapi: { baseUrl: 'http://127.0.0.1:8002' },
  openrouter: { baseUrl: OPENROUTER_API_BASE, model: 'fish-audio/s2.1-pro' },
} as const;

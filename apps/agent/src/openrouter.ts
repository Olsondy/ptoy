/** OpenRouter's OpenAI-compatible API base, shared by its ASR, LLM and TTS endpoints. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

export const isOpenRouterUrl = (url: string): boolean => new URL(url).hostname === 'openrouter.ai';

/** A service's own key (`ASR_API_KEY`, ...), else the shared `OPENROUTER_API_KEY`. */
export const openRouterKey = (env: NodeJS.ProcessEnv, own: string): string | undefined =>
  env[own] || env.OPENROUTER_API_KEY || undefined;

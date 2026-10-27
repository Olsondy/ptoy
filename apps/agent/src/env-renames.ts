/** Renamed env vars → what replaces them. A leftover old name fails startup instead of being silently ignored. */
const RENAMED: Readonly<Record<string, string>> = {
  ASR_URL: 'ASR_BASE_URL, which now ends in /v1 (http://127.0.0.1:8001/v1, https://openrouter.ai/api/v1)',
  TTS_GRADIO_URL: 'TTS_BASE_URL',
  TTS_FASTAPI_URL: 'TTS_BASE_URL',
  TTS_OPENROUTER_URL: 'TTS_BASE_URL',
  TTS_OPENROUTER_API_KEY: 'TTS_API_KEY (or the shared OPENROUTER_API_KEY)',
  TTS_OPENROUTER_MODEL: 'TTS_MODEL',
  TTS_OPENROUTER_VOICES: 'TTS_VOICES',
};

export function rejectRenamedEnv(env: NodeJS.ProcessEnv): void {
  const used = Object.keys(RENAMED).filter((name) => env[name] !== undefined);
  if (used.length > 0) {
    const hints = used.map((name) => `${name} → ${RENAMED[name]}`).join('; ');
    throw new Error(`Renamed env vars (see apps/agent/.env.example): ${hints}`);
  }
}

import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const livekitSchema = z.object({
  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
});

const tokenServerSchema = livekitSchema.extend({
  LIVEKIT_PUBLIC_URL: z.string().url().optional(),
  TOKEN_SERVER_HOST: z.string().default('0.0.0.0'),
  TOKEN_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  TOKEN_SERVER_CORS_ORIGIN: z.string().default('*'),
  TOKEN_TTL: z.string().default('1h'),
});

export interface TokenServerConfig {
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  /** URL the browser connects to (may differ from the agent's LIVEKIT_URL). */
  readonly livekitPublicUrl: string;
  readonly host: string;
  readonly port: number;
  readonly corsOrigin: string;
  readonly tokenTtl: string;
}

export function loadTokenServerConfig(env: NodeJS.ProcessEnv = process.env): TokenServerConfig {
  const parsed = tokenServerSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid token server env (see apps/agent/.env.example): ${issues}`);
  }
  const e = parsed.data;
  return {
    livekitApiKey: e.LIVEKIT_API_KEY,
    livekitApiSecret: e.LIVEKIT_API_SECRET,
    livekitPublicUrl: e.LIVEKIT_PUBLIC_URL ?? e.LIVEKIT_URL,
    host: e.TOKEN_SERVER_HOST,
    port: e.TOKEN_SERVER_PORT,
    corsOrigin: e.TOKEN_SERVER_CORS_ORIGIN,
    tokenTtl: e.TOKEN_TTL,
  };
}

const callSchema = z.object({
  ASR_URL: z.string().url().default('http://localhost:8100'),
  ASR_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ASR_LANGUAGE: z.string().min(2).default('zh'),
  TURN_DETECTOR: z.enum(['vad', 'eot']).default('vad'),
  VAD_MIN_SILENCE_MS: z.coerce.number().int().positive().default(550),
  ENDPOINTING_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
  ENDPOINTING_MAX_DELAY_MS: z.coerce.number().int().positive().default(3000),
});

export interface CallConfig {
  readonly asrUrl: string;
  readonly asrTimeoutMs: number;
  readonly asrLanguage: string;
  /** `vad`: VAD silence ends the turn (default, see docs/architecture/server.md); `eot`: LiveKit's local audio end-of-turn model on top of VAD. */
  readonly turnDetector: 'vad' | 'eot';
  readonly vadMinSilenceMs: number;
  readonly endpointingMinDelayMs: number;
  readonly endpointingMaxDelayMs: number;
}

export function loadCallConfig(env: NodeJS.ProcessEnv = process.env): CallConfig {
  const parsed = callSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid call pipeline env (see apps/agent/.env.example): ${issues}`);
  }
  const e = parsed.data;
  return {
    asrUrl: e.ASR_URL,
    asrTimeoutMs: e.ASR_TIMEOUT_MS,
    asrLanguage: e.ASR_LANGUAGE,
    turnDetector: e.TURN_DETECTOR,
    vadMinSilenceMs: e.VAD_MIN_SILENCE_MS,
    endpointingMinDelayMs: e.ENDPOINTING_MIN_DELAY_MS,
    endpointingMaxDelayMs: e.ENDPOINTING_MAX_DELAY_MS,
  };
}

/** Character system prompt shipped with the agent (edit the file, not the code). */
export const DEFAULT_CHARACTER_PROMPT_FILE = fileURLToPath(new URL('../prompts/character.md', import.meta.url));

const conversationSchema = z.object({
  LLM_BASE_URL: z.string().url().default('http://127.0.0.1:8080/v1'),
  LLM_MODEL: z.string().min(1).default('qwen3-8b'),
  // llama-server ignores the key; the OpenAI client just needs a non-empty one.
  LLM_API_KEY: z.string().min(1).default('no-key'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(150),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LLM_MAX_RETRY: z.coerce.number().int().nonnegative().default(1),
  CHARACTER_PROMPT_FILE: z.string().min(1).default(DEFAULT_CHARACTER_PROMPT_FILE),
  TTS_BACKEND: z.enum(['gradio']).default('gradio'),
  TTS_GRADIO_URL: z.string().url().default('http://127.0.0.1:7860'),
  TTS_REF_AUDIO: z.string().min(1).optional(),
  TTS_LANGUAGE: z.enum(['ZH', 'EN', 'JA', 'AR', 'ES']).default('ZH'),
  TTS_EMOTION_CONTROL: z.enum(['reference', 'vector']).default('reference'),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  AGENT_AUDIO_SAMPLE_RATE: z.coerce.number().int().positive().default(24000),
});

export interface LlmConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly maxRetry: number;
}

export interface GradioTtsConfig {
  readonly backend: 'gradio';
  readonly url: string;
  /** Local path of the speaker reference wav; uploaded once per process. */
  readonly refAudioPath: string;
  readonly language: 'ZH' | 'EN' | 'JA' | 'AR' | 'ES';
  /** `reference`: emotion follows the speaker reference audio; `vector`: the segment emotion drives IndexTTS2's emotion vector. */
  readonly emotionControl: 'reference' | 'vector';
  readonly timeoutMs: number;
}

/** One variant per backend; #14 adds `{ backend: 'fastapi', ... }`. */
export type TtsConfig = GradioTtsConfig;

export interface ConversationConfig extends CallConfig {
  readonly llm: LlmConfig;
  readonly tts: TtsConfig;
  readonly characterPromptFile: string;
  /** Sample rate of the agent's published audio track; TTS output is resampled to it. */
  readonly audioSampleRate: number;
}

export function loadConversationConfig(env: NodeJS.ProcessEnv = process.env): ConversationConfig {
  const parsed = conversationSchema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  if (parsed.success && !parsed.data.TTS_REF_AUDIO) issues.push('TTS_REF_AUDIO: required (speaker reference wav)');
  if (!parsed.success || issues.length > 0) {
    throw new Error(`Invalid conversation pipeline env (see apps/agent/.env.example): ${issues.join('; ')}`);
  }
  const e = parsed.data;
  return {
    ...loadCallConfig(env),
    llm: {
      baseUrl: e.LLM_BASE_URL,
      model: e.LLM_MODEL,
      apiKey: e.LLM_API_KEY,
      maxTokens: e.LLM_MAX_TOKENS,
      temperature: e.LLM_TEMPERATURE,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetry: e.LLM_MAX_RETRY,
    },
    tts: {
      backend: e.TTS_BACKEND,
      url: e.TTS_GRADIO_URL,
      refAudioPath: e.TTS_REF_AUDIO as string,
      language: e.TTS_LANGUAGE,
      emotionControl: e.TTS_EMOTION_CONTROL,
      timeoutMs: e.TTS_TIMEOUT_MS,
    },
    characterPromptFile: e.CHARACTER_PROMPT_FILE,
    audioSampleRate: e.AGENT_AUDIO_SAMPLE_RATE,
  };
}

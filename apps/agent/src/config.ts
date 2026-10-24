import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const livekitSchema = z.object({
  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
});

/** Character prompts shipped with the agent: one `<id>.md` per character plus `_rules.md` (edit the files, not the code). */
export const DEFAULT_CHARACTERS_DIR = fileURLToPath(new URL('../prompts/characters', import.meta.url));

const charactersSchema = z.object({
  CHARACTERS_DIR: z.string().min(1).default(DEFAULT_CHARACTERS_DIR),
  DEFAULT_CHARACTER: z.string().min(1).default('xiaoyou'),
});

/** Where the character prompts live and which one a call gets when the page picked none (ADR 0007). */
export interface CharactersConfig {
  readonly dir: string;
  readonly defaultId: string;
}

const tokenServerSchema = livekitSchema.extend({
  ...charactersSchema.shape,
  LIVEKIT_PUBLIC_URL: z.string().url().optional(),
  TOKEN_SERVER_HOST: z.string().default('0.0.0.0'),
  TOKEN_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  TOKEN_SERVER_CORS_ORIGIN: z.string().default('*'),
  TOKEN_TTL: z.string().default('1h'),
  CHARACTER_LINK_SECRET: z.string().min(32).optional(),
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
  readonly characterLinkSecret: string;
  readonly characters: CharactersConfig;
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
    characterLinkSecret: e.CHARACTER_LINK_SECRET ?? e.LIVEKIT_API_SECRET,
    characters: { dir: e.CHARACTERS_DIR, defaultId: e.DEFAULT_CHARACTER },
  };
}

const callSchema = z.object({
  ASR_URL: z.string().url().default('http://127.0.0.1:8001'),
  ASR_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ASR_LANGUAGE: z.string().min(2).default('zh'),
  TURN_DETECTOR: z.enum(['vad', 'eot', 'transcript']).default('transcript'),
  VAD_MIN_SILENCE_MS: z.coerce.number().int().positive().default(550),
  ENDPOINTING_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(800),
  ENDPOINTING_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  INTERRUPTION_MIN_SPEECH_MS: z.coerce.number().int().positive().default(150),
  FALSE_INTERRUPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
});

export interface CallConfig {
  readonly asrUrl: string;
  readonly asrTimeoutMs: number;
  readonly asrLanguage: string;
  /**
   * `vad`: VAD silence ends the turn; `transcript`: like `vad`, but a transcript that stops
   * mid-sentence ("然后", "我觉得", "，") waits `endpointingMaxDelayMs`; `eot`: LiveKit's local audio
   * end-of-turn model on top of VAD. See docs/architecture/server.md §11.
   */
  readonly turnDetector: 'vad' | 'eot' | 'transcript';
  readonly vadMinSilenceMs: number;
  readonly endpointingMinDelayMs: number;
  readonly endpointingMaxDelayMs: number;
  /** Caller speech this long pauses the agent (reversible until a transcript confirms it). */
  readonly interruptionMinSpeechMs: number;
  /** A pause with no transcript after this much silence resumes the agent (cough, noise, "嗯"). */
  readonly falseInterruptionTimeoutMs: number;
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
    interruptionMinSpeechMs: e.INTERRUPTION_MIN_SPEECH_MS,
    falseInterruptionTimeoutMs: e.FALSE_INTERRUPTION_TIMEOUT_MS,
  };
}

/** Pre-recorded fillers shipped in the repo, one `<voice>/manifest.json` per voice (services/fillers generates them). */
export const DEFAULT_FILLERS_DIR = fileURLToPath(new URL('../../../assets/fillers', import.meta.url));

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const conversationSchema = charactersSchema.extend({
  LLM_BASE_URL: z.string().url().default('http://127.0.0.1:8080/v1'),
  LLM_MODEL: z.string().min(1).default('qwen3-8b'),
  // llama-server ignores the key; the OpenAI client just needs a non-empty one.
  LLM_API_KEY: z.string().min(1).default('no-key'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(220),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LLM_MAX_RETRY: z.coerce.number().int().nonnegative().default(1),
  LLM_REASONING_EFFORT: z.enum(REASONING_EFFORTS).optional(),
  LLM_SHARED_RULES: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  TTS_BACKEND: z.enum(['gradio', 'fastapi', 'openrouter']).default('gradio'),
  TTS_GRADIO_URL: z.string().url().default('http://127.0.0.1:7860'),
  TTS_FASTAPI_URL: z.string().url().default('http://127.0.0.1:8002'),
  TTS_REF_AUDIO: z.string().min(1).optional(),
  TTS_OPENROUTER_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  TTS_OPENROUTER_API_KEY: z.string().min(1).optional(),
  TTS_OPENROUTER_MODEL: z.string().min(1).default('fish-audio/s2.1-pro'),
  // `<character voice>=<provider voice id>` pairs, comma-separated.
  TTS_OPENROUTER_VOICES: z.string().default(''),
  TTS_LANGUAGE: z.enum(['ZH', 'EN', 'JA', 'AR', 'ES']).default('ZH'),
  TTS_EMOTION_CONTROL: z.enum(['reference', 'vector']).default('vector'),
  TTS_EMO_WEIGHT: z.coerce.number().min(0).max(1).default(0.6),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  AGENT_AUDIO_SAMPLE_RATE: z.coerce.number().int().positive().default(24000),
  FILLERS_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  FILLERS_DIR: z.string().min(1).default(DEFAULT_FILLERS_DIR),
  FILLERS_ALWAYS: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  FILLER_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
});

export interface LlmConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly timeoutMs: number;
  readonly maxRetry: number;
  /**
   * `reasoning_effort` for hosted reasoning models (e.g. ChatGPT or DeepSeek via magpie). Unset:
   * the lowest level the endpoint's `/models` lists for the model (`withReasoningEffort`), or
   * nothing when it lists none (llama-server turns thinking off at launch, docs/architecture/server.md §5).
   */
  readonly reasoningEffort?: ReasoningEffort;
}

export interface GradioTtsConfig {
  readonly backend: 'gradio';
  readonly url: string;
  /** Local path of the speaker reference wav; uploaded once per process. */
  readonly refAudioPath: string;
  readonly language: 'ZH' | 'EN' | 'JA' | 'AR' | 'ES';
  /**
   * `vector` (default): the segment emotion drives IndexTTS2's emotion vector (平静 uses the reference);
   * `reference`: emotion always follows the speaker reference audio.
   */
  readonly emotionControl: 'reference' | 'vector';
  /** WebUI `emo_weight` for vector mode (emotion strength, 0–1). */
  readonly emotionWeight: number;
  readonly timeoutMs: number;
}

/**
 * IndexTTS FastAPI service (`services/tts`): reference audios, language and model settings live on
 * the server; each call asks for its character's voice.
 */
export interface FastApiTtsConfig {
  readonly backend: 'fastapi';
  readonly url: string;
  /** `reference`: no emotion sent (the server speaks like the reference); `vector`: the segment emotion is sent. */
  readonly emotionControl: 'reference' | 'vector';
  /** Emotion strength sent as `emo_alpha` in vector mode (0–1). */
  readonly emotionWeight: number;
  readonly timeoutMs: number;
}

/** OpenRouter speech API (cloud, no local GPU): each character's `voice:` maps to a provider voice id. */
export interface OpenRouterTtsConfig {
  readonly backend: 'openrouter';
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  /** Character voice → provider voice id; a voice missing here speaks with the model's default voice. */
  readonly voices: Readonly<Record<string, string>>;
  /** `reference`: text only; `vector`: the segment emotion becomes a `[情绪]` style hint. */
  readonly emotionControl: 'reference' | 'vector';
  readonly timeoutMs: number;
}

/** One variant per backend (`TTS_BACKEND`). */
export type TtsConfig = GradioTtsConfig | FastApiTtsConfig | OpenRouterTtsConfig;

/** `a=x, b=y` → `{ a: 'x', b: 'y' }`; undefined on a malformed pair. */
function parseVoiceMap(value: string): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const pair of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [key, id, ...rest] = pair.split('=').map((p) => p.trim());
    if (!key || !id || rest.length > 0) return undefined;
    map[key] = id;
  }
  return map;
}

export interface ConversationConfig extends CallConfig {
  readonly llm: LlmConfig;
  readonly tts: TtsConfig;
  readonly characters: CharactersConfig;
  /**
   * Append `_rules.md` (call rules + emotion tags for IndexTTS2) to every persona and show the LLM the
   * caller's tone (`[用户语气:X]`). Off for personas that carry their own rules, e.g. with
   * TTS_BACKEND=openrouter: replies come untagged and speak as 平静.
   */
  readonly sharedRules: boolean;
  /** Sample rate of the agent's published audio track; TTS output is resampled to it. */
  readonly audioSampleRate: number;
  /** Play a pre-recorded filler when a user turn ends (`undefined` = disabled). */
  readonly fillers?: {
    /** One `<voice>/manifest.json` per voice; a call plays its character voice's set. */
    readonly dir: string;
    /** Every turn gets a filler (no chance-based skipping); `sim:call --barge-in` relies on it. */
    readonly always: boolean;
    /**
     * The filler waits this long after the turn ends and is skipped if the reply's first audio is
     * ready by then: only a slow reply gets one. 0 = play right away.
     */
    readonly delayMs: number;
  };
}

export function loadConversationConfig(env: NodeJS.ProcessEnv = process.env): ConversationConfig {
  const parsed = conversationSchema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  if (parsed.success && parsed.data.TTS_BACKEND === 'gradio' && !parsed.data.TTS_REF_AUDIO) {
    issues.push('TTS_REF_AUDIO: required with TTS_BACKEND=gradio (speaker reference wav)');
  }
  if (parsed.success && parsed.data.TTS_BACKEND === 'openrouter' && !parsed.data.TTS_OPENROUTER_API_KEY) {
    issues.push('TTS_OPENROUTER_API_KEY: required with TTS_BACKEND=openrouter');
  }
  const voices = parsed.success ? parseVoiceMap(parsed.data.TTS_OPENROUTER_VOICES) : {};
  if (voices === undefined) issues.push('TTS_OPENROUTER_VOICES: expected `voice=id` pairs separated by commas');
  if (!parsed.success || issues.length > 0) {
    throw new Error(`Invalid conversation pipeline env (see apps/agent/.env.example): ${issues.join('; ')}`);
  }
  const e = parsed.data;
  const tts: TtsConfig =
    e.TTS_BACKEND === 'openrouter'
      ? {
          backend: 'openrouter',
          url: e.TTS_OPENROUTER_URL,
          apiKey: e.TTS_OPENROUTER_API_KEY as string,
          model: e.TTS_OPENROUTER_MODEL,
          voices: voices ?? {},
          emotionControl: e.TTS_EMOTION_CONTROL,
          timeoutMs: e.TTS_TIMEOUT_MS,
        }
      : e.TTS_BACKEND === 'fastapi'
      ? {
          backend: 'fastapi',
          url: e.TTS_FASTAPI_URL,
          emotionControl: e.TTS_EMOTION_CONTROL,
          emotionWeight: e.TTS_EMO_WEIGHT,
          timeoutMs: e.TTS_TIMEOUT_MS,
        }
      : {
          backend: 'gradio',
          url: e.TTS_GRADIO_URL,
          refAudioPath: e.TTS_REF_AUDIO as string,
          language: e.TTS_LANGUAGE,
          emotionControl: e.TTS_EMOTION_CONTROL,
          emotionWeight: e.TTS_EMO_WEIGHT,
          timeoutMs: e.TTS_TIMEOUT_MS,
        };
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
      ...(e.LLM_REASONING_EFFORT !== undefined && { reasoningEffort: e.LLM_REASONING_EFFORT }),
    },
    tts,
    characters: { dir: e.CHARACTERS_DIR, defaultId: e.DEFAULT_CHARACTER },
    sharedRules: e.LLM_SHARED_RULES,
    audioSampleRate: e.AGENT_AUDIO_SAMPLE_RATE,
    fillers: e.FILLERS_ENABLED
      ? { dir: e.FILLERS_DIR, always: e.FILLERS_ALWAYS, delayMs: e.FILLER_DELAY_MS }
      : undefined,
  };
}

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

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

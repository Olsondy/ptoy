import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';

const schema = z.object({
  INVITE_DB_PATH: z.string().default('.data/access.sqlite'),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  ACCESS_INTERNAL_URL: z.string().url().default('http://127.0.0.1:8787'),
  ACCESS_INTERNAL_SECRET: z.string().min(32).optional(),
  LIVEKIT_API_SECRET: z.string().min(1),
  ACCESS_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  ACCESS_PENDING_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),
  ACCESS_AGENT_TIMEOUT_MS: z.coerce.number().int().min(10000).default(30000),
  ACCESS_RECONCILE_MS: z.coerce.number().int().min(1000).default(5000),
  ACCESS_TRUSTED_PROXY_IPS: z.string().default(''),
  ACCESS_MAINTENANCE_DEFAULT: z.enum(['true', 'false']).default('false'),
});

export interface AccessConfig {
  dbPath: string;
  origin: string;
  secureCookie: boolean;
  internalUrl: string;
  internalSecret: string;
  pendingTimeoutMs: number;
  agentTimeoutMs: number;
  reconcileMs: number;
  trustedProxyIps: readonly string[];
  maintenanceDefault: boolean;
}

export function loadAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const e = schema.parse(env);
  const url = new URL(e.APP_ORIGIN);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const secureCookie = e.ACCESS_COOKIE_SECURE !== undefined ? e.ACCESS_COOKIE_SECURE === 'true' : url.protocol === 'https:';
  const trustedProxyIps = e.ACCESS_TRUSTED_PROXY_IPS.split(',').map(s => s.trim()).filter(Boolean);
  if (trustedProxyIps.some(ip => !isIP(ip))) throw new Error('ACCESS_TRUSTED_PROXY_IPS must contain exact IP addresses');
  if (!loopback && (url.protocol !== 'https:' || !secureCookie)) throw new Error('APP_ORIGIN requires HTTPS and Secure cookies outside loopback');
  return {
    dbPath: e.INVITE_DB_PATH === ':memory:' ? ':memory:' : resolve(e.INVITE_DB_PATH),
    origin: url.origin,
    secureCookie,
    internalUrl: e.ACCESS_INTERNAL_URL,
    internalSecret: e.ACCESS_INTERNAL_SECRET ?? createHash('sha256').update('ptoy-access-internal-v1\0' + e.LIVEKIT_API_SECRET).digest('hex'),
    pendingTimeoutMs: e.ACCESS_PENDING_TIMEOUT_MS,
    agentTimeoutMs: e.ACCESS_AGENT_TIMEOUT_MS,
    reconcileMs: e.ACCESS_RECONCILE_MS,
    trustedProxyIps,
    maintenanceDefault: e.ACCESS_MAINTENANCE_DEFAULT === 'true',
  };
}

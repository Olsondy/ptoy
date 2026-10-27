#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function parseEnv(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('Invalid or duplicate environment key');
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error('Invalid quoted environment value'); } }
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid environment value');
    result[match[1]] = value;
  }
  return result;
}
const required = (s, key) => { if (!s[key]) throw new Error(`Missing ${key}`); return s[key]; };
export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && [18,19].includes(b))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}
export function validateSettings(s) {
  for (const key of ['APP_DOMAIN','RTC_DOMAIN']) {
    const value = required(s,key);
    if (value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
      || /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/.test(value)) throw new Error(`Replace ${key} with a real DNS hostname`);
  }
  if (s.APP_DOMAIN === s.RTC_DOMAIN) throw new Error('APP_DOMAIN and RTC_DOMAIN must differ');
  if (!publicIPv4(required(s,'PUBLIC_IPV4'))) throw new Error('PUBLIC_IPV4 must be a routable public IPv4, not a placeholder or Tailscale IP');
  const host = required(s,'MODEL_HOST');
  const parts = host.split('.').map(Number);
  if (!((isIP(host) === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || /^(?:[a-z0-9][a-z0-9-]*\.)+ts\.net$/.test(host))) throw new Error('MODEL_HOST must be a Tailscale IPv4 or full MagicDNS *.ts.net hostname');
  for (const key of ['ASR_PORT','LLM_PORT','TTS_PORT']) {
    if (!/^\d+$/.test(required(s,key)) || Number(s[key]) < 1 || Number(s[key]) > 65535) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['NODE_BIN','PNPM_BIN','LIVEKIT_BIN']) {
    if (!isAbsolute(required(s,key)) || !/^\/[A-Za-z0-9_./+-]+$/.test(s[key]) || s[key].split('/').includes('..')) throw new Error(`${key} must be an absolute path without spaces or traversal`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(required(s,'LIVEKIT_VERSION'))) throw new Error('Set exact LIVEKIT_VERSION to the installed release');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(required(s,'DEFAULT_CHARACTER'))) throw new Error('Invalid DEFAULT_CHARACTER');
  if (/\s|["\\]/.test(required(s,'LLM_MODEL'))) throw new Error('Invalid LLM_MODEL');
  if (/\s|["\\]/.test(required(s,'LLM_API_KEY'))) throw new Error('LLM_API_KEY must have no whitespace or quoting');
  return s;
}
export function applicationEnv(s, previous) {
  validateSettings(s);
  const secret = key => {
    if (previous && !/^[A-Za-z0-9_-]{32,}$/.test(previous[key] ?? '')) throw new Error(`Existing ${key} missing or invalid; refusing secret rotation`);
    return previous?.[key] ?? randomBytes(32).toString('hex');
  };
  const key = previous?.LIVEKIT_API_KEY ?? 'ptoy' + randomBytes(12).toString('hex');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error('Existing LIVEKIT_API_KEY invalid');
  return {
    NODE_ENV:'production', NODE_BIN:s.NODE_BIN, PNPM_BIN:s.PNPM_BIN, LIVEKIT_BIN:s.LIVEKIT_BIN, LIVEKIT_VERSION:s.LIVEKIT_VERSION,
    APP_DOMAIN:s.APP_DOMAIN, RTC_DOMAIN:s.RTC_DOMAIN, PUBLIC_IPV4:s.PUBLIC_IPV4, MODEL_HOST:s.MODEL_HOST,
    APP_ORIGIN:`https://${s.APP_DOMAIN}`, LIVEKIT_URL:'ws://127.0.0.1:7880', LIVEKIT_PUBLIC_URL:`wss://${s.RTC_DOMAIN}`,
    LIVEKIT_API_KEY:key, LIVEKIT_API_SECRET:secret('LIVEKIT_API_SECRET'), CHARACTER_LINK_SECRET:secret('CHARACTER_LINK_SECRET'),
    TOKEN_SERVER_HOST:'127.0.0.1', TOKEN_SERVER_PORT:'8787', TOKEN_TTL:'2m',
    ACCESS_INTERNAL_URL:'http://127.0.0.1:8787', ACCESS_INTERNAL_SECRET:secret('ACCESS_INTERNAL_SECRET'), ACCESS_COOKIE_SECURE:'true',
    ACCESS_TRUSTED_PROXY_IPS:'127.0.0.1,::1', INVITE_DB_PATH:'/var/lib/ptoy/access.sqlite',
    ACCESS_PENDING_TIMEOUT_MS:'60000', ACCESS_AGENT_TIMEOUT_MS:'30000', ACCESS_RECONCILE_MS:'5000',
    CLOUD_MODEL_CHECKS:'true', ACCESS_MAINTENANCE_DEFAULT:'true', CLOUD_MODEL_CHECK_TIMEOUT_MS:'2000', CLOUD_MODEL_CHECK_CACHE_MS:'3000', AGENT_HEALTH_HOST:'127.0.0.1', AGENT_HEALTH_PORT:'8081',
    AGENT_PIPELINE:'conversation', ASR_BACKEND:'sensevoice', ASR_BASE_URL:`http://${s.MODEL_HOST}:${s.ASR_PORT}/v1`, ASR_LANGUAGE:'zh', ASR_TIMEOUT_MS:'5000',
    LLM_BASE_URL:`http://${s.MODEL_HOST}:${s.LLM_PORT}/v1`, LLM_MODEL:s.LLM_MODEL, LLM_API_KEY:s.LLM_API_KEY,
    LLM_MAX_TOKENS:'220', LLM_TEMPERATURE:'0.7', LLM_TIMEOUT_MS:'10000', LLM_MAX_RETRY:'1',
    TTS_BACKEND:'fastapi', TTS_BASE_URL:`http://${s.MODEL_HOST}:${s.TTS_PORT}`, TTS_EMOTION_CONTROL:'vector', TTS_EMO_WEIGHT:'0.6', TTS_TIMEOUT_MS:'20000',
    TURN_DETECTOR:'transcript', VAD_MIN_SILENCE_MS:'550', ENDPOINTING_MIN_DELAY_MS:'800', ENDPOINTING_MAX_DELAY_MS:'2000',
    INTERRUPTION_MIN_SPEECH_MS:'150', FALSE_INTERRUPTION_TIMEOUT_MS:'1000', AGENT_AUDIO_SAMPLE_RATE:'24000',
    CHARACTERS_DIR:'/var/lib/ptoy/resources/characters', DEFAULT_CHARACTER:s.DEFAULT_CHARACTER,
    FILLERS_ENABLED:'true', FILLERS_DIR:'/var/lib/ptoy/resources/fillers', FILLER_DELAY_MS:'2000', LOG_LEVEL:'info',
  };
}
export function livekitYaml(e) {
  return `# Managed by ptoy deploy/cloud; HTTPS is handled by the selected external web server.\nport: 7880\nbind_addresses:\n  - 127.0.0.1\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: ${e.PUBLIC_IPV4}\nturn:\n  enabled: false\nkeys:\n  ${e.LIVEKIT_API_KEY}: ${e.LIVEKIT_API_SECRET}\nlogging:\n  level: info\n`;
}
const renderEnv = env => '# Managed by ptoy deploy/cloud; production secrets, do not commit.\n' + Object.entries(env).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
export function configure(settingsPath, output, checkOnly = false) {
  const s = validateSettings(parseEnv(readFileSync(settingsPath,'utf8')));
  const envPath = join(output,'app.env'); const lkPath = join(output,'livekit.yaml');
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Configuration directory must not be a symlink');
  for (const path of [envPath,lkPath]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Configuration files must not be symlinks');
  if (existsSync(envPath) !== existsSync(lkPath)) throw new Error('Incomplete existing configuration pair; inspect manually');
  const previous = existsSync(envPath) ? parseEnv(readFileSync(envPath,'utf8')) : undefined;
  const env = applicationEnv(s, previous); const renderedEnv = renderEnv(env); const yaml = livekitYaml(env);
  if (previous) {
    if (readFileSync(envPath,'utf8') !== renderedEnv || readFileSync(lkPath,'utf8') !== yaml) throw new Error('Existing configuration differs; refusing automatic overwrite. Plan a drained configuration change explicitly');
    return 'Existing configuration verified; secrets unchanged';
  }
  if (checkOnly) return 'Settings validated';
  mkdirSync(output,{recursive:true,mode:0o750});
  // Exclusive writes: never overwrite a second concurrent invocation or an existing secret.
  writeFileSync(envPath,renderedEnv,{mode:0o640,flag:'wx'});
  writeFileSync(lkPath,yaml,{mode:0o640,flag:'wx'});
  chmodSync(envPath,0o640); chmodSync(lkPath,0o640);
  return 'Configuration created; secrets are stored only in the protected files';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [settings,output='/etc/ptoy',mode] = process.argv.slice(2);
    if (!settings || (mode && mode !== '--check')) throw new Error('Usage: node configure.mjs <settings.env> [output-directory] [--check]');
    console.log(configure(settings,resolve(output),mode === '--check'));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}

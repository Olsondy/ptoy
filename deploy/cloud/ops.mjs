#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './configure.mjs';

export function validateStatus(value) {
  if (!value || typeof value.maintenance !== 'boolean' || !Number.isSafeInteger(value.activeCount) || value.activeCount < 0 || typeof value.modelsReady !== 'boolean') throw new Error('Invalid operations response');
  return { maintenance:value.maintenance, activeCount:value.activeCount, modelsReady:value.modelsReady };
}
export async function operations(action, env, timeoutSeconds = 600) {
  if (env.ACCESS_INTERNAL_URL !== 'http://127.0.0.1:8787' || !env.ACCESS_INTERNAL_SECRET) throw new Error('Invalid local operations configuration');
  const request = async enabled => {
    const res = await fetch(env.ACCESS_INTERNAL_URL + '/internal/ops/' + (enabled === undefined ? 'status':'maintenance'), {
      method:enabled === undefined ? 'GET':'POST', signal:AbortSignal.timeout(12000),
      headers:{ Authorization:'Bearer ' + env.ACCESS_INTERNAL_SECRET, 'Content-Type':'application/json' },
      ...(enabled === undefined ? {} : {body:JSON.stringify({enabled})}),
    });
    if (!res.ok) throw new Error(`Operations API returned HTTP ${res.status}`);
    return validateStatus(await res.json());
  };
  if (action === 'maintenance-on' || action === 'maintenance-off') return request(action === 'maintenance-on');
  if (action === 'status') return request();
  if (action !== 'wait-drain') throw new Error('Use status | maintenance-on | maintenance-off | wait-drain');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new Error('Invalid drain timeout');
  const until = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const status = await request();
    if (!status.maintenance) throw new Error('Maintenance must remain enabled while draining');
    if (status.activeCount === 0) return status;
    if (Date.now() >= until) throw new Error('Drain timed out; calls remain running and maintenance stays enabled');
    await new Promise(resolve => setTimeout(resolve,2000));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action='status',path='/etc/ptoy/app.env',timeout='600'] = process.argv.slice(2);
    console.log(JSON.stringify(await operations(action,parseEnv(readFileSync(path,'utf8')),Number(timeout))));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}

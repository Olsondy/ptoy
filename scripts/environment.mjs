import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

// Strip our options before forwarding the remaining arguments to the application.
export function environmentOptions(argv) {
  let name;
  let check = false;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue; // pnpm may preserve the argument separator.
    if (arg === '--check-env') { check = true; continue; }
    if (arg === '--env' || arg.startsWith('--env=')) {
      if (name !== undefined) throw new Error('--env 不能重复指定');
      name = arg === '--env' ? argv[++i] : arg.slice('--env='.length);
      if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('--env 需要环境名称，例如 --env hk');
    } else args.push(arg);
  }
  return { name, check, args };
}

export function loadEnvironment(directory, name, inherited = process.env, required = true) {
  const file = join(directory, name === undefined ? '.env' : `.env.${name}`);
  // A named environment must never silently use the local environment instead.
  if (!existsSync(file) && (required || name !== undefined)) throw new Error(`环境配置不存在：${file}`);
  const values = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { file, env: { ...values, ...inherited } };
}

export function checkEnvironment(env) {
  if (env.NODE_ENV !== 'production') return;
  for (const key of ['APP_ORIGIN', 'LIVEKIT_PUBLIC_URL']) {
    if (!env[key]) throw new Error(`请先填写环境配置中的 ${key}`);
  }
}

export function livekitArguments(env) {
  if (env.LIVEKIT_CONFIG) {
    if (!existsSync(env.LIVEKIT_CONFIG)) throw new Error(`LIVEKIT_CONFIG 指向的文件不存在：${env.LIVEKIT_CONFIG}`);
    return ['--config', env.LIVEKIT_CONFIG];
  }
  if (env.NODE_ENV === 'production') throw new Error('生产环境需要 LIVEKIT_CONFIG，不能以 --dev 启动 LiveKit');
  return ['--dev', '--bind', '0.0.0.0', ...(env.LIVEKIT_NODE_IP ? ['--node-ip', env.LIVEKIT_NODE_IP] : [])];
}

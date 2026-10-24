// Starts ptoy in one terminal: LiveKit server, token server, agent and web.
// Model service addresses come from apps/agent/.env.
// Usage: pnpm app            (Ctrl+C stops everything it started)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, 'apps', 'agent', '.env');
const isWindows = process.platform === 'win32';

if (!existsSync(envFile)) {
  fail('apps/agent/.env 不存在：先执行 cp apps/agent/.env.example apps/agent/.env 并填好');
}
const env = { ...parseEnv(readFileSync(envFile, 'utf8')), ...process.env };

const tokenPort = Number(env.TOKEN_SERVER_PORT || 8787);
const webPort = Number(env.WEB_PREVIEW_PORT || 4173);
const livekitUrl = new URL((env.LIVEKIT_URL || 'ws://127.0.0.1:7880').replace(/^ws/, 'http'));
const livekitPort = Number(livekitUrl.port || 7880);

const children = [];
let stopping = false;

function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(1000);
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const PINO_META = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v']);

// The agent's production mode logs pino JSON; show it as "HH:MM:SS LEVEL msg key=value ...".
function readable(line) {
  if (!line.startsWith('{')) return line;
  try {
    const entry = JSON.parse(line);
    if (typeof entry.msg !== 'string') return line;
    const time = new Date(entry.time ?? Date.now()).toTimeString().slice(0, 8);
    const fields = Object.entries(entry)
      .filter(([key]) => !PINO_META.has(key))
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' ');
    return `${time} ${(LEVELS[entry.level] ?? entry.level).toString().padEnd(5)} ${entry.msg}${fields ? `  ${fields}` : ''}`;
  } catch {
    return line;
  }
}

function start(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}]`.padEnd(10);
  const forward = (stream, out) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${readable(line)}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      log(`${prefix}已退出 (code ${code})，正在停止其余进程`);
      stopAll(1);
    }
  });
  children.push(child);
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

if (await portOpen(livekitPort, livekitUrl.hostname)) {
  log(`✓ LiveKit  已在 :${livekitPort} 运行，跳过启动`);
} else {
  const bin = (env.LIVEKIT_SERVER_BIN ?? '').trim().replace(/^["']|["']$/g, '');
  if (!bin) fail('apps/agent/.env 里的 LIVEKIT_SERVER_BIN 是空的：填 livekit-server 可执行文件的完整路径');
  if (!existsSync(bin)) fail(`LIVEKIT_SERVER_BIN 指向的文件不存在：${bin}`);
  const lkArgs = ['--dev', '--bind', '0.0.0.0', ...(env.LIVEKIT_NODE_IP ? ['--node-ip', env.LIVEKIT_NODE_IP] : [])];
  start('livekit', bin, lkArgs);
}

log('构建网页…');
const build = spawnSync('pnpm', ['--filter', '@ptoy/web', 'build'], { cwd: root, stdio: 'inherit', shell: isWindows });
if (build.status !== 0) fail('网页构建失败');

start('token', 'pnpm', ['--filter', '@ptoy/agent', 'start:token']);
start('agent', 'pnpm', ['--filter', '@ptoy/agent', 'start']);

// The web proxy forwards /api to the token server; start it once that answers, so an open page doesn't get ECONNREFUSED.
const tokenDeadline = Date.now() + 30_000;
while (!(await portOpen(tokenPort))) {
  if (stopping) await new Promise(() => {});
  if (Date.now() > tokenDeadline) {
    log(`✗ token 服务 30 秒内没有在 :${tokenPort} 监听，正在停止`);
    stopAll(1);
    await new Promise(() => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
start('web', 'pnpm', ['--filter', '@ptoy/web', 'preview', '--port', String(webPort), '--strictPort'], {
  TOKEN_SERVER_URL: `http://127.0.0.1:${tokenPort}`,
});

log(`\n打开 http://localhost:${webPort} 开始通话（Ctrl+C 停止）\n`);

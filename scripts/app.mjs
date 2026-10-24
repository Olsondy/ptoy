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

function start(name, command, args, extraEnv = {}, stopOnExit = true) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    shell: isWindows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}]`.padEnd(10);
  const forward = (stream, out) => {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${readable(line)}\n`);
    });
    stream.on('end', () => {
      if (buffered) out.write(`${prefix}${readable(buffered)}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopOnExit && !stopping) {
      log(`${prefix}已退出 (code ${code})，正在停止其余进程`);
      stopAll(1);
    }
  });
  child.on('error', (error) => {
    log(`${prefix}启动失败：${error.message}`);
    stopAll(1);
  });
  children.push(child);
  return child;
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  restoreInput();
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

// Consume Ctrl+C as input so the outer `pnpm app` batch shell also avoids its
// "Terminate batch job (Y/N)?" prompt. Non-interactive runs still use SIGINT.
const rawInput = isWindows && process.stdin.isTTY && !process.stdin.isRaw;
function restoreInput() {
  if (rawInput) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
if (rawInput) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    if (data.includes(3)) stopAll(0);
  });
  process.once('exit', restoreInput);
}

const livekitRunning = await portOpen(livekitPort, livekitUrl.hostname);
if (stopping) process.exit(0);
if (livekitRunning) {
  log(`✓ LiveKit  已在 :${livekitPort} 运行，跳过启动`);
} else {
  const bin = (env.LIVEKIT_SERVER_BIN ?? '').trim().replace(/^["']|["']$/g, '');
  if (!bin) fail('apps/agent/.env 里的 LIVEKIT_SERVER_BIN 是空的：填 livekit-server 可执行文件的完整路径');
  if (!existsSync(bin)) fail(`LIVEKIT_SERVER_BIN 指向的文件不存在：${bin}`);
  const lkArgs = ['--dev', '--bind', '0.0.0.0', ...(env.LIVEKIT_NODE_IP ? ['--node-ip', env.LIVEKIT_NODE_IP] : [])];
  start('livekit', bin, lkArgs);
}

log('构建网页…');
const build = start('build', 'pnpm', ['--filter', '@ptoy/web', 'build'], {}, false);
const buildCode = await new Promise((resolve) => {
  build.once('close', resolve);
});
if (stopping || buildCode !== 0) {
  if (!stopping) {
    log('网页构建失败');
    stopAll(1);
  }
} else {
  start('token', 'pnpm', ['--filter', '@ptoy/agent', 'start:token']);
  start('agent', 'pnpm', ['--filter', '@ptoy/agent', 'start']);
  start('web', 'pnpm', ['--filter', '@ptoy/web', 'preview', '--port', String(webPort), '--strictPort'], {
    TOKEN_SERVER_URL: `http://127.0.0.1:${tokenPort}`,
  });

  log(`\n打开 http://localhost:${webPort} 开始通话（Ctrl+C 停止）\n`);
}

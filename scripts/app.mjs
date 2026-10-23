// Starts the app side of ptoy in one terminal: LiveKit server, token server, agent and web.
// Model services (IndexTTS, llama-server, ASR) are managed separately; this only checks they answer.
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

async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function checkModels() {
  const llmBase = (env.LLM_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
  const checks = [
    ['ASR      ', `${(env.ASR_URL || 'http://127.0.0.1:8100').replace(/\/$/, '')}/health`],
    ['LLM      ', `${llmBase}/models`],
    ['IndexTTS ', env.TTS_GRADIO_URL || 'http://127.0.0.1:7860'],
  ];
  const results = await Promise.all(checks.map(async ([name, url]) => [name, url, await answers(url)]));
  for (const [name, url, ok] of results) {
    log(`${ok ? '✓' : '✗'} ${name}${url}${ok ? '' : '  没有响应（对话会报错，先启动它）'}`);
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
      for (const line of lines) out.write(`${prefix}${line}\n`);
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

log('检查模型服务…');
await checkModels();

if (await portOpen(livekitPort, livekitUrl.hostname)) {
  log(`✓ LiveKit  已在 :${livekitPort} 运行，跳过启动`);
} else {
  const bin = env.LIVEKIT_SERVER_BIN;
  if (!bin || !existsSync(bin)) {
    fail('找不到 livekit-server：在 apps/agent/.env 里设置 LIVEKIT_SERVER_BIN=<livekit-server 可执行文件路径>');
  }
  const lkArgs = ['--dev', '--bind', '0.0.0.0', ...(env.LIVEKIT_NODE_IP ? ['--node-ip', env.LIVEKIT_NODE_IP] : [])];
  start('livekit', bin, lkArgs);
}

log('构建网页…');
const build = spawnSync('pnpm', ['--filter', '@ptoy/web', 'build'], { cwd: root, stdio: 'inherit', shell: isWindows });
if (build.status !== 0) fail('网页构建失败');

start('token', 'pnpm', ['--filter', '@ptoy/agent', 'start:token']);
start('agent', 'pnpm', ['--filter', '@ptoy/agent', 'start']);
start('web', 'pnpm', ['--filter', '@ptoy/web', 'preview', '--port', String(webPort), '--strictPort'], {
  TOKEN_SERVER_URL: `http://127.0.0.1:${tokenPort}`,
});

log(`\n打开 http://localhost:${webPort} 开始通话（Ctrl+C 停止）\n`);

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { environmentOptions, loadEnvironment, checkEnvironment } from './environment.mjs';

const commands = {
  dev: ['src/agent.ts', 'dev'],
  start: ['src/agent.ts', 'start'],
  'dev:token': ['watch', 'src/token-server.ts'],
  'start:token': ['src/token-server.ts'],
  invite: ['src/access/cli.ts'],
  'sim:call': ['scripts/sim-call.ts'],
  'emotion:compliance': ['scripts/emotion-compliance.ts'],
  chat: ['scripts/chat.ts'],
  'check:characters': ['scripts/check-characters.ts'],
  'check:ambience': ['scripts/check-ambience.ts'],
};

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command)) throw new Error('未知 Agent 命令');
  const options = environmentOptions(argv);
  const directory = fileURLToPath(new URL('../apps/agent/', import.meta.url));
  const { file, env } = loadEnvironment(directory, options.name, process.env, false);
  checkEnvironment(env);
  if (options.check) {
    console.log(`环境配置检查通过：${file}`);
  } else {
    const child = spawn(process.execPath, [join(directory, 'node_modules/tsx/dist/cli.mjs'), ...commands[command], ...options.args], {
      cwd: directory, env, stdio: 'inherit', windowsHide: true,
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

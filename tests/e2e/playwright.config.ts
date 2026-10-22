import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Smoke test stack: LiveKit dev server → token server → echo agent → Vite web app.
 *
 * Defaults use ports that differ from the regular `pnpm dev:*` ports so the test never
 * reuses a dev server that happens to be running from another checkout. Every server is
 * started fresh and torn down by Playwright; LiveKit is started only when
 * LIVEKIT_SERVER_BIN is set, otherwise an already-running server at LIVEKIT_URL is used.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const env = process.env;
const livekitServerBin = env.LIVEKIT_SERVER_BIN;
// A LiveKit we start ourselves gets its own port so it never clashes with a `livekit-server --dev` on 7880.
const livekitUrl = env.LIVEKIT_URL ?? (livekitServerBin ? 'ws://localhost:7890' : 'ws://localhost:7880');
const livekitApiKey = env.LIVEKIT_API_KEY ?? 'devkey';
const livekitApiSecret = env.LIVEKIT_API_SECRET ?? 'secret';
const tokenPort = Number(env.E2E_TOKEN_PORT ?? 8730);
const webPort = Number(env.E2E_WEB_PORT ?? 5730);
const browserChannel = env.E2E_BROWSER_CHANNEL || undefined;

const livekitHttpUrl = livekitUrl.replace(/^ws/, 'http');
const livekitPort = Number(new URL(livekitHttpUrl).port || 7880);

const livekitEnv = {
  LIVEKIT_URL: livekitUrl,
  LIVEKIT_API_KEY: livekitApiKey,
  LIVEKIT_API_SECRET: livekitApiSecret,
};

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]['webServer']>;
const servers: Extract<WebServer, readonly unknown[]>[number][] = [];

if (livekitServerBin) {
  servers.push({
    name: 'livekit',
    // --dev fixes the key/secret to devkey/secret; the config body only moves the ports.
    command: `"${livekitServerBin}" --dev --bind 127.0.0.1`,
    env: {
      LIVEKIT_CONFIG: `port: ${livekitPort}\nrtc:\n  tcp_port: ${livekitPort + 1}\n  udp_port: ${livekitPort + 2}\n`,
    },
    url: livekitHttpUrl,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'ignore',
  });
} else {
  // Use the already-running LiveKit at LIVEKIT_URL; the command only runs (and fails) when it is unreachable.
  const hint = `No LiveKit server at ${livekitHttpUrl}. Start livekit-server --dev or set LIVEKIT_SERVER_BIN (see tests/e2e/README.md).`;
  servers.push({
    name: 'livekit',
    command: `node -e "console.error(${JSON.stringify(hint).replace(/"/g, '\\"')}); process.exit(1)"`,
    url: livekitHttpUrl,
    reuseExistingServer: true,
    timeout: 5_000,
  });
}

servers.push(
  {
    name: 'token',
    command: 'pnpm --filter @ptoy/agent start:token',
    cwd: repoRoot,
    env: { ...livekitEnv, TOKEN_SERVER_HOST: '127.0.0.1', TOKEN_SERVER_PORT: String(tokenPort) },
    url: `http://127.0.0.1:${tokenPort}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  {
    name: 'agent',
    command: 'pnpm --filter @ptoy/agent dev',
    cwd: repoRoot,
    env: { ...livekitEnv, LIVEKIT_AGENT_NAME: '', AGENT_PIPELINE: 'echo' },
    // The worker has no fixed HTTP port in dev mode; wait for it to register with LiveKit.
    wait: { stdout: /registered worker/i },
    reuseExistingServer: false,
    timeout: 60_000,
  },
  {
    name: 'web',
    command: 'pnpm --filter @ptoy/web dev --strictPort',
    cwd: repoRoot,
    env: { WEB_PORT: String(webPort), TOKEN_SERVER_URL: `http://127.0.0.1:${tokenPort}` },
    url: `http://localhost:${webPort}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
);

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(env.CI),
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-fake-media',
      use: {
        ...devices['Desktop Chrome'],
        channel: browserChannel,
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: servers,
});

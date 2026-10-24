import { connect, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { test, expect, verifyContext } from '../access-fixture';

/** A real TCP relay: only the browser's signalling transport passes through it. */
async function signalRelay(target: URL) {
  const sockets = new Set<Socket>();
  let accepting = true;
  let connections = 0;
  const server = createServer(client => {
    if (!accepting) { client.destroy(); return; }
    connections++;
    const upstream = connect({ host: target.hostname, port: Number(target.port || 80) });
    sockets.add(client); sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}`,
    get connections() { return connections; },
    interrupt() {
      accepting = false;
      const interrupted = sockets.size;
      for (const socket of sockets) socket.destroy();
      return interrupted;
    },
    restore() { accepting = true; },
    async close() {
      accepting = false;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test('真实信令短暂断开：重连期间保留占用，恢复原通话且不申请第二张凭证', async ({ page, browser, context, invitation, baseURL }) => {
  const target = new URL(process.env.LIVEKIT_URL ?? (process.env.LIVEKIT_SERVER_BIN ? 'ws://localhost:7890' : 'ws://localhost:7880'));
  test.skip(target.protocol !== 'ws:', 'This local TCP relay requires the fixture LiveKit ws endpoint.');
  const relay = await signalRelay(target);
  const other = await browser.newContext();
  let tokenRequests = 0;
  let attemptId = '';
  const observedAttemptIds = new Set<string>();
  page.on('request', request => {
    const match = /\/api\/calls\/([a-f0-9-]+)$/.exec(request.url());
    if (match) observedAttemptIds.add(match[1]!);
  });
  try {
    await verifyContext(other, baseURL!, invitation.code);
    await page.route('**/api/token', async route => {
      tokenRequests++;
      const response = await route.fetch();
      const token = await response.json();
      attemptId = token.attemptId;
      // Preserve the actual credential and access reservation; change only transport routing.
      await route.fulfill({ response, json: { ...token, serverUrl: relay.url } });
    });
    await page.goto('/');
    await page.getByTestId('call-toggle').click();
    const status = page.getByTestId('call-status');
    await expect(status).toHaveAttribute('data-status', 'connected');
    await expect(page.locator('audio')).toHaveCount(1);
    const firstAttempt = attemptId;
    const originalConnections = relay.connections;
    const interruptedAt = Date.now();
    expect(relay.interrupt()).toBeGreaterThan(0);
    await expect(status).toHaveAttribute('data-status', 'connecting');
    const competing = await other.request.post(new URL('/api/token', baseURL).href, {
      headers: { Origin: new URL(baseURL!).origin }, data: { requestId: randomUUID(), character: 'xiaoyou' },
    });
    expect(competing.status()).toBe(409);
    expect(await competing.json()).toMatchObject({ code: 'busy' });
    expect(await (await context.request.get(`/api/calls/${firstAttempt}`)).json()).toMatchObject({ state: 'established' });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 2000 - (Date.now() - interruptedAt))));
    relay.restore();
    await expect(status).toHaveAttribute('data-status', 'connected', { timeout: 20000 });
    expect(relay.connections).toBeGreaterThan(originalConnections);
    expect(tokenRequests).toBe(1);
    expect(attemptId).toBe(firstAttempt);
    expect([...observedAttemptIds]).toEqual([firstAttempt]);
    await expect.poll(async () => (await (await context.request.get(`/api/calls/${firstAttempt}`)).json()).state).toBe('established');
    await page.getByTestId('call-toggle').click();
    await expect(status).toHaveAttribute('data-status', 'disconnected');
    await expect.poll(async () => (await (await context.request.get(`/api/calls/${firstAttempt}`)).json()).state).toBe('ended');
  } finally {
    relay.restore();
    await other.close();
    await relay.close();
  }
});

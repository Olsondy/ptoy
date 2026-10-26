import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CharacterCatalog, loadCharacters } from '../characters.js';
import { loadAgentHealthConfig, loadTokenServerConfig, type TokenServerConfig } from '../config.js';
import { createTokenServer } from '../token-server.js';
import { AccessStore } from './store.js';
import { AccessController } from './controller.js';
import { loadModelChecksConfig, ModelAvailability } from './availability.js';

vi.mock('../characters.js', async original => ({ ...await original<typeof import('../characters.js')>(), loadCharacters: vi.fn() }));
let store: AccessStore, api: Server, models: Server, base: string, modelBase: string, config: TokenServerConfig;
let offline: boolean, probePaths: string[], delayProbe: (() => Promise<void>) | undefined;
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
const post = (path: string, body: unknown, cookie = '', internal = false) => fetch(base + path, {
  method: 'POST', headers: { Origin: config.access.origin, 'Content-Type': 'application/json', Cookie: cookie,
    ...(internal ? { Authorization: 'Bearer ' + config.access.internalSecret } : {}) }, body: JSON.stringify(body),
});
const status = () => fetch(base + '/internal/ops/status', { headers: { Authorization: 'Bearer ' + config.access.internalSecret } })
  .then(r => r.json() as Promise<{ maintenance: boolean; activeCount: number; modelsReady: boolean }>);
const availability = (cookie: string) => fetch(base + '/api/availability', { headers: { Cookie: cookie } });
async function friend() {
  const invite = store.createInvite('fixture');
  const res = await post('/api/invite/redeem', { code: invite.code });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
beforeEach(async () => {
  offline = false; probePaths = []; delayProbe = undefined;
  models = createServer(async (req, res) => {
    probePaths.push(req.url!); await delayProbe?.();
    res.writeHead(offline ? 503 : 200); res.end('{}');
  });
  modelBase = await listen(models);
  config = loadTokenServerConfig({ LIVEKIT_URL: 'ws://127.0.0.1:1', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'fixture',
    APP_ORIGIN: 'http://localhost', INVITE_DB_PATH: ':memory:', CLOUD_MODEL_CHECKS: 'true', CLOUD_MODEL_CHECK_CACHE_MS: '0', CLOUD_MODEL_CHECK_TIMEOUT_MS: '100',
    ASR_URL: modelBase + '/asr', LLM_BASE_URL: modelBase + '/llm/v1/', TTS_FASTAPI_URL: modelBase + '/tts' });
  vi.mocked(loadCharacters).mockReturnValue(new CharacterCatalog([{ id: 'fixture', name: 'Fixture', description: 'test', voice: 'test', tts: { speed: 1 }, ttsBackends: ['gradio', 'fastapi'], ambience: false, instructions: 'Synthetic test only.' }], 'fixture'));
  store = new AccessStore(':memory:');
  api = createTokenServer(config, undefined, new AccessController(store, config.access, { participants: async () => [], close: async () => {} }));
  base = await listen(api);
});
afterEach(async () => {
  await Promise.all([api, models].map(s => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); })));
  store.close();
});

describe('cloud admission and maintenance boundary', () => {
  it('keeps private ops authenticated and public availability authenticated', async () => {
    expect((await fetch(base + '/internal/ops/status')).status).toBe(401);
    expect((await post('/internal/ops/maintenance', { enabled: true })).status).toBe(401);
    expect((await availability('')).status).toBe(401);
    expect((await post('/internal/ops/maintenance', { enabled: 'true' }, '', true)).status).toBe(400);
    expect(await status()).toEqual({ maintenance: false, activeCount: 0, modelsReady: true });
    expect(probePaths.sort()).toEqual(['/asr/health', '/llm/health', '/tts/health']);
  });
  it('leaves verification and existing calls usable while offline, but rejects new tokens server-side', async () => {
    const cookie = await friend();
    const existing = await (await post('/api/token', { requestId: randomUUID() }, cookie)).json() as { attemptId: string };
    store.admit(existing.attemptId, 'agent');
    offline = true;
    const another = await friend(); // Invitation verification does not depend on model readiness.
    expect(await (await availability(another)).json()).toEqual({ available: false, reason: 'models_unavailable' });
    const rejected = await post('/api/token', { requestId: randomUUID() }, another);
    expect(rejected.status).toBe(503); expect(await rejected.json()).toEqual({ code: 'models_unavailable' });
    expect(store.heartbeat(existing.attemptId, 'agent')).toBe(true);
    store.cancel(existing.attemptId); store.finish(existing.attemptId, 'agent');
    expect((await status()).activeCount).toBe(0);
    offline = false;
    expect(await (await availability(another)).json()).toEqual({ available: true });
    expect((await post('/api/token', { requestId: randomUUID() }, another)).status).toBe(200);
  });
  it('counts all draining phases and refuses new calls until explicitly reopened', async () => {
    const cookies = await Promise.all([friend(), friend(), friend()]);
    const attempts = await Promise.all(cookies.map(async cookie => (await (await post('/api/token', { requestId: randomUUID() }, cookie)).json() as { attemptId: string }).attemptId));
    store.admit(attempts[1]!, 'agent1'); store.admit(attempts[2]!, 'agent2'); store.cancel(attempts[2]!);
    expect(await (await post('/internal/ops/maintenance', { enabled: true }, '', true)).json()).toEqual({ maintenance: true, activeCount: 3, modelsReady: true });
    const newCookie = await friend();
    expect(await (await availability(newCookie)).json()).toEqual({ available: false, reason: 'maintenance' });
    const blocked = await post('/api/token', { requestId: randomUUID() }, newCookie);
    expect(blocked.status).toBe(503); expect(await blocked.json()).toEqual({ code: 'maintenance' });
    store.cancel(attempts[0]!); store.cancel(attempts[1]!); store.finish(attempts[1]!, 'agent1');
    expect((await status()).activeCount).toBe(1);
    store.finish(attempts[2]!, 'agent2');
    expect(await status()).toEqual({ maintenance: true, activeCount: 0, modelsReady: true });
    await post('/internal/ops/maintenance', { enabled: false }, '', true);
    expect((await post('/api/token', { requestId: randomUUID() }, newCookie)).status).toBe(200);
  });
  it('rechecks maintenance inside reservation after an in-flight readiness probe', async () => {
    const cookie = await friend();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    delayProbe = () => held;
    const pending = post('/api/token', { requestId: randomUUID() }, cookie);
    await vi.waitFor(() => expect(probePaths.length).toBe(3));
    store.setMaintenance(true); release();
    const res = await pending;
    expect(res.status).toBe(503); expect(await res.json()).toEqual({ code: 'maintenance' });
    expect(store.active()).toEqual([]);
  });
  it('times out unreachable health requests and never probes by default', async () => {
    const request = vi.fn<typeof fetch>();
    const disabled = new ModelAvailability(loadModelChecksConfig({}), request);
    expect(await disabled.ready()).toBe(true); expect(request).not.toHaveBeenCalled();
    delayProbe = () => new Promise(resolve => setTimeout(resolve, 250));
    const cookie = await friend();
    expect(await (await availability(cookie)).json()).toEqual({ available: false, reason: 'models_unavailable' });
    expect(loadAgentHealthConfig({})).toEqual({ host: '127.0.0.1', port: 8081 });
    expect(() => loadAgentHealthConfig({ AGENT_HEALTH_PORT: 'bad' })).toThrow();
  });
  it('does not probe hosted OpenRouter ASR, LLM or TTS', () => {
    const urls = (asr?: string) =>
      loadModelChecksConfig({ ASR_URL: asr, LLM_BASE_URL: 'https://openrouter.ai/api/v1', TTS_BACKEND: 'openrouter' }).urls;
    expect(urls()).toEqual(['http://127.0.0.1:8001/health']);
    expect(urls('https://openrouter.ai/api')).toEqual([]);
  });
  it('shares in-flight probes and bounds cached readiness', async () => {
    let now = 1;
    const health = new ModelAvailability({ ...config.modelChecks, cacheMs: 3000 }, fetch, () => now);
    expect(await Promise.all([health.ready(), health.ready()])).toEqual([true, true]);
    expect(probePaths).toHaveLength(3);
    offline = true;
    expect(await health.ready()).toBe(true); expect(probePaths).toHaveLength(3);
    now += 3000;
    expect(await health.ready()).toBe(false); expect(probePaths).toHaveLength(6);
  });
});

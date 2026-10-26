import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { CharacterCatalog, loadCharacters } from './characters.js';
import { loadTokenServerConfig } from './config.js';
import { createTokenServer } from './token-server.js';
import { randomUUID } from 'node:crypto';
import { AccessStore } from './access/store.js';
import { AccessController } from './access/controller.js';

vi.mock('./characters.js', async (original) => ({
  ...await original<typeof import('./characters.js')>(), loadCharacters: vi.fn(),
}));

describe('character link HTTP flow', () => {
  const config = loadTokenServerConfig({ LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'test-secret', INVITE_DB_PATH: ':memory:', APP_ORIGIN: 'http://localhost' });
  let store: AccessStore;
  let cookie: string;
  let requestId: string;
  let server: ReturnType<typeof createTokenServer>;
  let base: string;
  const catalog = (ids: string[]) => new CharacterCatalog(ids.map((id) => ({
    id, name: id, description: 'test', voice: 'test', tts: { speed: 1 }, ttsBackends: ['gradio', 'fastapi'], ambience: false, instructions: 'Test fixture only.',
  })), 'a');
  const post = (path: string, body: object) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.access.origin, Cookie: cookie },
    body: JSON.stringify(path === '/api/token' ? { ...body, requestId: requestId = randomUUID() } : body),
  });
  const get = (url: string) => fetch(url, { headers: { Cookie: cookie } });
  const generate = async () => {
    const res = await post('/api/character-link', { character: 'b' });
    expect(res.status).toBe(200);
    return (await res.json() as { characterLink: string }).characterLink;
  };

  beforeEach(async () => {
    vi.mocked(loadCharacters).mockReturnValue(catalog(['a', 'b']));
    store = new AccessStore(':memory:');
    const invite = store.createInvite('test');
    cookie = 'ptoy_session=' + store.redeem(invite.code, 'fixture').token;
    server = createTokenServer(config, undefined, new AccessController(store, config.access, { participants: async () => [], close: async () => {} }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  it('generates a link, resolves only its character and signs that character into the call', async () => {
    const characterLink = await generate();
    const fixed = await get(`${base}/api/characters?characterLink=${characterLink}`);
    expect(await fixed.json()).toEqual({ defaultId: 'b', characters: [{ id: 'b', name: 'b', description: 'test' }] });
    const response = await post('/api/token', { characterLink });
    const body = await response.json() as { participantToken: string };
    const claims = await new TokenVerifier(config.livekitApiKey, config.livekitApiSecret).verify(body.participantToken);
    expect(claims.attributes?.['ptoy.character']).toBe('b');
    expect((await post('/api/token', { characterLink, character: 'a' })).status).toBe(400);
  });

  it('rejects invalid, empty, repeated and removed links without issuing a default token', async () => {
    const characterLink = await generate();
    for (const invalid of ['', 'bad', characterLink + 'x']) {
      expect((await get(`${base}/api/characters?characterLink=${invalid}`)).status).toBe(400);
      expect((await post('/api/token', { characterLink: invalid })).status).toBe(400);
    }
    expect((await get(`${base}/api/characters?characterLink=${characterLink}&characterLink=${characterLink}`)).status).toBe(400);
    vi.mocked(loadCharacters).mockReturnValue(catalog(['a']));
    expect((await get(`${base}/api/characters?characterLink=${characterLink}`)).status).toBe(400);
    expect((await post('/api/token', { characterLink })).status).toBe(400);
    expect((await post('/api/character-link', { character: 'missing' })).status).toBe(400);
  });

  it('preserves homepage selection and default calls', async () => {
    expect((await (await get(`${base}/api/characters`)).json() as { characters: unknown[] }).characters).toHaveLength(2);
    for (const [body, expected] of [[{}, 'a'], [{ character: 'b' }, 'b']] as const) {
      const res = await post('/api/token', body);
      const jwt = (await res.json() as { participantToken: string }).participantToken;
      const claims = await new TokenVerifier(config.livekitApiKey, config.livekitApiSecret).verify(jwt);
      expect(claims.attributes?.['ptoy.character']).toBe(expected);
      await post('/api/calls/cancel', { requestId });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ParticipantInfo_State } from 'livekit-server-sdk';
import { CharacterCatalog, loadCharacters } from '../characters.js';
import { loadTokenServerConfig } from '../config.js';
import { createTokenServer } from '../token-server.js';
import { AccessStore } from './store.js';
import { AccessController } from './controller.js';

vi.mock('../characters.js', async original => ({ ...await original<typeof import('../characters.js')>(), loadCharacters: vi.fn() }));
const config = loadTokenServerConfig({ LIVEKIT_URL: 'ws://localhost:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'fixture', INVITE_DB_PATH: ':memory:', APP_ORIGIN: 'https://app.example.test' });
let store: AccessStore; let server: ReturnType<typeof createTokenServer>; let base: string;
let participants: { identity: string; state: number }[];
const post = (path: string, body: unknown, cookie = '', origin = config.access.origin, secret?: string) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, ...(secret ? { Authorization: 'Bearer ' + secret } : {}) }, body: JSON.stringify(body),
});
const get = (path: string, cookie = '') => fetch(base + path, { headers: { Cookie: cookie } });
async function redeem(code: string) {
  const res = await post('/api/invite/redeem', { code });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
beforeEach(async () => {
  vi.mocked(loadCharacters).mockReturnValue(new CharacterCatalog([{ id: 'fixture', name: 'Fixture', description: 'test', voice: 'test', tts: { speed: 1 }, ttsBackends: ['gradio', 'fastapi'], instructions: 'Synthetic test only.' }], 'fixture'));
  store = new AccessStore(':memory:'); participants = [];
  server = createTokenServer(config, undefined, new AccessController(store, config.access, { participants: async () => participants, close: async () => { participants = []; } }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });

describe('invitation HTTP boundary', () => {
  it('protects all resource routes before reading roles and sets a fixed secure HttpOnly cookie', async () => {
    vi.mocked(loadCharacters).mockClear();
    expect((await get('/healthz')).status).toBe(200);
    expect(await (await get('/api/session')).json()).toEqual({ authenticated: false, code: 'unauthorized' });
    expect((await get('/api/characters')).status).toBe(401);
    expect((await post('/api/token', { requestId: randomUUID() })).status).toBe(401);
    expect((await post('/api/character-link', { character: 'fixture' })).status).toBe(401);
    expect(loadCharacters).not.toHaveBeenCalled();
    const invite = store.createInvite('friend'); const result = await post('/api/invite/redeem', { code: invite.code.toLowerCase().replaceAll('-', ' ') });
    const setCookie = result.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('Secure'); expect(setCookie).toContain('SameSite=Lax'); expect(setCookie).toContain('Max-Age=2592000');
    const cookie = setCookie.split(';')[0]!;
    expect((await get('/api/characters', cookie)).status).toBe(200);
    const session = await (await get('/api/session', cookie)).json();
    expect(await (await get('/api/session', cookie)).json()).toEqual(session);
  });
  it('rejects cross-origin writes, empty Origin and untrusted internal callers', async () => {
    expect((await post('/api/invite/redeem', { code: 'anything' }, '', 'https://other.test')).status).toBe(403);
    expect((await post('/api/invite/redeem', { code: 'anything' }, '', '')).status).toBe(403);
    expect((await post('/internal/access/admit', { room: 'x', participant: 'x', agentId: 'x' })).status).toBe(401);
  });
  it('handles repeat verification, per-browser logout, revoke and failure throttling', async () => {
    const invite = store.createInvite('friend'); const first = await redeem(invite.code); const second = await redeem(invite.code);
    expect((await post('/api/logout', {}, first)).headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get('/api/characters', first)).status).toBe(401); expect((await get('/api/characters', second)).status).toBe(200);
    store.revokeInvite(invite.id); expect((await get('/api/characters', second)).status).toBe(403);
    expect((await post('/api/invite/redeem', { code: invite.code })).status).toBe(403);
    for (let i=0; i<9; i++) await post('/api/invite/redeem', { code: 'wrong' });
    const limited = await post('/api/invite/redeem', { code: 'wrong' }); expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
  });
  it('enforces concurrent reservations, lost-response retries and cancellation tombstones', async () => {
    const invite = store.createInvite('friend'); const first = await redeem(invite.code); const second = await redeem(invite.code);
    const requestId = randomUUID();
    const responses = await Promise.all([post('/api/token', { requestId }, first), post('/api/token', { requestId: randomUUID() }, second)]);
    expect(responses.map(r => r.status).sort()).toEqual([200,409]);
    const winner = responses.findIndex(r=>r.status===200); const cookie = winner===0 ? first:second;
    const token = await responses[winner]!.json() as { attemptId: string };
    if (winner===0) expect((await (await post('/api/token', { requestId }, first)).json() as { attemptId: string }).attemptId).toBe(token.attemptId);
    expect((await get('/api/calls/' + token.attemptId, winner===0?second:first)).status).toBe(401);
    const a=store.attempt(token.attemptId)!;
    await post('/api/calls/cancel',{requestId:a.requestId},cookie);
    expect((await post('/api/token',{requestId:a.requestId},cookie)).status).toBe(409);
    const cancelledId=randomUUID(); await post('/api/calls/cancel',{requestId:cancelledId},cookie);
    expect((await post('/api/token',{requestId:cancelledId},cookie)).status).toBe(409);
    expect((await post('/api/token',{requestId:randomUUID()},cookie)).status).toBe(200);
  });
  it('only admits ready bound participants; revoke preserves admitted call and ending is fenced', async () => {
    const invite=store.createInvite('friend'); const cookie=await redeem(invite.code); const requestId=randomUUID();
    const token=await (await post('/api/token',{requestId},cookie)).json() as {attemptId:string;roomName:string;participantName:string};
    const identity={room:token.roomName,participant:token.participantName,agentId:'agent-test'};
    expect((await post('/internal/access/admit',identity,'','',config.access.internalSecret)).status).toBe(409);
    participants=[{identity:token.participantName,state:ParticipantInfo_State.ACTIVE},{identity:'agent-test',state:ParticipantInfo_State.ACTIVE}];
    expect((await post('/internal/access/admit',identity,'','',config.access.internalSecret)).status).toBe(200);
    store.revokeInvite(invite.id);
    expect(await (await get('/api/calls/'+token.attemptId,cookie)).json()).toMatchObject({state:'established'});
    expect(await (await post('/internal/access/heartbeat',identity,'','',config.access.internalSecret)).json()).toEqual({active:true});
    await post('/api/calls/cancel',{requestId},cookie);
    expect(await (await post('/internal/access/heartbeat',identity,'','',config.access.internalSecret)).json()).toEqual({active:false});
    expect((await post('/internal/access/admit',identity,'','',config.access.internalSecret)).status).toBe(409);
    expect((await post('/internal/access/finish',identity,'','',config.access.internalSecret)).status).toBe(200);
    expect((await get('/api/calls/'+token.attemptId,cookie)).status).toBe(200);
    expect((await post('/api/token',{requestId:randomUUID()},cookie)).status).toBe(403);
  });
  it('scopes control credentials to an existing attempt after the browser cookie expires', async () => {
    const invitation=store.createInvite('friend'); const cookie=await redeem(invitation.code); const requestId=randomUUID();
    const token=await (await post('/api/token',{requestId},cookie)).json() as {attemptId:string;controlToken:string};
    store.admit(token.attemptId,'agent');
    const authorization='Call '+token.controlToken;
    expect((await fetch(base+'/api/calls/'+token.attemptId,{headers:{Authorization:authorization}})).status).toBe(200);
    const other=startOther();
    function startOther() { const i=store.createInvite('other'); const s=store.session(store.redeem(i.code,'other').token); return store.reserve(s,randomUUID(),'fixture'); }
    expect((await fetch(base+'/api/calls/'+other.id,{headers:{Authorization:authorization}})).status).toBe(401);
    expect((await fetch(base+'/api/token',{method:'POST',headers:{Authorization:authorization,Origin:config.access.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID()})})).status).toBe(401);
    expect((await fetch(base+'/api/calls/cancel',{method:'POST',headers:{Authorization:authorization,Origin:config.access.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId,attemptId:token.attemptId})})).status).toBe(200);
    expect(store.attempt(token.attemptId)?.state).toBe('ending'); expect(store.attempt(other.id)?.state).toBe('connecting');
  });
});

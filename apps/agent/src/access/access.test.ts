import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessStore, SESSION_MS } from './store.js';
import { AccessController, type RoomGateway } from './controller.js';
import { loadAccessConfig } from './config.js';
import { ParticipantInfo_State } from 'livekit-server-sdk';

let store: AccessStore; let now: number; let directory: string;
beforeEach(() => { now = 1000000; directory = mkdtempSync(join(tmpdir(), 'ptoy-access-')); store = new AccessStore(join(directory, 'access.sqlite'), () => now); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
const issue = () => { const invite = store.createInvite('friend'); const redemption = store.redeem(invite.code.toLowerCase().replaceAll('-', ' '), 'test'); return { invite, token: redemption.token!, session: store.session(redemption.token) }; };
const start = () => { const friend = issue(); return { ...friend, a: store.reserve(friend.session, randomUUID(), 'fixture') }; };

describe('persistent invitation behavior', () => {
  it('persists maintenance across API/CLI restarts and applies its default only once', () => {
    const { session } = issue();
    store.setMaintenance(true);
    store.close(); store = new AccessStore(join(directory, 'access.sqlite'), () => now, false);
    expect(store.opsStatus()).toEqual({ maintenance: true, activeCount: 0 });
    expect(() => store.reserve(session, randomUUID(), 'fixture')).toThrow('maintenance');
    store.setMaintenance(false);
    store.close(); store = new AccessStore(join(directory, 'access.sqlite'), () => now, true);
    expect(store.maintenance()).toBe(false);
    expect(store.reserve(session, randomUUID(), 'fixture').state).toBe('connecting');
    const initial = new AccessStore(':memory:', () => now, true);
    try { expect(initial.maintenance()).toBe(true); } finally { initial.close(); }
  });
  it('remembers a normalized reusable code across restart without extending the fixed session expiry', () => {
    const { invite, token, session } = issue();
    expect(store.listInvites()[0]).not.toHaveProperty('hash');
    now += 10000; expect(store.session(token).expiresAt).toBe(session.expiresAt);
    store.close(); store = new AccessStore(join(directory, 'access.sqlite'), () => now);
    expect(store.session(token).inviteId).toBe(invite.id);
    expect(store.redeem(invite.code, 'another-device').token).toBeTruthy();
    now = session.expiresAt; expect(() => store.session(token)).toThrow('unauthorized');
    expect(store.redeem(invite.code, 'after-expiry').expiresAt).toBe(now + SESSION_MS);
  });
  it('logout only invalidates one browser and revoke invalidates all browsers', () => {
    const { invite, token } = issue(); const second = store.redeem(invite.code, 'second').token!;
    store.logout(token); expect(() => store.session(token)).toThrow('unauthorized'); expect(store.session(second)).toBeTruthy();
    store.revokeInvite(invite.id); expect(() => store.session(second)).toThrow('revoked'); expect(store.redeem(invite.code, 'third').error?.code).toBe('revoked');
  });
  it('rate limits failed guesses persistently and permits retry after the window', () => {
    for (let i = 0; i < 10; i++) expect(store.redeem('bad', 'ip').error?.code).toBe('invalid_invite');
    expect(store.redeem('another', 'ip').error?.code).toBe('rate_limited');
    now += 60000; expect(store.redeem('bad', 'ip').error?.code).toBe('invalid_invite');
  });
});

describe('one call per invitation', () => {
  it('rejects a second browser but reuses an idempotent request and fences changed roles', () => {
    const { invite, session, a } = start();
    expect(store.reserve(session, a.requestId, 'fixture').id).toBe(a.id);
    expect(() => store.reserve(session, a.requestId, 'other')).toThrow('attempt_mismatch');
    const second = store.session(store.redeem(invite.code, 'other').token);
    expect(() => store.reserve(second, randomUUID(), 'fixture')).toThrow('busy');
  });
  it('cancellation before the token request creates a tombstone and late requests cannot start', () => {
    const { session, token } = issue(); const requestId = randomUUID();
    store.cancelRequest(requestId, token);
    expect(() => store.reserve(session, requestId, 'fixture')).toThrow('attempt_ended');
  });
  it('cancelled old calls never release or admit a newer call', () => {
    const { a, session } = start(); store.cancel(a.id);
    const next = store.reserve(session, randomUUID(), 'fixture'); store.finish(a.id);
    expect(() => store.admit(a.id, 'agent')).toThrow('attempt_ended');
    expect(() => store.reserve(session, randomUUID(), 'fixture')).toThrow('busy');
    expect(store.attempt(next.id)?.state).toBe('connecting');
  });
  it('revocation before admission rejects; revocation after admission permits only that established call', () => {
    const first = start(); store.revokeInvite(first.invite.id);
    expect(() => store.admit(first.a.id, 'agent')).toThrow('attempt_ended');
    const second = start(); store.admit(second.a.id, 'agent'); store.revokeInvite(second.invite.id);
    expect(store.admit(second.a.id, 'agent').state).toBe('established');
    expect(store.heartbeat(second.a.id, 'agent')).toBe(true);
    expect(() => store.admit(second.a.id, 'different-agent')).toThrow('busy');
  });
  it('expiry blocks pending admission but does not terminate an established call', () => {
    const first = start(); const second = start(); store.admit(second.a.id, 'agent'); now += SESSION_MS;
    expect(() => store.admit(first.a.id, 'agent')).toThrow('unauthorized');
    expect(store.heartbeat(second.a.id, 'agent')).toBe(true);
    store.cancelRequest(second.a.requestId, second.token); expect(store.heartbeat(second.a.id, 'agent')).toBe(false);
    store.finish(second.a.id, 'agent'); expect(store.attempt(second.a.id)?.state).toBe('ended');
  });
  it('does not allow an established browser to log out before hangup', () => {
    const { a, token } = start(); store.admit(a.id, 'agent');
    expect(() => store.logout(token)).toThrow('busy'); store.finish(a.id, 'agent'); store.logout(token);
    expect(() => store.session(token)).toThrow('unauthorized');
  });
});

describe('server readiness and recovery', () => {
  const config = loadAccessConfig({ LIVEKIT_API_SECRET: 'test', INVITE_DB_PATH: ':memory:' });
  it('closes the race when revocation happens during the media readiness query', async () => {
    const { a, invite } = start();
    const rooms: RoomGateway = { close: async () => {}, participants: async () => { store.revokeInvite(invite.id); return [{ identity: a.participant, state: ParticipantInfo_State.ACTIVE }, { identity: 'agent', state: ParticipantInfo_State.ACTIVE }]; } };
    await expect(new AccessController(store, config, rooms, () => now).admit(a.room, a.participant, 'agent')).rejects.toThrow('attempt_ended');
  });
  it('waits for media ACTIVE for both caller and agent', async () => {
    const { a } = start(); const rooms: RoomGateway = { close: async () => {}, participants: async () => [{ identity: a.participant, state: ParticipantInfo_State.JOINED }] };
    await expect(new AccessController(store, config, rooms, () => now).admit(a.room, a.participant, 'agent')).rejects.toThrow('not_ready');
  });
  it('expires never-admitted attempts but holds established calls on unknown LiveKit state', async () => {
    const first = start(); const second = start(); store.admit(second.a.id, 'agent');
    const rooms: RoomGateway = { close: async () => {}, participants: async () => { throw new Error('offline'); } };
    const controller = new AccessController(store, config, rooms, () => now);
    now += config.pendingTimeoutMs + 1; await controller.reconcile();
    expect(store.attempt(first.a.id)?.state).toBe('ended'); expect(store.attempt(second.a.id)?.state).toBe('established');
  });
  it('retains reconnecting rooms, recovers crashed Agents and ignores stale query evidence', async () => {
    const { a } = start(); store.admit(a.id, 'agent');
    let participants = [{ identity: a.participant, state: ParticipantInfo_State.ACTIVE }, { identity: 'agent', state: ParticipantInfo_State.ACTIVE }];
    const rooms: RoomGateway = { participants: async () => participants, close: async () => { participants = []; } };
    const controller = new AccessController(store, config, rooms, () => now);
    now += config.agentTimeoutMs + 1;
    await controller.reconcile(); expect(store.attempt(a.id)?.state).toBe('established');
    participants = participants.filter(p => p.identity !== 'agent'); await controller.reconcile(); expect(store.attempt(a.id)?.state).toBe('ended');
    const next = start(); store.admit(next.a.id, 'agent2'); now += config.agentTimeoutMs + 1;
    rooms.participants = async () => { store.heartbeat(next.a.id, 'agent2'); return []; };
    await controller.reconcile(); expect(store.attempt(next.a.id)?.state).toBe('established');
  });
  it('keeps a slow cleanup leased while refusing continued pipeline work', async () => {
    const { a } = start(); store.admit(a.id, 'agent'); store.cancel(a.id);
    const rooms: RoomGateway = { close: async () => {}, participants: async () => [] };
    const controller = new AccessController(store, config, rooms, () => now);
    now += config.agentTimeoutMs + 1;
    expect(store.heartbeat(a.id, 'agent')).toBe(false);
    await controller.reconcile(); expect(store.attempt(a.id)?.state).toBe('ending');
    store.finish(a.id, 'agent'); expect(store.attempt(a.id)?.state).toBe('ended');
  });
  it('lets surviving Agents renew after an API restart before reclaiming stale persisted occupancy', async () => {
    const { a } = start(); store.admit(a.id, 'agent'); store.cancel(a.id);
    now += config.agentTimeoutMs * 2;
    const rooms: RoomGateway = { close: async () => {}, participants: async () => [] };
    const restarted = new AccessController(store, config, rooms, () => now);
    await restarted.reconcile(); expect(store.attempt(a.id)?.state).toBe('ending');
    now += 3000; store.heartbeat(a.id, 'agent'); now += config.agentTimeoutMs - 3000;
    await restarted.reconcile(); expect(store.attempt(a.id)?.state).toBe('ending');
  });
});

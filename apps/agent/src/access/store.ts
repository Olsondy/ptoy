import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export type AccessCode = 'invalid_invite' | 'revoked' | 'unauthorized' | 'busy' | 'attempt_ended' | 'attempt_mismatch' | 'not_ready' | 'rate_limited' | 'maintenance' | 'models_unavailable';
export class AccessError extends Error {
  constructor(readonly code: AccessCode, readonly status = 401) { super(code); }
}
export interface Session { hash: string; inviteId: string; expiresAt: number }
export interface Attempt {
  id: string; requestId: string; sessionHash: string; inviteId: string; character: string;
  room: string; participant: string; state: 'connecting' | 'established' | 'ending' | 'ended';
  createdAt: number; updatedAt: number; admittedAt: number | null; agentId: string | null; heartbeatAt: number | null;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const normalizeInvite = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');

/** One authoritative SQLite transaction boundary for issuance, revocation and admission. */
export class AccessStore {
  readonly db: DatabaseSync;
  constructor(path: string, private readonly clock: () => number = Date.now, maintenanceDefault = false) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, note TEXT NOT NULL, createdAt INTEGER NOT NULL, revokedAt INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, inviteId TEXT NOT NULL REFERENCES invites(id), expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(
        id TEXT PRIMARY KEY, requestId TEXT NOT NULL, sessionHash TEXT NOT NULL REFERENCES sessions(hash), inviteId TEXT NOT NULL REFERENCES invites(id),
        character TEXT NOT NULL, room TEXT UNIQUE NOT NULL, participant TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('connecting','established','ending','ended')),
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, admittedAt INTEGER, agentId TEXT, heartbeatAt INTEGER,
        UNIQUE(sessionHash, requestId));
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON attempts(inviteId) WHERE state <> 'ended';
      CREATE TABLE IF NOT EXISTS cancellations(sessionHash TEXT NOT NULL,requestId TEXT NOT NULL,PRIMARY KEY(sessionHash,requestId));
      CREATE TABLE IF NOT EXISTS failures(key TEXT PRIMARY KEY, count INTEGER NOT NULL, untilAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES('maintenance',?)").run(Number(maintenanceDefault));
  }
  close() { this.db.close(); }
  maintenance() { return (this.db.prepare("SELECT value FROM settings WHERE key='maintenance'").get() as { value: number }).value === 1; }
  setMaintenance(enabled: boolean) {
    this.db.prepare("UPDATE settings SET value=? WHERE key='maintenance'").run(Number(enabled));
  }
  opsStatus() {
    const row = this.db.prepare("SELECT (SELECT value FROM settings WHERE key='maintenance') AS maintenance, COUNT(*) AS activeCount FROM attempts WHERE state<>'ended'").get() as { maintenance: number; activeCount: number };
    return { maintenance: row.maintenance === 1, activeCount: row.activeCount };
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createInvite(note: string) {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const code = Array.from(randomBytes(16), (b) => alphabet[b & 31]).join('');
    const id = randomUUID();
    this.db.prepare('INSERT INTO invites(id, hash, note, createdAt) VALUES(?,?,?,?)').run(id, digest(code), note, this.clock());
    return { id, code: code.match(/.{4}/g)!.join('-') };
  }
  listInvites() { return this.db.prepare('SELECT id,note,createdAt,revokedAt FROM invites ORDER BY createdAt').all(); }
  revokeInvite(id: string) {
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE invites SET revokedAt=COALESCE(revokedAt,?) WHERE id=?').run(this.clock(), id);
      this.db.prepare("UPDATE attempts SET state='ended',updatedAt=? WHERE inviteId=? AND state='connecting'").run(this.clock(), id);
      return result.changes > 0;
    });
  }
  redeem(code: string, ip: string) {
    return this.transaction(() => {
      const now = this.clock();
      this.db.prepare('DELETE FROM failures WHERE untilAt<=?').run(now);
      const hash = digest(normalizeInvite(code));
      const keys = ['ip:' + digest(ip), 'code:' + hash];
      for (const key of keys) {
        const row = this.db.prepare('SELECT count,untilAt FROM failures WHERE key=?').get(key) as { count: number; untilAt: number } | undefined;
        if (row && row.untilAt > now && row.count >= 10) return { error: new AccessError('rate_limited', 429) };
      }
      const invite = this.db.prepare('SELECT id,revokedAt FROM invites WHERE hash=?').get(hash) as { id: string; revokedAt: number | null } | undefined;
      if (!invite || invite.revokedAt !== null) {
        for (const key of keys) this.db.prepare(`INSERT INTO failures VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
          count=CASE WHEN untilAt<=? THEN 1 ELSE count+1 END, untilAt=CASE WHEN untilAt<=? THEN excluded.untilAt ELSE untilAt END`).run(key, now + 60000, now, now);
        return { error: new AccessError(invite ? 'revoked' : 'invalid_invite', invite ? 403 : 401) };
      }
      const token = randomBytes(32).toString('base64url');
      const expiresAt = now + SESSION_MS;
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), invite.id, expiresAt);
      return { token, expiresAt };
    });
  }
  session(token?: string): Session {
    if (!token) throw new AccessError('unauthorized');
    return this.sessionByHash(digest(token));
  }
  private sessionByHash(hash: string): Session {
    const row = this.db.prepare(`SELECT sessions.hash,inviteId,expiresAt,revokedAt FROM sessions JOIN invites ON invites.id=sessions.inviteId WHERE sessions.hash=?`).get(hash) as Session & { revokedAt: number | null } | undefined;
    if (!row || row.expiresAt <= this.clock()) throw new AccessError('unauthorized');
    if (row.revokedAt !== null) throw new AccessError('revoked', 403);
    return { hash: row.hash, inviteId: row.inviteId, expiresAt: row.expiresAt };
  }
  logout(token?: string) {
    if (!token) return;
    this.transaction(() => {
      const hash = digest(token);
      if (this.db.prepare("SELECT id FROM attempts WHERE sessionHash=? AND state IN ('established','ending')").get(hash)) throw new AccessError('busy', 409);
      this.db.prepare("UPDATE attempts SET state='ended',updatedAt=? WHERE sessionHash=? AND state='connecting'").run(this.clock(), hash);
      this.db.prepare('UPDATE sessions SET expiresAt=0 WHERE hash=?').run(hash);
    });
  }
  reserve(session: Session, requestId: string, character: string): Attempt {
    return this.transaction(() => {
      this.sessionByHash(session.hash);
      if (this.db.prepare('SELECT 1 FROM cancellations WHERE sessionHash=? AND requestId=?').get(session.hash, requestId)) throw new AccessError('attempt_ended', 409);
      const existing = this.db.prepare('SELECT * FROM attempts WHERE sessionHash=? AND requestId=?').get(session.hash, requestId) as Attempt | undefined;
      if (existing) {
        if (existing.state !== 'connecting') throw new AccessError('attempt_ended', 409);
        if (existing.character !== character) throw new AccessError('attempt_mismatch', 409);
        return existing;
      }
      if (this.maintenance()) throw new AccessError('maintenance', 503);
      if (this.db.prepare("SELECT id FROM attempts WHERE inviteId=? AND state<>'ended'").get(session.inviteId)) throw new AccessError('busy', 409);
      const id = randomUUID(); const now = this.clock();
      this.db.prepare(`INSERT INTO attempts(id,requestId,sessionHash,inviteId,character,room,participant,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'connecting',?,?)`)
        .run(id, requestId, session.hash, session.inviteId, character, 'call-' + id, 'user-' + id, now, now);
      return this.attempt(id)!;
    });
  }
  attempt(id: string) { return this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as Attempt | undefined; }
  byRoom(room: string) { return this.db.prepare('SELECT * FROM attempts WHERE room=?').get(room) as Attempt | undefined; }
  active() { return this.db.prepare("SELECT * FROM attempts WHERE state<>'ended'").all() as unknown as Attempt[]; }
  ownedAttempt(id: string, token?: string) {
    const a = this.attempt(id);
    // Ownership only: expired/revoked sessions may finish their existing call, never create one.
    if (!a || !token || a.sessionHash !== digest(token)) throw new AccessError('unauthorized');
    return a;
  }
  admit(id: string, agentId: string) {
    return this.transaction(() => {
      const a = this.attempt(id);
      if (!a || (a.state !== 'connecting' && a.state !== 'established')) throw new AccessError('attempt_ended', 409);
      if (a.state === 'established') {
        if (a.agentId !== agentId) throw new AccessError('busy', 409);
        return a;
      }
      this.sessionByHash(a.sessionHash);
      const now = this.clock();
      this.db.prepare("UPDATE attempts SET state='established',admittedAt=?,updatedAt=?,heartbeatAt=?,agentId=? WHERE id=?").run(now, now, now, agentId, id);
      return this.attempt(id)!;
    });
  }
  cancel(id: string) {
    this.db.prepare("UPDATE attempts SET state=CASE WHEN state='connecting' THEN 'ended' ELSE 'ending' END,updatedAt=? WHERE id=? AND state IN ('connecting','established')").run(this.clock(), id);
  }
  cancelRequest(requestId: string, token?: string) {
    if (!token) throw new AccessError('unauthorized');
    const hash = digest(token);
    if (!this.db.prepare('SELECT 1 FROM sessions WHERE hash=?').get(hash)) throw new AccessError('unauthorized');
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO cancellations VALUES(?,?)').run(hash, requestId);
      const a = this.db.prepare('SELECT id FROM attempts WHERE sessionHash=? AND requestId=?').get(hash, requestId) as { id: string } | undefined;
      if (a) this.cancel(a.id);
    });
  }
  expirePending(id: string, before: number) {
    this.db.prepare("UPDATE attempts SET state='ended',updatedAt=? WHERE id=? AND state='connecting' AND createdAt<=?").run(this.clock(), id, before);
  }
  finishStale(id: string, before: number) {
    this.db.prepare("UPDATE attempts SET state='ended',updatedAt=? WHERE id=? AND state IN ('established','ending') AND heartbeatAt<=?").run(this.clock(), id, before);
  }
  markStaleEnding(id: string, before: number) {
    return this.db.prepare("UPDATE attempts SET state='ending',updatedAt=? WHERE id=? AND state IN ('established','ending') AND heartbeatAt<=?").run(this.clock(), id, before).changes > 0;
  }
  heartbeat(id: string, agentId: string) {
    // Cleanup still owns the slot. An ending heartbeat renews it without granting permission
    // to continue the pipeline; it prevents a slow cleanup being mistaken for a dead process.
    const result = this.db.prepare("UPDATE attempts SET heartbeatAt=? WHERE id=? AND agentId=? AND state IN ('established','ending') RETURNING state")
      .get(this.clock(), id, agentId) as { state: string } | undefined;
    return result?.state === 'established';
  }
  finish(id: string, agentId?: string) {
    const a = this.attempt(id);
    if (!a || (agentId !== undefined && a.agentId !== agentId)) throw new AccessError('attempt_mismatch', 409);
    this.db.prepare("UPDATE attempts SET state='ended',updatedAt=? WHERE id=?").run(this.clock(), id);
  }
}

import { ParticipantInfo_State, RoomServiceClient } from 'livekit-server-sdk';
import type { AccessConfig } from './config.js';
import { AccessError, AccessStore } from './store.js';

export interface RoomGateway {
  participants(room: string): Promise<readonly { identity: string; state: number }[]>;
  close(room: string): Promise<void>;
}
export function livekitGateway(url: string, key: string, secret: string): RoomGateway {
  const client = new RoomServiceClient(url.replace(/^ws/, 'http'), key, secret, { requestTimeout: 5 });
  return {
    async participants(room) {
      if (!(await client.listRooms([room])).length) return [];
      // If the room disappears between queries, fail this pass conservatively and retry.
      return client.listParticipants(room);
    },
    async close(room) { await client.deleteRoom(room); },
  };
}

export class AccessController {
  private reconciling = false;
  private readonly recoverAfter: number;
  constructor(readonly store: AccessStore, readonly config: AccessConfig, readonly rooms: RoomGateway, private readonly clock = Date.now) {
    // After an API restart give surviving Agents a full heartbeat window to report their state
    // before interpreting the persisted (possibly old) heartbeat as a process crash.
    this.recoverAfter = clock() + config.agentTimeoutMs;
  }
  async admit(room: string, participant: string, agentId: string) {
    const a = this.store.byRoom(room);
    if (!a || a.participant !== participant) throw new AccessError('attempt_mismatch', 409);
    if (a.state !== 'connecting' && a.state !== 'established') throw new AccessError('attempt_ended', 409);
    if (a.state === 'connecting' && a.createdAt + this.config.pendingTimeoutMs <= this.clock()) {
      this.store.expirePending(a.id, this.clock() - this.config.pendingTimeoutMs);
      throw new AccessError('attempt_ended', 409);
    }
    const participants = await this.rooms.participants(room);
    if (!participants.some(p => p.identity === participant && p.state === ParticipantInfo_State.ACTIVE)
      || !participants.some(p => p.identity === agentId && p.state === ParticipantInfo_State.ACTIVE)) throw new AccessError('not_ready', 409);
    // The authoritative transaction runs AFTER asynchronous readiness checks, closing revoke/cancel races.
    this.store.expirePending(a.id, this.clock() - this.config.pendingTimeoutMs);
    return this.store.admit(a.id, agentId);
  }
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const a of this.store.active()) {
        if (a.state === 'connecting') {
          this.store.expirePending(a.id, this.clock() - this.config.pendingTimeoutMs);
          continue;
        }
        if (this.clock() < this.recoverAfter) continue;
        if ((a.heartbeatAt ?? a.createdAt) + this.config.agentTimeoutMs > this.clock()) continue;
        try {
          let participants = await this.rooms.participants(a.room);
          if (participants.length && (a.state === 'ending' || !participants.some(p => p.identity === a.agentId))) {
            // A dead Agent can leave its caller in an otherwise healthy room. End that orphan
            // explicitly; merely waiting for the caller to close the browser would leak the slot.
            if (!this.store.markStaleEnding(a.id, this.clock() - this.config.agentTimeoutMs)) continue;
            await this.rooms.close(a.room);
            participants = await this.rooms.participants(a.room);
          }
          if (!participants.some(p => p.identity === a.participant || p.identity === a.agentId)) {
            this.store.finishStale(a.id, this.clock() - this.config.agentTimeoutMs);
          }
        } catch { /* Unknown is not ended: retain the slot and retry on the next pass. */ }
      }
    } finally { this.reconciling = false; }
  }
}

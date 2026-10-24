import type { AccessConfig } from './config.js';

export interface AgentAccessIdentity { room: string; participant: string; agentId: string }
export class AgentAccessClient {
  constructor(private readonly config: AccessConfig, private readonly identity: AgentAccessIdentity) {}
  async request(action: 'admit' | 'heartbeat' | 'finish') {
    const res = await fetch(new URL('/internal/access/' + action, this.config.internalUrl), {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.config.internalSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.identity), signal: AbortSignal.timeout(5000),
    });
    const body = await res.json() as { code?: string; attemptId?: string; character?: string; active?: boolean };
    return { ok: res.ok, status: res.status, ...body };
  }
  async admit(stopped: () => boolean) {
    const until = Date.now() + this.config.pendingTimeoutMs;
    while (!stopped() && Date.now() < until) {
      const result = await this.request('admit');
      if (result.ok && result.character) return result;
      if (result.code !== 'not_ready') throw new Error('call admission rejected: ' + (result.code ?? result.status));
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('call admission timed out or cancelled');
  }
}

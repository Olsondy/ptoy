/** Mirrors `TokenResponse` in apps/agent/src/token-server.ts. */
export interface CallToken {
  readonly serverUrl: string;
  readonly roomName: string;
  readonly participantName: string;
  readonly participantToken: string;
}

const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_ENDPOINT || '/api/token';

export async function fetchCallToken(signal?: AbortSignal): Promise<CallToken> {
  const res = await fetch(TOKEN_ENDPOINT, { method: 'POST', signal });
  if (!res.ok) throw new Error(`token endpoint responded ${res.status}`);
  const body = (await res.json()) as Partial<CallToken>;
  if (!body.serverUrl || !body.participantToken || !body.roomName || !body.participantName) {
    throw new Error('token endpoint returned an incomplete body');
  }
  return body as CallToken;
}

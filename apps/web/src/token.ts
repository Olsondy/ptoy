/** Mirrors the protected access/character/token API. */
export interface CallToken {
  readonly serverUrl: string;
  readonly roomName: string;
  readonly participantName: string;
  readonly participantToken: string;
  readonly attemptId: string;
  readonly controlToken: string;
}
export interface CharacterOption { readonly id: string; readonly name: string; readonly description: string }
export interface CharacterList { readonly defaultId: string; readonly characters: readonly CharacterOption[] }
export interface AccessSession { authenticated: boolean; expiresAt?: number; code?: string }
export type Availability = { available: true } | { available: false; reason: 'maintenance' | 'models_unavailable' };
export type AttemptState = 'connecting' | 'established' | 'ending' | 'ended';
const TOKEN_ENDPOINT = import.meta.env.VITE_TOKEN_ENDPOINT || '/api/token';
const apiUrl = (path: string) => new URL(path, new URL(TOKEN_ENDPOINT, window.location.href)).href;

export class InvalidCharacterLink extends Error {}
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfter = 0) { super(code); }
}
export function accessErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '暂时连不上，请检查网络后重试。';
  switch (error.code) {
    case 'invalid_invite': return '邀请码不正确，请检查后再试。';
    case 'revoked': return '这个邀请已失效，请联系邀请你的朋友。';
    case 'unauthorized': return '访问资格已到期，请重新验证邀请码。';
    case 'busy': return '此邀请码正在通话，请结束后重试。';
    case 'attempt_ended': return '这次连接已结束，请重新拨打。';
    case 'rate_limited': return '尝试次数有点多，请稍后再试。';
    case 'maintenance': return '服务维护中，请稍后再试。';
    case 'models_unavailable': return '本地模型暂时离线，请稍后再试。';
    case 'invalid_origin': return '当前访问地址未被服务允许，请联系邀请你的朋友。';
    default: return '服务暂时不可用，请稍后重试。';
  }
}
async function readResponse<T>(res: Response, invalidate = true): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { code?: string };
    const code = body.code ?? 'service_unavailable';
    if (invalidate && (code === 'unauthorized' || code === 'revoked')) {
      window.dispatchEvent(new CustomEvent('ptoy:access-invalid', { detail: code }));
    }
    throw new ApiError(code, res.status, Math.max(0, Number(res.headers.get('Retry-After')) || 0));
  }
  return res.json() as Promise<T>;
}
function post(path: string, body: unknown, signal?: AbortSignal, keepalive = false) {
  return fetch(apiUrl(path), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, keepalive });
}
export async function fetchSession(signal?: AbortSignal): Promise<AccessSession> {
  return readResponse(await fetch(apiUrl('session'), { signal, credentials: 'same-origin', cache: 'no-store' }), false);
}
export async function fetchAvailability(signal?: AbortSignal): Promise<Availability> {
  const body = await readResponse<Availability>(await fetch(apiUrl('availability'), { signal, credentials: 'same-origin', cache: 'no-store' }));
  if (body.available === true || (body.available === false && ['maintenance', 'models_unavailable'].includes(body.reason))) return body;
  throw new Error('Invalid availability response');
}
export async function redeemInvite(code: string): Promise<AccessSession> {
  return readResponse(await post('invite/redeem', { code }, AbortSignal.timeout(10000)), false);
}
export async function logoutSession(): Promise<void> {
  await readResponse(await post('logout', {}, AbortSignal.timeout(10000)));
}
export async function fetchCallToken(character?: string, signal?: AbortSignal, characterLink?: string, requestId: string = crypto.randomUUID()): Promise<CallToken> {
  const res = await post('token', { requestId, ...(characterLink !== undefined ? { characterLink } : character ? { character } : {}) }, signal);
  if (res.status === 400 && characterLink !== undefined) throw new InvalidCharacterLink();
  const body = await readResponse<Partial<CallToken>>(res);
  if (!body.serverUrl || !body.participantToken || !body.roomName || !body.participantName || !body.attemptId || !body.controlToken) throw new Error('Incomplete call token');
  return body as CallToken;
}
export async function fetchAttempt(attemptId: string, signal?: AbortSignal, controlToken?: string): Promise<AttemptState> {
  const body = await readResponse<{ state: AttemptState }>(await fetch(apiUrl(`calls/${encodeURIComponent(attemptId)}`), {
    signal, credentials: 'same-origin', cache: 'no-store',
    headers: controlToken ? { Authorization: `Call ${controlToken}` } : undefined,
  }), false);
  if (!['connecting', 'established', 'ending', 'ended'].includes(body.state)) throw new Error('Invalid attempt state');
  return body.state;
}
export async function cancelCall(requestId: string, attemptId?: string, controlToken?: string): Promise<void> {
  await readResponse(await fetch(apiUrl('calls/cancel'), {
    method: 'POST', credentials: 'same-origin', keepalive: true, signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(controlToken ? { Authorization: `Call ${controlToken}` } : {}) },
    body: JSON.stringify({ requestId, ...(attemptId ? { attemptId } : {}) }),
  }), false);
}
export async function fetchCharacters(signal?: AbortSignal, characterLink?: string): Promise<CharacterList> {
  const url = new URL(apiUrl('characters'));
  if (characterLink !== undefined) url.searchParams.set('characterLink', characterLink);
  const res = await fetch(url, { signal, credentials: 'same-origin' });
  if (res.status === 400 && characterLink !== undefined) throw new InvalidCharacterLink();
  const body = await readResponse<Partial<CharacterList>>(res);
  if (!body.defaultId || !Array.isArray(body.characters) || body.characters.length === 0) throw new Error('Incomplete character list');
  return body as CharacterList;
}
export async function fetchCharacterLink(character: string): Promise<string> {
  const body = await readResponse<{ characterLink?: unknown }>(await post('character-link', { character }, AbortSignal.timeout(10000)));
  if (typeof body.characterLink !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.characterLink)) throw new Error('Invalid character link');
  const url = new URL(window.location.href);
  url.search = ''; url.hash = ''; url.searchParams.set('character', body.characterLink);
  return url.href;
}

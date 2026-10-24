import { initializeLogger, log } from '@livekit/agents';
import { AccessToken } from 'livekit-server-sdk';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { z } from 'zod';
import { ATTRIBUTE_CHARACTER, type CharacterSummary, loadCharacters, summarize } from './characters.js';
import { type TokenServerConfig, loadTokenServerConfig } from './config.js';
import { createCharacterLink, resolveCharacterLink } from './character-link.js';
import { AccessError, AccessStore, type Attempt } from './access/store.js';
import { AccessController, livekitGateway } from './access/controller.js';
import { clientIp } from './access/client-ip.js';
import { ModelAvailability } from './access/availability.js';

export interface TokenResponse {
  readonly serverUrl: string; readonly roomName: string; readonly participantName: string;
  readonly participantToken: string; readonly attemptId: string; readonly controlToken: string;
}
export interface CharactersResponse { readonly defaultId: string; readonly characters: readonly CharacterSummary[] }
const selectionSchema = z.object({
  character: z.string().min(1).optional(), characterLink: z.string().min(1).max(2048).optional(),
  requestId: z.string().uuid().optional(),
}).refine(body => body.character === undefined || body.characterLink === undefined);
const internalSchema = z.object({ room: z.string().min(1).max(200), participant: z.string().min(1).max(200), agentId: z.string().min(1).max(200) });
const COOKIE = 'ptoy_session';
class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new BadRequest('JSON required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8192) throw new BadRequest('request too large');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new BadRequest('invalid JSON'); }
}
function cookie(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
}
function setCookie(res: ServerResponse, config: TokenServerConfig, token: string, maxAge: number) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${config.access.secureCookie ? '; Secure' : ''}`);
}
function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function internalAuth(req: IncomingMessage, secret: string) {
  const actual = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from('Bearer ' + secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function controlToken(config: TokenServerConfig, a: Attempt) {
  return createHmac('sha256', config.access.internalSecret).update(`ptoy-call-control-v1\0${a.id}\0${a.sessionHash}`).digest('base64url');
}
function hasCallControl(req: IncomingMessage, config: TokenServerConfig, a: Attempt) {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Call ' + controlToken(config, a));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function mintCallToken(config: TokenServerConfig, attempt: Attempt): Promise<TokenResponse> {
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: attempt.participant, ttl: config.tokenTtl,
    attributes: { [ATTRIBUTE_CHARACTER]: attempt.character },
  });
  token.addGrant({ room: attempt.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false });
  return { serverUrl: config.livekitPublicUrl, roomName: attempt.room, participantName: attempt.participant, participantToken: await token.toJwt(), attemptId: attempt.id, controlToken: controlToken(config, attempt) };
}

export function createTokenServer(config: TokenServerConfig, logger?: Pick<ReturnType<typeof log>, 'info' | 'error'>, injected?: AccessController) {
  const controller = injected ?? new AccessController(new AccessStore(config.access.dbPath, Date.now, config.access.maintenanceDefault), config.access,
    livekitGateway(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret));
  const store = controller.store;
  const models = new ModelAvailability(config.modelChecks);
  const timer = setInterval(() => void controller.reconcile().catch(() => logger?.error('access reconciliation failed')), config.access.reconcileMs);
  timer.unref();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      if (path.startsWith('/internal/ops/')) {
        if (!internalAuth(req, config.access.internalSecret)) throw new AccessError('unauthorized');
        if (req.method === 'POST' && path === '/internal/ops/maintenance') {
          const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await readJson(req));
          store.setMaintenance(enabled);
        } else if (req.method !== 'GET' || path !== '/internal/ops/status') {
          sendJson(res, 405, { code: 'method_not_allowed' }); return;
        }
        const modelsReady = await models.ready();
        sendJson(res, 200, { ...store.opsStatus(), modelsReady }); return;
      }
      if (path.startsWith('/internal/access/')) {
        if (!internalAuth(req, config.access.internalSecret)) throw new AccessError('unauthorized');
        if (req.method !== 'POST') { sendJson(res, 405, { code: 'method_not_allowed' }); return; }
        const body = internalSchema.parse(await readJson(req));
        const a = store.byRoom(body.room);
        if (!a || a.participant !== body.participant) throw new AccessError('attempt_mismatch', 409);
        if (path === '/internal/access/admit') {
          const admitted = await controller.admit(body.room, body.participant, body.agentId);
          sendJson(res, 200, { attemptId: admitted.id, character: admitted.character }); return;
        }
        if (path === '/internal/access/heartbeat') {
          sendJson(res, 200, { active: store.heartbeat(a.id, body.agentId) }); return;
        }
        if (path === '/internal/access/finish') {
          store.finish(a.id, body.agentId); sendJson(res, 200, { ok: true }); return;
        }
        sendJson(res, 404, { code: 'not_found' }); return;
      }
      if (req.method === 'POST' && req.headers.origin !== config.access.origin) {
        sendJson(res, 403, { code: 'invalid_origin' }); return;
      }
      if (req.method === 'GET' && path === '/api/session') {
        try { const session = store.session(cookie(req)); sendJson(res, 200, { authenticated: true, expiresAt: session.expiresAt }); }
        catch (error) {
          if (!(error instanceof AccessError)) throw error;
          sendJson(res, 200, { authenticated: false, code: error.code });
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/invite/redeem') {
        const { code } = z.object({ code: z.string().min(1).max(256) }).parse(await readJson(req));
        const redeemed = store.redeem(code, clientIp(req, config.access.trustedProxyIps));
        if (redeemed.error) throw redeemed.error;
        setCookie(res, config, redeemed.token!, 30 * 24 * 60 * 60);
        sendJson(res, 200, { authenticated: true, expiresAt: redeemed.expiresAt }); return;
      }
      if (req.method === 'POST' && path === '/api/logout') {
        await readJson(req); store.logout(cookie(req)); setCookie(res, config, '', 0);
        sendJson(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && path === '/api/calls/cancel') {
        const { requestId, attemptId } = z.object({ requestId: z.string().uuid(), attemptId: z.string().uuid().optional() }).parse(await readJson(req));
        const a = attemptId ? store.attempt(attemptId) : undefined;
        if (a && hasCallControl(req, config, a)) {
          if (a.requestId !== requestId) throw new AccessError('attempt_mismatch', 409);
          store.cancel(a.id);
        } else store.cancelRequest(requestId, cookie(req));
        sendJson(res, 200, { ok: true }); return;
      }
      const attemptMatch = /^\/api\/calls\/([a-f0-9-]+)$/.exec(path);
      if (req.method === 'GET' && attemptMatch) {
        const candidate = store.attempt(attemptMatch[1]!);
        const a = candidate && hasCallControl(req, config, candidate) ? candidate : store.ownedAttempt(attemptMatch[1]!, cookie(req));
        sendJson(res, 200, { state: a.state, attemptId: a.id }); return;
      }
      const session = store.session(cookie(req));
      if (req.method === 'GET' && path === '/api/availability') {
        if (store.maintenance()) { sendJson(res, 200, { available: false, reason: 'maintenance' }); return; }
        const modelsReady = await models.ready();
        const reason = store.maintenance() ? 'maintenance' : !modelsReady ? 'models_unavailable' : undefined;
        sendJson(res, 200, reason ? { available: false, reason } : { available: true }); return;
      }
      if (req.method === 'GET' && path === '/api/characters') {
        const params = new URL(req.url!, 'http://localhost').searchParams;
        const links = params.getAll('characterLink');
        if (links.length > 1) throw new BadRequest('expected one characterLink');
        let id: string | undefined;
        if (links.length) { try { id = resolveCharacterLink(links[0]!, config.characterLinkSecret); } catch { throw new BadRequest('invalid character link'); } }
        const catalog = loadCharacters(config.characters.dir, config.characters.defaultId, { ttsBackend: config.characters.ttsBackend });
        const fixed = id !== undefined ? catalog.get(id) : undefined;
        if (links.length && !fixed) throw new BadRequest('character unavailable');
        const body: CharactersResponse = { defaultId: (fixed ?? catalog.defaultCharacter).id, characters: fixed ? [summarize(fixed)] : catalog.characters.map(summarize) };
        sendJson(res, 200, body); return;
      }
      if (req.method === 'POST' && (path === '/api/token' || path === '/api/character-link')) {
        const request = selectionSchema.parse(await readJson(req));
        let id = request.character;
        if (request.characterLink !== undefined) { try { id = resolveCharacterLink(request.characterLink, config.characterLinkSecret); } catch { throw new BadRequest('invalid character link'); } }
        const catalog = loadCharacters(config.characters.dir, config.characters.defaultId, { ttsBackend: config.characters.ttsBackend });
        const character = id === undefined ? catalog.defaultCharacter : catalog.get(id);
        if (!character) throw new BadRequest('character unavailable');
        if (path === '/api/character-link') {
          if (!request.character || request.characterLink !== undefined) throw new BadRequest('expected character');
          sendJson(res, 200, { characterLink: createCharacterLink(character.id, config.characterLinkSecret) }); return;
        }
        if (!request.requestId) throw new BadRequest('requestId required');
        if (store.maintenance()) throw new AccessError('maintenance', 503);
        if (!await models.ready()) throw new AccessError('models_unavailable', 503);
        await controller.reconcile();
        const attempt = store.reserve(session, request.requestId, character.id);
        const body = await mintCallToken(config, attempt);
        sendJson(res, 200, body); return;
      }
      sendJson(res, 404, { code: 'not_found' });
    } catch (error) {
      if (error instanceof AccessError) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        sendJson(res, error.status, { code: error.code });
      } else if (error instanceof BadRequest || error instanceof z.ZodError) {
        sendJson(res, 400, { code: 'bad_request' });
      } else { logger?.error({ error }, 'access request failed'); sendJson(res, 503, { code: 'service_unavailable' }); }
    }
  });
  server.on('close', () => { clearInterval(timer); if (!injected) store.close(); });
  return server;
}
function main() {
  initializeLogger({ pretty: process.env.NODE_ENV !== 'production', level: process.env.LOG_LEVEL ?? 'info' });
  const logger = log().child({ service: 'token-server' });
  const config = loadTokenServerConfig();
  const server = createTokenServer(config, logger);
  server.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'token server listening'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

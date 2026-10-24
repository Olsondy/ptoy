import { initializeLogger, log } from '@livekit/agents';
import { AccessToken } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { z } from 'zod';
import { ATTRIBUTE_CHARACTER, type CharacterSummary, loadCharacters, summarize } from './characters.js';
import { type TokenServerConfig, loadTokenServerConfig } from './config.js';
import { createCharacterLink, resolveCharacterLink } from './character-link.js';

/** Response body of `POST /api/token`; mirrors LiveKit's standard token endpoint shape. */
export interface TokenResponse {
  readonly serverUrl: string;
  readonly roomName: string;
  readonly participantName: string;
  readonly participantToken: string;
}

/** Response body of `GET /api/characters`: the picker's options, default first. */
export interface CharactersResponse {
  readonly defaultId: string;
  readonly characters: readonly CharacterSummary[];
}

/** Body of `POST /api/token`; empty or `{}` means the default character. */
const tokenRequestSchema = z.object({
  character: z.string().min(1).optional(),
  characterLink: z.string().min(1).max(2048).optional(),
}).refine((body) => body.character === undefined || body.characterLink === undefined);

class BadRequest extends Error {}

async function readTokenRequest(req: IncomingMessage): Promise<z.infer<typeof tokenRequestSchema>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8192) throw new BadRequest('request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new BadRequest('body is not JSON');
  }
  const parsed = tokenRequestSchema.safeParse(json);
  if (!parsed.success) throw new BadRequest('expected character or characterLink, not both');
  return parsed.data;
}

/**
 * Every call gets a fresh room so a new call never inherits the previous conversation.
 * The picked character rides on the caller's participant attributes ({@link ATTRIBUTE_CHARACTER}).
 */
export async function mintCallToken(config: TokenServerConfig, characterId: string): Promise<TokenResponse> {
  const suffix = randomUUID().slice(0, 8);
  const roomName = `call-${suffix}`;
  const participantName = `user-${suffix}`;
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: participantName,
    ttl: config.tokenTtl,
    attributes: { [ATTRIBUTE_CHARACTER]: characterId },
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return {
    serverUrl: config.livekitPublicUrl,
    roomName,
    participantName,
    participantToken: await token.toJwt(),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, corsOrigin: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

export function createTokenServer(config: TokenServerConfig, logger?: Pick<ReturnType<typeof log>, 'info' | 'error'>) {
  const resolveLink = (token: string) => {
    try { return resolveCharacterLink(token, config.characterLinkSecret); }
    catch { throw new BadRequest('invalid character link'); }
  };
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, null, config.corsOrigin);
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, config.corsOrigin);
      return;
    }
    if (req.method === 'GET' && path === '/api/characters') {
      try {
        const catalog = loadCharacters(config.characters.dir, config.characters.defaultId);
        const links = url.searchParams.getAll('characterLink');
        if (links.length > 1) throw new BadRequest('expected one characterLink');
        const fixed = links.length ? catalog.get(resolveLink(links[0]!)) : undefined;
        if (links.length && !fixed) throw new BadRequest('character link is no longer available');
        const body: CharactersResponse = {
          defaultId: (fixed ?? catalog.defaultCharacter).id,
          characters: fixed ? [summarize(fixed)] : catalog.characters.map(summarize),
        };
        sendJson(res, 200, body, config.corsOrigin);
      } catch (error) {
        if (error instanceof BadRequest) {
          sendJson(res, 400, { error: error.message }, config.corsOrigin);
          return;
        }
        logger?.error({ error }, 'failed to load characters');
        sendJson(res, 500, { error: 'failed to load characters' }, config.corsOrigin);
      }
      return;
    }
    if (req.method === 'POST' && (path === '/api/token' || path === '/api/character-link')) {
      try {
        const request = await readTokenRequest(req);
        const catalog = loadCharacters(config.characters.dir, config.characters.defaultId);
        if (path === '/api/character-link' && (!request.character || request.characterLink !== undefined)) {
          throw new BadRequest('expected character');
        }
        const characterId = request.characterLink !== undefined ? resolveLink(request.characterLink) : request.character;
        const character = characterId === undefined ? catalog.defaultCharacter : catalog.get(characterId);
        if (!character) throw new BadRequest('character is no longer available');
        if (path === '/api/character-link') {
          sendJson(res, 200, { characterLink: createCharacterLink(character.id, config.characterLinkSecret) }, config.corsOrigin);
          return;
        }
        const body = await mintCallToken(config, character.id);
        logger?.info({ room: body.roomName, identity: body.participantName, character: character.id }, 'issued token');
        sendJson(res, 200, body, config.corsOrigin);
      } catch (error) {
        if (error instanceof BadRequest) {
          sendJson(res, 400, { error: error.message }, config.corsOrigin);
          return;
        }
        logger?.error({ error }, 'failed to mint token');
        sendJson(res, 500, { error: 'failed to mint token' }, config.corsOrigin);
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' }, config.corsOrigin);
  });
}

function main(): void {
  initializeLogger({ pretty: process.env.NODE_ENV !== 'production', level: process.env.LOG_LEVEL ?? 'info' });
  const logger = log().child({ service: 'token-server' });
  const config = loadTokenServerConfig();
  const server = createTokenServer(config, logger);
  server.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port, livekit: config.livekitPublicUrl }, 'token server listening');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

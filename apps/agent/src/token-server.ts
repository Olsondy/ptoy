import { initializeLogger, log } from '@livekit/agents';
import { AccessToken } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { type TokenServerConfig, loadTokenServerConfig } from './config.js';

/** Response body of `POST /api/token`; mirrors LiveKit's standard token endpoint shape. */
export interface TokenResponse {
  readonly serverUrl: string;
  readonly roomName: string;
  readonly participantName: string;
  readonly participantToken: string;
}

/** Every call gets a fresh room so a new call never inherits the previous conversation. */
export async function mintCallToken(config: TokenServerConfig): Promise<TokenResponse> {
  const suffix = randomUUID().slice(0, 8);
  const roomName = `call-${suffix}`;
  const participantName = `user-${suffix}`;
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: participantName,
    ttl: config.tokenTtl,
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function main(): void {
  initializeLogger({ pretty: process.env.NODE_ENV !== 'production', level: process.env.LOG_LEVEL ?? 'info' });
  const logger = log().child({ service: 'token-server' });
  const config = loadTokenServerConfig();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, null, config.corsOrigin);
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, config.corsOrigin);
      return;
    }
    if (req.method === 'POST' && path === '/api/token') {
      try {
        const body = await mintCallToken(config);
        logger.info({ room: body.roomName, identity: body.participantName }, 'issued token');
        sendJson(res, 200, body, config.corsOrigin);
      } catch (error) {
        logger.error({ error }, 'failed to mint token');
        sendJson(res, 500, { error: 'failed to mint token' }, config.corsOrigin);
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' }, config.corsOrigin);
  });

  server.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port, livekit: config.livekitPublicUrl }, 'token server listening');
  });
}

main();

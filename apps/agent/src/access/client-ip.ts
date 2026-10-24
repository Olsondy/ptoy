import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const normalize = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;
/** Walk from the socket backwards through explicitly trusted proxies; never trust the leftmost header blindly. */
export function clientIp(req: IncomingMessage, trusted: readonly string[]) {
  const socket = normalize(req.socket.remoteAddress ?? 'unknown');
  const proxies = new Set(trusted.map(normalize));
  if (!proxies.has(socket)) return socket;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return socket;
  const chain = forwarded.split(',').map(s => normalize(s.trim()));
  if (!chain.length || chain.length > 32 || chain.some(ip => !isIP(ip))) return socket;
  for (let i = chain.length - 1; i >= 0; i--) if (!proxies.has(chain[i]!)) return chain[i]!;
  return socket;
}

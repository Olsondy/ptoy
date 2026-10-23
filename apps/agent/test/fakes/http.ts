import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

export interface FakeServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts an HTTP server on 127.0.0.1 (random port unless given) that buffers each request body. */
export async function startFakeServer(
  handle: (req: FakeRequest, res: ServerResponse) => void | Promise<void>,
  port = 0,
): Promise<FakeServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      Promise.resolve(handle(captured, res)).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

import { type FakeRequest, type FakeServer, json, sleep, startFakeServer } from './http.js';

export const FAKE_FASTAPI_SAMPLE_RATE = 22050;
/** Fake audio length per input character. */
export const FAKE_FASTAPI_MS_PER_CHAR = 100;

export interface FakeTtsFastApiOptions {
  /** Simulated synthesis time. */
  readonly synthMs?: number;
  /** `http500`: synthesis error; `odd`: an odd byte count; `no_rate`: missing X-Sample-Rate. */
  readonly fail?: () => 'http500' | 'odd' | 'no_rate' | undefined;
}

export interface FakeTtsFastApi extends FakeServer {
  /** Body of every `POST /tts`. */
  readonly calls: Record<string, unknown>[];
  /** Ids passed to `POST /cancel/{id}`. */
  readonly cancels: string[];
}

/** 440 Hz tone, FAKE_FASTAPI_MS_PER_CHAR per character, as raw s16le. */
export function fakePcm(text: string): Buffer {
  const n = Math.round((FAKE_FASTAPI_SAMPLE_RATE * FAKE_FASTAPI_MS_PER_CHAR * [...text].length) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / FAKE_FASTAPI_SAMPLE_RATE) * 6000), i * 2);
  return buf;
}

/** Implements `services/tts`'s API: `/tts` (cancellable while "synthesizing"), `/cancel/{id}`, `/health`. */
export async function startFakeTtsFastApi(opts: FakeTtsFastApiOptions = {}): Promise<FakeTtsFastApi> {
  const calls: Record<string, unknown>[] = [];
  const cancels: string[] = [];
  const cancelled = new Set<string>();

  const server = await startFakeServer(async (req: FakeRequest, res) => {
    if (req.method === 'POST' && req.url === '/tts') {
      const body = JSON.parse(req.body.toString()) as Record<string, unknown>;
      calls.push(body);
      const id = String(body.request_id ?? '');
      const failure = opts.fail?.();
      const until = Date.now() + (opts.synthMs ?? 20);
      while (Date.now() < until && !cancelled.has(id)) await sleep(5);
      if (cancelled.has(id)) return json(res, 409, { error: 'cancelled', detail: id });
      if (failure === 'http500') return json(res, 500, { error: 'synthesis_failed', detail: 'CUDA out of memory' });
      const pcm = failure === 'odd' ? Buffer.alloc(3) : fakePcm(String(body.text));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Request-Id': id,
        ...(failure === 'no_rate' ? {} : { 'X-Sample-Rate': String(FAKE_FASTAPI_SAMPLE_RATE) }),
        'X-Channels': '1',
        'X-Sample-Format': 's16le',
      });
      res.end(pcm);
    } else if (req.method === 'POST' && req.url.startsWith('/cancel/')) {
      const id = decodeURIComponent(req.url.slice('/cancel/'.length));
      cancels.push(id);
      cancelled.add(id);
      json(res, 200, { request_id: id, state: 'running' });
    } else if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { status: 'ok', model: 'fake', sample_rate: FAKE_FASTAPI_SAMPLE_RATE });
    } else {
      json(res, 404, { detail: 'not found' });
    }
  });

  return { ...server, calls, cancels };
}

import { type FakeServer, json, startFakeServer } from './http.js';

/** ASR stand-in: every `POST /v1/audio/transcriptions` returns the next text of `texts` (cycling). */
export async function startFakeAsr(texts: readonly string[], port = 0): Promise<FakeServer & { readonly count: number }> {
  let count = 0;
  const server = await startFakeServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', model: 'fake' });
    if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') return json(res, 404, { detail: 'Not Found' });
    const text = texts[count++ % texts.length] ?? '';
    json(res, 200, { text, raw_text: [`<|zh|><|NEUTRAL|><|Speech|><|withitn|>${text}`], elapsed_seconds: 0.012 });
  }, port);
  return {
    ...server,
    get count() {
      return count;
    },
  };
}

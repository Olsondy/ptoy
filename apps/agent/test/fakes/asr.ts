import { type FakeServer, json, startFakeServer } from './http.js';

/** services/asr stand-in: every `POST /asr` returns the next text of `texts` (cycling). */
export async function startFakeAsr(texts: readonly string[], port = 0): Promise<FakeServer & { readonly count: number }> {
  let count = 0;
  const server = await startFakeServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', model: 'fake' });
    if (req.method !== 'POST' || req.url !== '/asr') return json(res, 404, { error: 'not_found' });
    const text = texts[count++ % texts.length] ?? '';
    json(res, 200, { text, emotion: 'neutral', events: ['speech'], duration_ms: 12 });
  }, port);
  return {
    ...server,
    get count() {
      return count;
    },
  };
}

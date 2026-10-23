import { type FakeServer, json, startFakeServer } from './http.js';

/**
 * ASR stand-in: every `POST /v1/audio/transcriptions` returns the next text of `texts` (cycling),
 * tagged with the SenseVoice emotion at the same index of `emotions` (e.g. `angry`; default neutral).
 */
export async function startFakeAsr(
  texts: readonly string[],
  port = 0,
  emotions: readonly string[] = [],
): Promise<FakeServer & { readonly count: number }> {
  let count = 0;
  const server = await startFakeServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', model: 'fake' });
    if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') return json(res, 404, { detail: 'Not Found' });
    const i = count++ % texts.length;
    const text = texts[i] ?? '';
    const emotion = (emotions[i] || 'neutral').toUpperCase();
    json(res, 200, { text, raw_text: [`<|zh|><|${emotion}|><|Speech|><|withitn|>${text}`], elapsed_seconds: 0.012 });
  }, port);
  return {
    ...server,
    get count() {
      return count;
    },
  };
}

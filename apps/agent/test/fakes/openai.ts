import { type FakeServer, json, sleep, startFakeServer } from './http.js';

export interface FakeOpenAIOptions {
  /** Tokens streamed for each request (called with the request body). */
  readonly reply?: (body: Record<string, unknown>) => string[];
  /** Delay before the first token and between tokens. */
  readonly tokenDelayMs?: number;
  /** `status`: HTTP 503; `hang`: accept and never answer. */
  readonly fail?: () => 'status' | 'hang' | undefined;
  readonly port?: number;
}

export interface FakeOpenAI extends FakeServer {
  /** Base URL including `/v1`, as `LLM_BASE_URL` expects. */
  readonly baseUrl: string;
  readonly requests: Record<string, unknown>[];
}

/** Minimal llama-server stand-in: streaming `POST /v1/chat/completions` (SSE) and `GET /v1/models`. */
export async function startFakeOpenAI(opts: FakeOpenAIOptions = {}): Promise<FakeOpenAI> {
  const requests: Record<string, unknown>[] = [];
  const server = await startFakeServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'qwen3-8b', object: 'model' }] });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: 'not found' });
    const body = JSON.parse(req.body.toString()) as Record<string, unknown>;
    requests.push(body);
    const failure = opts.fail?.();
    if (failure === 'status') return json(res, 503, { error: { message: 'Loading model', type: 'unavailable_error' } });
    if (failure === 'hang') return;
    const tokens = opts.reply?.(body) ?? ['你好', '呀，', '今天', '过得', '怎么样？'];
    const id = `chatcmpl-${requests.length}`;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'qwen3-8b',
        choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: '' }));
    for (const t of tokens) {
      await sleep(opts.tokenDelayMs ?? 5);
      res.write(chunk({ content: t }));
    }
    res.write(chunk({}, 'stop'));
    res.write(chunk({}, null, { prompt_tokens: 10, completion_tokens: tokens.length, total_tokens: 10 + tokens.length }));
    res.end('data: [DONE]\n\n');
  }, opts.port);
  return { ...server, baseUrl: `${server.url}/v1`, requests };
}

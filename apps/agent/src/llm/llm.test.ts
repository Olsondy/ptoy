import { APIStatusError, initializeLogger, llm } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeOpenAI, type FakeOpenAIOptions, startFakeOpenAI } from '../../test/fakes/openai.js';
import { loadLlmEndpoint } from '../config.js';
import { createLlm } from './index.js';

initializeLogger({ pretty: false, level: 'silent' });

let server: FakeOpenAI | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function chat(opts: FakeOpenAIOptions = {}) {
  server = await startFakeOpenAI(opts);
  const model = createLlm({
    baseUrl: server.baseUrl,
    model: 'qwen3-8b',
    apiKey: 'no-key',
    maxTokens: 150,
    temperature: 0.7,
    timeoutMs: 1000,
    maxRetry: 0,
  });
  const errors: Parameters<llm.LLMCallbacks['error']>[0][] = [];
  model.on('error', (e) => errors.push(e));
  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'system', content: '你是小悠。' });
  chatCtx.addMessage({ role: 'user', content: '你好' });
  const stream = model.chat({ chatCtx, connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 } });
  const tokens: string[] = [];
  let thrown: unknown;
  try {
    for await (const chunk of stream) if (chunk.delta?.content) tokens.push(chunk.delta.content);
  } catch (error) {
    thrown = error;
  }
  return { tokens, errors, thrown, requests: server.requests };
}

describe('LLM against an OpenAI-compatible (llama-server) endpoint', () => {
  it('streams the reply tokens in order', async () => {
    const { tokens, errors } = await chat({ reply: () => ['你好', '呀，', '我是小悠。'] });
    expect(tokens.join('')).toBe('你好呀，我是小悠。');
    expect(errors).toEqual([]);
  });

  it('sends a streaming request with the model, token cap, temperature and history', async () => {
    const { requests } = await chat();
    expect(requests).toHaveLength(1);
    const body = requests[0]!;
    expect(body.stream).toBe(true);
    expect(body.model).toBe('qwen3-8b');
    expect(body.max_completion_tokens).toBe(150);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toEqual([
      { role: 'system', content: '你是小悠。' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('an HTTP error surfaces as an unrecoverable llm_error', async () => {
    const { tokens, errors, thrown } = await chat({ fail: () => 'status' });
    expect(tokens).toEqual([]);
    expect(errors.at(-1)?.recoverable).toBe(false);
    expect(errors.at(-1)?.error ?? thrown).toBeInstanceOf(APIStatusError);
  });

  it('a hung server times out instead of waiting forever', async () => {
    const started = Date.now();
    const { tokens, errors } = await chat({ fail: () => 'hang' });
    expect(tokens).toEqual([]);
    expect(errors.at(-1)?.recoverable).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('LLM endpoint config', () => {
  it('uses the shared OpenRouter key only on openrouter.ai; local llama-server needs none', () => {
    expect(loadLlmEndpoint({ OPENROUTER_API_KEY: 'sk-or-shared' })).toEqual({
      baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3-8b', apiKey: 'no-key',
    });
    const hosted = { LLM_BASE_URL: 'https://openrouter.ai/api/v1', LLM_MODEL: 'some/model' };
    expect(loadLlmEndpoint({ ...hosted, OPENROUTER_API_KEY: 'sk-or-shared' }).apiKey).toBe('sk-or-shared');
    expect(loadLlmEndpoint({ ...hosted, OPENROUTER_API_KEY: 'sk-or-shared', LLM_API_KEY: 'sk-or-llm' }).apiKey).toBe('sk-or-llm');
    expect(() => loadLlmEndpoint(hosted)).toThrow(/LLM_API_KEY: required/);
  });
});

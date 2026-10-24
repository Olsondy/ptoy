import * as openai from '@livekit/agents-plugin-openai';
import type { LlmConfig } from '../config.js';

/**
 * LiveKit's OpenAI plugin pointed at llama-server's OpenAI-compatible API (streaming chat
 * completions). Thinking is disabled server-side (`--reasoning off`), see docs/architecture/server.md §5;
 * a hosted reasoning model gets `reasoning_effort` instead.
 * Timeouts/retries come from the session's `llmConnOptions`.
 */
export function createLlm(config: LlmConfig): openai.LLM {
  return new openai.LLM({
    baseURL: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    temperature: config.temperature,
    maxCompletionTokens: config.maxTokens,
    reasoningEffort: config.reasoningEffort,
  });
}

import * as openai from '@livekit/agents-plugin-openai';
import { z } from 'zod';
import type { LlmConfig, ReasoningEffort } from '../config.js';

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

/** Least thinking first. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high'];

const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
    }),
  ),
});

/** Per process: the model list does not change during a run. */
const lowestEffortCache = new Map<string, Promise<ReasoningEffort | undefined>>();

/**
 * The lowest `reasoning_effort` the endpoint's `/models` lists for this model (magpie publishes
 * `supported_reasoning_levels`: DeepSeek `none`, ChatGPT `low`). Undefined when the list has no
 * levels for it (llama-server) or cannot be read: nothing is sent then.
 */
type EndpointModel = Pick<LlmConfig, 'baseUrl' | 'model' | 'apiKey' | 'reasoningEffort'>;

async function lowestReasoningEffort(config: EndpointModel): Promise<ReasoningEffort | undefined> {
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const models = modelsSchema.safeParse(await res.json());
    const levels = models.success
      ? (models.data.data.find((m) => m.id === config.model)?.supported_reasoning_levels ?? []).map((l) => l.effort)
      : [];
    return EFFORT_ORDER.find((e) => levels.includes(e));
  } catch {
    return undefined;
  }
}

/** `config` with `reasoningEffort` filled in from the model list when LLM_REASONING_EFFORT is unset. */
export async function withReasoningEffort<T extends EndpointModel>(config: T): Promise<T> {
  if (config.reasoningEffort !== undefined) return config;
  const key = `${config.baseUrl} ${config.model}`;
  let lowest = lowestEffortCache.get(key);
  if (!lowest) {
    lowest = lowestReasoningEffort(config);
    lowestEffortCache.set(key, lowest);
  }
  const effort = await lowest;
  return effort === undefined ? config : { ...config, reasoningEffort: effort };
}

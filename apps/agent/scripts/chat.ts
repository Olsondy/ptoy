/**
 * Text chat with a character, sent to the LLM exactly the way a phone call does, so a prompt
 * tried here behaves like it will on the phone (a web chat UI differs: persona as a user message,
 * its own sampling settings, the model's raw replies kept in the history).
 *
 *   pnpm --filter @ptoy/agent chat                         # DEFAULT_CHARACTER, LLM_* from .env
 *   pnpm --filter @ptoy/agent chat -- --character zhixia --show-request
 *
 * Same as the agent: system = persona + `_rules.md`; the message being answered carries
 * `[用户语气:X]` (none for 平静); past user messages are the raw text; past replies are what was
 * spoken (segmenter-cleaned, no tags); `temperature` / `max_tokens` from LLM_TEMPERATURE /
 * LLM_MAX_TOKENS, `reasoning_effort` from LLM_REASONING_EFFORT or, unset, the model's lowest listed level. Not reproduced: replies cut by a barge-in (the history keeps only the played part).
 *
 * Type a line to say it. Prefix a tone to play the caller's ASR emotion: `怒:我都说了三遍了`.
 * Commands: /reset (new call), /system (print the system prompt), /history (print the messages).
 */
import { createSegmenter, type Emotion, EMOTIONS } from '@ptoy/segmenter';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadCharacters } from '../src/characters.js';
import { DEFAULT_CHARACTERS_DIR, type ReasoningEffort } from '../src/config.js';
import { withReasoningEffort } from '../src/llm/index.js';
import { REPLY_SEGMENTER } from '../src/pipelines/conversation.js';
import { withTone } from '../src/emotion/user-tone.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    character: { type: 'string', default: process.env.DEFAULT_CHARACTER ?? 'xiaoyou' },
    'show-request': { type: 'boolean', default: false },
  },
});
const baseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');
const model = process.env.LLM_MODEL ?? 'qwen3-8b';
const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.7);
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 220);
const { reasoningEffort } = await withReasoningEffort({
  baseUrl,
  model,
  apiKey: process.env.LLM_API_KEY ?? 'no-key',
  reasoningEffort: (process.env.LLM_REASONING_EFFORT || undefined) as ReasoningEffort | undefined,
});
const catalog = loadCharacters(process.env.CHARACTERS_DIR ?? DEFAULT_CHARACTERS_DIR, values.character);
const character = catalog.defaultCharacter;
const out = (line: string) => process.stdout.write(`${line}\n`);

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const TONE_PREFIX = new RegExp(`^(${EMOTIONS.join('|')})[:：]\\s*`, 'u');

function parseLine(line: string): { tone: Emotion; text: string } {
  const m = TONE_PREFIX.exec(line);
  return m ? { tone: m[1] as Emotion, text: line.slice(m[0].length).trim() } : { tone: '平静', text: line.trim() };
}

/** What the TTS speaks and the history keeps: segmenter-cleaned text, plus each segment's emotion. */
function spoken(raw: string): { text: string; segments: string[] } {
  const seg = createSegmenter(REPLY_SEGMENTER);
  const segs = [...seg.push(raw), ...seg.end()];
  return { text: segs.map((s) => s.text).join(''), segments: segs.map((s) => `[${s.emotion}]${s.text}`) };
}

async function complete(messages: readonly Message[]): Promise<{ text: string; ms: number }> {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    stream: false,
  };
  if (values['show-request']) out(`\n--- request ---\n${JSON.stringify(body, null, 2)}\n---------------`);
  const started = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY ?? 'no-key'}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 10000) * 3),
  });
  if (!res.ok) throw new Error(`LLM responded ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return { text: json.choices[0]?.message.content ?? '', ms: Math.round(performance.now() - started) };
}

async function main(): Promise<void> {
  const system: Message = { role: 'system', content: character.instructions };
  let history: Message[] = [system];
  out(`${character.name}（${character.id}） · ${model} @ ${baseUrl} · temperature ${temperature} · max_tokens ${maxTokens} · reasoning_effort ${reasoningEffort ?? '不传'}`);
  out('输入要说的话，语气前缀如“怒:”；/reset /system /history；Ctrl+D 退出\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
  // Piped input closes the interface at EOF while earlier lines are still being answered.
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };
  prompt();
  try {
    // Lines read one at a time (Ctrl+D ends): piped input keeps every line, the next one waits for the reply.
    for await (const input of rl) {
      const line = input.trim();
      if (!line) {
        prompt();
        continue;
      }
      if (line === '/reset') {
        history = [system];
        out('（新的一通电话）\n');
        prompt();
        continue;
      }
      if (line === '/system') {
        out(`${system.content}\n`);
        prompt();
        continue;
      }
      if (line === '/history') {
        out(`${JSON.stringify(history, null, 2)}\n`);
        prompt();
        continue;
      }
      const { tone, text } = parseLine(line);
      if (!text) {
        prompt();
        continue;
      }
      try {
        // Only the message being answered carries the tone; it is stored raw afterwards.
        const { text: raw, ms } = await complete([...history, { role: 'user', content: withTone(text, tone) }]);
        const reply = spoken(raw);
        history = [...history, { role: 'user', content: text }, { role: 'assistant', content: reply.text }];
        out(`${character.name}> ${reply.text}`);
        out(`  原始: ${raw.replace(/\n/g, '⏎')}`);
        out(`  分段: ${reply.segments.join(' | ')}  (${ms}ms)\n`);
      } catch (error) {
        out(`  ✗ ${(error as Error).message}\n`);
      }
      prompt();
    }
  } finally {
    rl.close();
  }
}

await main();

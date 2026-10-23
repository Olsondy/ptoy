/**
 * Emotion-tag compliance of the character prompt on the real LLM (#13), over multi-turn calls.
 *
 *   pnpm --filter @ptoy/agent emotion:compliance                       # LLM_BASE_URL from .env
 *   pnpm --filter @ptoy/agent emotion:compliance -- --runs 2 --json
 *   pnpm --filter @ptoy/agent emotion:compliance -- --character zhixia  # default: DEFAULT_CHARACTER
 *
 * Replays scripted conversations the way the agent does: each user line is sent with its tone
 * prefix (`[用户语气:X]`, none for 平静), and the model's own past replies go back into the
 * history cleaned by the segmenter (no tags), exactly what the LLM sees in a call. Counts, per
 * reply, whether every sentence starts with a valid emotion tag, plus invalid tags, echoed tone
 * hints and the emotions used per caller tone. Change the prompt, rerun, compare.
 */
import { createSegmenter, type Emotion, EMOTIONS } from '@ptoy/segmenter';
import { parseArgs } from 'node:util';
import { loadCharacters } from '../src/characters.js';
import { DEFAULT_CHARACTERS_DIR } from '../src/config.js';
import { withTone } from '../src/emotion/user-tone.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    runs: { type: 'string', default: '1' },
    character: { type: 'string', default: process.env.DEFAULT_CHARACTER ?? 'xiaoyou' },
    json: { type: 'boolean', default: false },
  },
});
const baseUrl = (process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');
const model = process.env.LLM_MODEL ?? 'qwen3-8b';
const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.7);
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 150);
const catalog = loadCharacters(process.env.CHARACTERS_DIR ?? DEFAULT_CHARACTERS_DIR, values.character);
const system = catalog.defaultCharacter.instructions;
const out = (line: string) => process.stdout.write(`${line}\n`);

type Turn = readonly [tone: Emotion, text: string];
/** Calls mixing calm, angry, sad and happy callers; tones change mid-call on purpose. */
const CALLS: readonly (readonly Turn[])[] = [
  [
    ['平静', '喂，你好，在干嘛呢？'],
    ['怒', '我都说了三遍了，你怎么还是没听懂！'],
    ['怒', '算了算了，跟你说话真累。'],
    ['平静', '好吧，那你说说今天有什么好玩的。'],
  ],
  [
    ['哀', '我今天被老板骂了，心里特别难受。'],
    ['哀', '我是不是真的很没用啊。'],
    ['平静', '嗯，谢谢你听我说这些。'],
    ['喜', '对了，我下个月要去旅游了！'],
  ],
  [
    ['喜', '告诉你个好消息，我考试过了！'],
    ['喜', '哈哈，我准备了整整三个月呢。'],
    ['平静', '你觉得我接下来该学点什么？'],
    ['惊喜', '哇，这个主意不错啊！'],
  ],
  [
    ['平静', '你叫什么名字来着？'],
    ['惧', '刚才楼下好像有奇怪的声音，我有点害怕。'],
    ['平静', '好像没事了，可能是猫吧。'],
    ['厌恶', '楼上又在装修，吵死了，烦得要命。'],
  ],
  [
    ['平静', '我最近在想要不要换个工作。'],
    ['哀', '现在的工作太没意思了，每天都很累。'],
    ['怒', '而且同事老是把活推给我，太气人了！'],
    ['平静', '你说我该怎么跟领导开口？'],
  ],
];

const TAG_AT_START = new RegExp(`^\\s*[\\[【](${EMOTIONS.join('|')})[\\]】]`, 'u');
const ANY_TAG = /[[【]([^\]】]{0,10})[\]】]/gu;

/** Sentences of a raw reply: cut after 。！？!?… runs (closing quotes stay with their sentence). */
function sentences(raw: string): string[] {
  return raw
    .split(/(?<=[。！？!?…]+[”’」』]*)/u)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s.replace(ANY_TAG, '')));
}

function clean(raw: string): { text: string; emotions: Emotion[] } {
  const seg = createSegmenter();
  const segs = [...seg.push(raw), ...seg.end()];
  return { text: segs.map((s) => s.text).join(''), emotions: segs.map((s) => s.emotion) };
}

async function complete(messages: { role: string; content: string }[]): Promise<{ text: string; ms: number }> {
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer no-key' },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`LLM responded ${res.status}`);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return { text: body.choices[0]?.message.content ?? '', ms: Math.round(performance.now() - started) };
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

interface ReplyStat {
  call: number;
  turn: number;
  tone: Emotion;
  raw: string;
  sentences: number;
  tagged: number;
  invalidTags: string[];
  echoedHint: boolean;
  emotions: Emotion[];
}

async function main(): Promise<void> {
  const stats: ReplyStat[] = [];
  for (let run = 0; run < Number(values.runs); run++) {
    for (const [c, call] of CALLS.entries()) {
      const history: { role: string; content: string }[] = [{ role: 'system', content: system }];
      for (const [t, [tone, text]] of call.entries()) {
        history.push({ role: 'user', content: withTone(text, tone) });
        const { text: raw } = await complete(history);
        // History as the agent keeps it: the raw transcript for the user, the cleaned reply for itself.
        history[history.length - 1] = { role: 'user', content: text };
        const { text: spoken, emotions } = clean(raw);
        history.push({ role: 'assistant', content: spoken });
        const ss = sentences(raw);
        const stat: ReplyStat = {
          call: c + 1,
          turn: t + 1,
          tone,
          raw,
          sentences: ss.length,
          tagged: ss.filter((s) => TAG_AT_START.test(s)).length,
          invalidTags: [...raw.matchAll(ANY_TAG)].map((m) => m[1] ?? '').filter((n) => !EMOTIONS.includes(n.trim() as Emotion)),
          echoedHint: raw.includes('用户语气'),
          emotions,
        };
        stats.push(stat);
        if (!values.json) {
          const ok = stat.tagged === stat.sentences && stat.invalidTags.length === 0 && !stat.echoedHint;
          out(`${ok ? 'ok  ' : 'MISS'} #${run + 1}.${stat.call}.${stat.turn} [${tone}] ${text}\n       → ${raw.replace(/\n/g, ' ')}`);
        }
      }
    }
  }

  const replies = stats.length;
  const fullyTagged = stats.filter((s) => s.tagged === s.sentences && s.sentences > 0).length;
  const firstTagged = stats.filter((s) => TAG_AT_START.test(s.raw)).length;
  const sentenceTotal = stats.reduce((n, s) => n + s.sentences, 0);
  const sentenceTagged = stats.reduce((n, s) => n + s.tagged, 0);
  const byTurn = [1, 2, 3, 4].map((turn) => {
    const ts = stats.filter((s) => s.turn === turn);
    return `${ts.filter((s) => s.tagged === s.sentences && s.sentences > 0).length}/${ts.length}`;
  });
  const byTone: Record<string, Record<string, number>> = {};
  for (const s of stats) {
    const row = (byTone[s.tone] ??= {});
    for (const e of s.emotions) row[e] = (row[e] ?? 0) + 1;
  }
  const summary = {
    character: values.character,
    model,
    replies,
    repliesFullyTagged: `${fullyTagged}/${replies} (${Math.round((fullyTagged / replies) * 100)}%)`,
    repliesStartingWithTag: `${firstTagged}/${replies}`,
    sentencesTagged: `${sentenceTagged}/${sentenceTotal} (${Math.round((sentenceTagged / sentenceTotal) * 100)}%)`,
    fullyTaggedByTurn: byTurn,
    invalidTags: stats.flatMap((s) => s.invalidTags),
    echoedHint: stats.filter((s) => s.echoedHint).length,
    multiEmotionReplies: stats.filter((s) => new Set(s.emotions).size > 1).length,
    segmentEmotionsByCallerTone: byTone,
  };
  out(values.json ? JSON.stringify({ summary, stats }, null, 2) : `\n${JSON.stringify(summary, null, 2)}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

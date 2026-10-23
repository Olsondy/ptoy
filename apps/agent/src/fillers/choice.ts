/** Filler groups of `assets/fillers/manifest.json` (services/fillers/README.md). */
export const FILLER_GROUPS = ['thinking', 'ack', 'empathy'] as const;
export type FillerGroup = (typeof FILLER_GROUPS)[number];

/** SenseVoice emotions that make the turn an emotional one. */
const NEGATIVE_EMOTIONS = new Set(['sad', 'angry', 'fearful', 'disgusted']);

/** Venting / complaining / low mood. Checked first: "我好难过怎么办？" wants empathy, not "我想想". */
const EMOTIONAL =
  /难过|伤心|难受|委屈|郁闷|(?<!麻)烦|累|困了|好困|压力|焦虑|紧张|害怕|担心|失眠|孤独|寂寞|想哭|哭了|崩溃|生气|气死|讨厌|糟糕|倒霉|心累|不开心|不高兴|不舒服|生病|病了|疼|痛|失恋|分手|吵架|失败|没考好|被骂|唉|哎/;

/** Asking the agent to do something: "好的"/"好呀" fits better than "我想想". */
const REQUEST = /^(请|麻烦|帮我|给我|陪我|跟我|我们|咱们|一起|来)|帮我|给我讲|给我说|陪我|能不能|可不可以|可以.*吗|好不好|行不行|要不要/;

/** A question for the agent: thinking. */
const QUESTION = /[？?]|[吗呢么嘛][。！!.…\s]*$|什么|怎么|为什么|为啥|哪|谁|几|多少|多久|如何|是不是|有没有|会不会|对不对/;

/**
 * Picks the filler group for a finished user turn (final transcript + SenseVoice emotion):
 * 1. emotional (negative ASR emotion or venting words)  → `empathy`
 * 2. a request ("帮我…"、"能不能…"、"…好不好")           → `ack`
 * 3. a question (？, 吗/呢 at the end, 什么/怎么/为什么…) → `thinking`
 * 4. anything else (statements, greetings)               → `ack`
 */
export function chooseFillerGroup(transcript: string, asrEmotion?: string): FillerGroup {
  const text = transcript.trim();
  if ((asrEmotion && NEGATIVE_EMOTIONS.has(asrEmotion)) || EMOTIONAL.test(text)) return 'empathy';
  if (REQUEST.test(text)) return 'ack';
  if (QUESTION.test(text)) return 'thinking';
  return 'ack';
}

export interface FillerEntry {
  readonly id: string;
}

/**
 * Random filler from a group that is never the one played last turn. If the group has nothing
 * else to offer, any other filler is used; with a single filler in total it repeats.
 */
export class FillerPicker<T extends FillerEntry> {
  readonly #groups: ReadonlyMap<FillerGroup, readonly T[]>;
  readonly #random: () => number;
  #lastId: string | undefined;

  constructor(groups: ReadonlyMap<FillerGroup, readonly T[]>, random: () => number = Math.random) {
    this.#groups = groups;
    this.#random = random;
  }

  /** Picks for `group` (falls back to `ack`, then any group, when it has no fillers). */
  pick(group: FillerGroup): T | undefined {
    const all = [...this.#groups.values()].flat();
    const fresh = (list: readonly T[]) => list.filter((f) => f.id !== this.#lastId);
    const candidates = [this.#groups.get(group) ?? [], this.#groups.get('ack') ?? [], all]
      .map(fresh)
      .find((list) => list.length > 0) ?? all;
    const chosen = candidates[Math.floor(this.#random() * candidates.length)] ?? candidates[0];
    if (chosen) this.#lastId = chosen.id;
    return chosen;
  }
}

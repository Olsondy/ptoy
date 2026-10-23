/** Filler groups of `assets/fillers/<voice>/manifest.json` (services/fillers/README.md). */
export const FILLER_GROUPS = ['thinking', 'ack', 'empathy'] as const;
export type FillerGroup = (typeof FILLER_GROUPS)[number];

/** SenseVoice emotions that make the turn an emotional one. */
const NEGATIVE_EMOTIONS = new Set(['sad', 'angry', 'fearful', 'disgusted']);

/**
 * Clear venting / complaining / low mood. Checked first: "我好难过怎么办？" wants empathy, not "我想想".
 * Only explicit words: a bare "哎" / "累" / "疼" in passing ("哎你知道吗", "累不累") is not venting,
 * and "啊，这样啊" on a plain sentence sounds off.
 */
const EMOTIONAL =
  /难过|伤心|难受|委屈|郁闷|心烦|烦死|好烦|烦躁|(?:好|太|很|真|特别)累|累死|累坏|心累|压力(?:好|太|很)?大|焦虑|紧张|害怕|担心|失眠|孤独|寂寞|想哭|哭了|崩溃|生气|气死|讨厌死|糟糕|倒霉|不开心|不高兴|不舒服|生病|病了|(?:好|很|太)(?:疼|痛)|头疼|失恋|分手|吵架|没考好|被.{0,4}骂|挨骂/;

/** Asking the agent to do something: "好的"/"好呀" fits better than "我想想". */
const REQUEST = /^(请|麻烦|帮我|给我|陪我|跟我|我们|咱们|一起|来)|帮我|给我讲|给我说|陪我|能不能|可不可以|可以.*吗|好不好|行不行|要不要/;

/**
 * A short question is small talk ("你吃了吗", "在干嘛呢"): nothing to think about, so a plain
 * "嗯嗯" fits better than "让我想想啊". Counted in content characters (punctuation ignored).
 */
const SMALL_TALK_MAX_CHARS = 6;
const NON_CONTENT = /[\s\p{P}]/gu;

/** A question for the agent: thinking. */
const QUESTION = /[？?]|[吗呢么嘛][。！!.…\s]*$|什么|怎么|为什么|为啥|哪|谁|几|多少|多久|如何|是不是|有没有|会不会|对不对/;

/**
 * Picks the filler group for a finished user turn (final transcript + SenseVoice emotion):
 * 1. venting words ("难过"、"好累"、"被骂"…)                    → `empathy`
 * 2. a request ("帮我…"、"能不能…"、"…好不好")                  → `ack`
 * 3. a question (？, 吗/呢 at the end, 什么/怎么/为什么…)        → `thinking`,
 *    or `ack` when it is short small talk (≤ {@link SMALL_TALK_MAX_CHARS} characters)
 * 4. a statement with a negative ASR emotion                    → `empathy`
 * 5. anything else (statements, greetings)                      → `ack`
 *
 * The ASR emotion has no confidence and often tags plain speech as sad/angry, so on its own it
 * only colours statements: "啊，这样啊" in front of an answer to a question sounds wrong.
 */
export function chooseFillerGroup(transcript: string, asrEmotion?: string): FillerGroup {
  const text = transcript.trim();
  if (EMOTIONAL.test(text)) return 'empathy';
  if (REQUEST.test(text)) return 'ack';
  if (QUESTION.test(text)) return text.replace(NON_CONTENT, '').length <= SMALL_TALK_MAX_CHARS ? 'ack' : 'thinking';
  if (asrEmotion && NEGATIVE_EMOTIONS.has(asrEmotion)) return 'empathy';
  return 'ack';
}

/**
 * Chance that a turn gets a filler at all. A filler on every turn sounds scripted: plain
 * acknowledgements play on half the turns, and a group that already played last turn
 * ("这样啊" twice while the caller vents) has its chance halved again.
 */
const PLAY_CHANCE: Readonly<Record<FillerGroup, number>> = { thinking: 1, empathy: 1, ack: 0.5 };
const REPEATED_GROUP_FACTOR = 0.5;

export function fillerPlayChance(group: FillerGroup, previousGroup: FillerGroup | undefined): number {
  return PLAY_CHANCE[group] * (group === previousGroup ? REPEATED_GROUP_FACTOR : 1);
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

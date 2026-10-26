import { ChatMessage, type ChatContext } from '@livekit/agents';
import type { AmbienceBed } from './bed.js';
import { AMBIENCE_TAG, type Ambience } from './manifest.js';

/** One reply's effect on the ambience, as the `ambience` log line shows it. */
export interface AmbienceChange {
  /** The reply's `<bg:…>` value as written; absent = untagged. */
  readonly tag?: string;
  readonly from: string;
  readonly to: string;
  /** Why the level was kept although the reply was tagged. */
  readonly ignored?: 'unknown_level';
}

/**
 * The call's ambience level (ADR 0013). A reply's tag only counts once the reply is heard:
 * `replyGenerating()` when its TTS starts, `tagged()` with its first `<bg:…>` value,
 * `replyStarted()` when its audio starts playing. A reply cut before it played never calls the
 * last one, and the next reply's `replyGenerating()` drops its tag. Untagged or unknown → keep.
 */
export class AmbienceDirector {
  readonly #bed: AmbienceBed;
  readonly #levels: ReadonlySet<string>;
  readonly #onChange: (change: AmbienceChange) => void;
  #current: string;
  /** A reply is being generated and has not started playing yet. */
  #armed = false;
  #tag: string | undefined;
  /** The level after each reply that was heard, in order: what the LLM is shown it wrote. */
  readonly #heard: string[] = [];

  constructor(bed: AmbienceBed, ambience: Ambience, onChange: (change: AmbienceChange) => void) {
    this.#bed = bed;
    this.#levels = new Set(ambience.levels.map((l) => l.id));
    this.#onChange = onChange;
    this.#current = ambience.levels[0]!.id;
    bed.set(this.#current);
  }

  get level(): string {
    return this.#current;
  }

  replyGenerating(): void {
    this.#armed = true;
    this.#tag = undefined;
  }

  tagged(level: string): void {
    if (this.#armed && this.#tag === undefined) this.#tag = level;
  }

  /** The reply's audio started; later calls for the same reply (resumed after a pause) do nothing. */
  replyStarted(): void {
    if (!this.#armed) return;
    this.#armed = false;
    const tag = this.#tag;
    this.#tag = undefined;
    const from = this.#current;
    if (tag !== undefined && this.#levels.has(tag)) {
      if (tag !== from) this.#bed.set(tag);
      this.#current = tag;
    }
    this.#heard.push(this.#current);
    if (tag === undefined) this.#onChange({ from, to: from });
    else if (!this.#levels.has(tag)) this.#onChange({ tag, from, to: from, ignored: 'unknown_level' });
    else this.#onChange({ tag, from, to: tag });
  }

  /**
   * Copy of `chatCtx` for one LLM request whose earlier assistant replies open with the level they
   * left, e.g. `<bg:mid>…`. The committed history has no tags (subtitles come from it), and an LLM
   * shown its own untagged replies stops writing the tag after the first turn (Dolphin did).
   * Replies and heard levels are matched from the newest back.
   */
  withTaggedHistory(chatCtx: ChatContext): ChatContext {
    const assistant = chatCtx.items.flatMap((item, i) => (item.type === 'message' && item.role === 'assistant' ? [i] : []));
    if (assistant.length === 0 || this.#heard.length === 0) return chatCtx;
    const copy = chatCtx.copy();
    let k = this.#heard.length - 1;
    for (let a = assistant.length - 1; a >= 0 && k >= 0; a--, k--) {
      const index = assistant[a]!;
      const message = copy.items[index] as ChatMessage;
      const text = message.textContent ?? '';
      copy.items[index] = ChatMessage.create({
        role: 'assistant',
        content: `<${AMBIENCE_TAG}:${this.#heard[k]}>${text}`,
        id: message.id,
        createdAt: message.createdAt,
      });
    }
    return copy;
  }
}

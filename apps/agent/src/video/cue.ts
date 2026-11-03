import { ChatMessage, type ChatContext } from '@livekit/agents';

/** Agent participant attribute the page reads to pick a video playlist. */
export const ATTRIBUTE_VIDEO = 'ptoy.video';

export const VIDEO_TAG = 'video';

/** `common` and `takecup` pick a folder; `slow` / `mid` / `fast` are speeds inside usecup. */
export const VIDEO_SCENES = ['common', 'takecup', 'slow', 'mid', 'fast'] as const;
export type VideoScene = (typeof VIDEO_SCENES)[number];

const SCENES = new Set<string>(VIDEO_SCENES);

export function isVideoScene(value: string): value is VideoScene {
  return SCENES.has(value);
}

/**
 * Tells the model which `<video:…>` tag to write. Appended to the persona (with or without
 * `_rules.md`) so the page can switch clips. The tag is stripped before the reply is spoken.
 */
export function videoRules(): string {
  return [
    '## 画面标签（系统用，不会被念出来）',
    '每段回复的最开头先写一个画面标签 <video:档位>，再写要说的话。档位按这通电话到目前为止的情况判断，没变化就沿用上一档：',
    '- common：普通聊天，没有拿出、展示或使用飞机杯',
    '- takecup：这一轮才把飞机杯拿出来（只在刚拿出来时用，之后展示它改回别的档）',
    '- slow：正在使用飞机杯，动作慢',
    '- mid：正在使用飞机杯，动作中等',
    '- fast：正在使用飞机杯，动作快',
    '档位只能是 common、takecup、slow、mid、fast。每段回复只写一个标签，不要在正文里提到画面或标签。',
  ].join('\n');
}

/**
 * The call's video scene. A reply's tag counts once that reply starts playing; an untagged or
 * unknown tag keeps the previous scene. Earlier assistant lines are shown back to the model with
 * the scene they left, because the spoken history has the tag removed.
 */
export class VideoCue {
  #current: VideoScene = 'common';
  #armed = false;
  #tag: VideoScene | undefined;
  readonly #heard: VideoScene[] = [];

  get scene(): VideoScene {
    return this.#current;
  }

  /** A reply is being synthesized and has not started playing yet. */
  replyGenerating(): void {
    this.#armed = true;
    this.#tag = undefined;
  }

  /** The reply's first known `<video:…>` value. Later tags in the same reply are ignored. */
  tagged(value: string): void {
    if (this.#armed && this.#tag === undefined && isVideoScene(value)) this.#tag = value;
  }

  /**
   * The reply's audio started. Returns the scene to publish, or undefined when this call does
   * not close a generating reply (a filler, or a second speaking event for the same reply).
   */
  heard(): VideoScene | undefined {
    if (!this.#armed) return undefined;
    this.#armed = false;
    if (this.#tag !== undefined) this.#current = this.#tag;
    this.#tag = undefined;
    this.#heard.push(this.#current);
    return this.#current;
  }

  /** LLM request copy: each earlier assistant reply opens with the scene it left. */
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
        content: `<${VIDEO_TAG}:${this.#heard[k]}>${text}`,
        id: message.id,
        createdAt: message.createdAt,
      });
    }
    return copy;
  }
}

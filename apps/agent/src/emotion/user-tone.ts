import { ChatMessage, type ChatContext } from '@livekit/agents';
import { DEFAULT_EMOTION, type Emotion } from '@ptoy/segmenter';
import type { AsrEmotion } from '../stt/sensevoice.js';

/** SenseVoice emotion class → the tone word the LLM sees in `[用户语气:X]` (docs/architecture/emotion-pipeline.md). */
export const ASR_EMOTION_TONE: Readonly<Record<AsrEmotion, Emotion>> = Object.freeze({
  happy: '喜',
  angry: '怒',
  sad: '哀',
  fearful: '惧',
  disgusted: '厌恶',
  surprised: '惊喜',
  neutral: '平静',
  unknown: '平静',
});

/** Tone of one user turn: the last non-calm utterance wins (a turn may be several VAD utterances). */
export function turnTone(emotions: readonly AsrEmotion[]): Emotion {
  for (let i = emotions.length - 1; i >= 0; i--) {
    const tone = ASR_EMOTION_TONE[emotions[i]!];
    if (tone !== DEFAULT_EMOTION) return tone;
  }
  return DEFAULT_EMOTION;
}

/**
 * The user text as the LLM sees it: `[用户语气:怒] 我都说了三遍了`.
 * 平静 adds nothing: almost every turn is neutral, and a constant hint is just noise in the context.
 */
export function withTone(text: string, tone: Emotion): string {
  return tone === DEFAULT_EMOTION ? text : `[用户语气:${tone}] ${text}`;
}

/**
 * Copy of `chatCtx` whose last item — the user message being answered — carries the tone prefix.
 * Returns `chatCtx` itself when there is nothing to add. The original message is not touched:
 * the committed history, the user subtitle and the framework's preemptive-generation check keep
 * the raw transcript, so earlier turns reach the LLM without a prefix.
 */
export function withUserTone(chatCtx: ChatContext, toneOf: (text: string) => Emotion): ChatContext {
  const last = chatCtx.items.at(-1);
  if (last?.type !== 'message' || last.role !== 'user') return chatCtx;
  const text = last.textContent;
  const tone = text ? toneOf(text) : DEFAULT_EMOTION;
  if (!text || tone === DEFAULT_EMOTION) return chatCtx;
  const copy = chatCtx.copy();
  copy.items[copy.items.length - 1] = ChatMessage.create({
    role: 'user',
    content: withTone(text, tone),
    id: last.id,
    createdAt: last.createdAt,
  });
  return copy;
}

/** Recognized utterances kept for matching (a turn is rarely more than a few). */
const MAX_UTTERANCES = 8;

/**
 * Remembers the SenseVoice emotion of recent utterances and finds the tone of a user message.
 *
 * The framework joins a turn's utterances into one user message, and may start generating
 * (preemptive generation) before the turn is over, so the tone is looked up by text instead of
 * by timing: the newest utterances whose text is part of the message are that turn's.
 */
export class UserToneTracker {
  #utterances: { text: string; emotion: AsrEmotion }[] = [];

  utterance(text: string, emotion: AsrEmotion): void {
    this.#utterances = [...this.#utterances, { text, emotion }].slice(-MAX_UTTERANCES);
  }

  toneOf(message: string): Emotion {
    const turn: AsrEmotion[] = [];
    for (let i = this.#utterances.length - 1; i >= 0; i--) {
      const u = this.#utterances[i]!;
      if (!message.includes(u.text)) break;
      turn.unshift(u.emotion);
    }
    return turnTone(turn);
  }
}

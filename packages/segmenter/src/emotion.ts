/**
 * Canonical emotion set. The order is the IndexTTS2 emotion-vector order
 * (happy, angry, sad, afraid, disgusted, melancholic, surprised, calm).
 */
export const EMOTIONS = ["喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜", "平静"] as const;

export type Emotion = (typeof EMOTIONS)[number];

/** Used when a sentence has no tag, or its tag is unknown/malformed. */
export const DEFAULT_EMOTION: Emotion = "平静";

export function isEmotion(value: string): value is Emotion {
  return (EMOTIONS as readonly string[]).includes(value);
}

/** Index of each emotion in the IndexTTS2 8-dim emotion vector. */
export const EMOTION_VECTOR_INDEX: Readonly<Record<Emotion, number>> = Object.freeze(
  Object.fromEntries(EMOTIONS.map((e, i) => [e, i])) as Record<Emotion, number>,
);

/** One-hot IndexTTS2 emotion vector, e.g. emotionVector("哀") → [0,0,1,0,0,0,0,0]. */
export function emotionVector(emotion: Emotion, weight = 1): number[] {
  return EMOTIONS.map((e) => (e === emotion ? weight : 0));
}

/** Resolve the inside of a "[...]" tag; unknown content falls back to 平静. */
export function parseTag(inner: string): Emotion {
  const name = inner.trim();
  return isEmotion(name) ? name : DEFAULT_EMOTION;
}

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

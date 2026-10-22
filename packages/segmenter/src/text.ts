const graphemeSegmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** Split into user-perceived characters so cuts never break emoji or surrogate pairs. */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

const SENTENCE_END = new Set(["。", "！", "？", "；", "…", "!", "?", ";", "\n", "．"]);
const COMMA = new Set(["，", "、", ","]);
const CLOSER = new Set(["”", "’", "」", "』", "）", ")", "》", "〉", "〕"]);
const CONTENT = /[\p{L}\p{N}\p{S}]/u;
const DIGIT = /^\p{Nd}$/u;

/** Letters, numbers and symbols (incl. emoji) count as spoken/visible content; punctuation and whitespace do not. */
export function isContent(g: string): boolean {
  return CONTENT.test(g);
}

/** Characters that may trail a cut point and must not start the next segment. */
export function isTrailing(g: string): boolean {
  return SENTENCE_END.has(g) || COMMA.has(g) || g === "." || CLOSER.has(g);
}

export type Boundary = "sentence" | "comma" | "pending" | null;

/**
 * Classify the grapheme at i as a cut point. ASCII "." and "," inside a number
 * ("3.14", "1,000") are not boundaries; when that can't be decided yet because
 * the next character hasn't arrived, the result is "pending".
 */
export function boundaryAt(gs: readonly string[], i: number): Boundary {
  const g = gs[i]!;
  if (SENTENCE_END.has(g)) return "sentence";
  if (COMMA.has(g) && g !== ",") return "comma";
  if (g === "." || g === ",") {
    const kind = g === "." ? "sentence" : "comma";
    const prev = gs[i - 1];
    if (prev === undefined || !DIGIT.test(prev)) return kind;
    const next = gs[i + 1];
    if (next === undefined) return "pending";
    return DIGIT.test(next) ? null : kind;
  }
  return null;
}

/** Trim whitespace and drop leading punctuation left over from the previous cut. */
export function normalize(text: string): string {
  const gs = graphemes(text.trim());
  let start = 0;
  while (start < gs.length && (isTrailing(gs[start]!) || /^\s+$/u.test(gs[start]!))) start++;
  return gs.slice(start).join("").trim();
}

export function hasContent(text: string): boolean {
  return CONTENT.test(text);
}

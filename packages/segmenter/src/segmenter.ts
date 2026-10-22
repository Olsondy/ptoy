import { DEFAULT_EMOTION, parseTag, type Emotion } from "./emotion.ts";
import { boundaryAt, graphemes, hasContent, isContent, isTrailing, normalize } from "./text.ts";

export interface Segment {
  /** Clean text for TTS and subtitles: trimmed, never empty, never contains tags. */
  readonly text: string;
  readonly emotion: Emotion;
}

export interface SegmenterOptions {
  /**
   * The first segment is not cut before it has this many content characters,
   * so a bare "嗯，" is merged into the next clause. Default 2.
   */
  readonly firstSegmentMinChars?: number;
  /** Force-cut the first segment after this many content characters if no punctuation arrived. Default 12. */
  readonly firstSegmentMaxChars?: number;
  /**
   * Later segments longer than this many content characters without a sentence
   * ender are cut at the last comma inside the window, else hard-cut. Default 40.
   */
  readonly maxSegmentChars?: number;
  /**
   * "sentence" (default, per spec): a sentence without its own tag is 平静.
   * "untilNextTag": a tag's emotion carries over to later untagged sentences.
   */
  readonly emotionScope?: "sentence" | "untilNextTag";
  /**
   * "[" or "【" not closed by "]" / "】" within this many characters is kept as
   * literal text; anything closed within it is a tag (dropped if unknown). Default 10.
   */
  readonly maxTagChars?: number;
}

export const DEFAULT_OPTIONS: Required<SegmenterOptions> = {
  firstSegmentMinChars: 2,
  firstSegmentMaxChars: 12,
  maxSegmentChars: 40,
  emotionScope: "sentence",
  maxTagChars: 10,
};

const TAG_OPEN = new Set(["[", "【"]);
const TAG_CLOSE = new Set(["]", "】"]);

export interface Segmenter {
  /** Feed one LLM token (any chunking). Returns segments that became complete. */
  push(token: string): Segment[];
  /** End of reply: flush whatever is left and reset for the next reply. */
  end(): Segment[];
  /** Interruption: discard buffered text and reset for the next reply. */
  reset(): void;
}

type CutReason = "sentence" | "comma" | "length";

interface Cut {
  readonly end: number;
  readonly reason: CutReason;
}

export function createSegmenter(options: SegmenterOptions = {}): Segmenter {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  /** Raw input held back because it may be the start of a tag split across tokens. */
  let pending = "";
  /** Tag-free text not yet emitted; always has the single emotion `emotion`. */
  let buffer = "";
  let firstDone = false;
  let emotion: Emotion = DEFAULT_EMOTION;

  /**
   * Find the next cut in the buffer, or null if more input is needed.
   * A punctuation cut also takes the punctuation run / closing quotes after it;
   * if that run reaches the end of the buffer we wait, since the next token
   * may still extend it (e.g. "？" then "！", or "。" then "”").
   */
  function findCut(gs: readonly string[]): Cut | null {
    const minContent = firstDone ? 1 : opts.firstSegmentMinChars;
    const maxContent = firstDone ? opts.maxSegmentChars : opts.firstSegmentMaxChars;
    let content = 0;
    let lastCommaEnd: number | null = null;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]!;
      if (isContent(g)) {
        if (content === maxContent) return { end: lastCommaEnd ?? i, reason: "length" };
        content++;
        continue;
      }
      const b = boundaryAt(gs, i);
      if (b === "pending") return null;
      if (b === null || content < minContent) continue;
      let end = i + 1;
      while (end < gs.length && isTrailing(gs[end]!)) end++;
      if (b === "comma" && firstDone) {
        lastCommaEnd = end;
        continue;
      }
      if (end === gs.length) return null;
      return { end, reason: b };
    }
    return null;
  }

  function emit(text: string, out: Segment[]): void {
    const clean = normalize(text);
    if (!hasContent(clean)) return;
    out.push({ text: clean, emotion });
    firstDone = true;
  }

  function drain(out: Segment[]): void {
    for (;;) {
      const gs = graphemes(buffer);
      const cut = findCut(gs);
      if (!cut) return;
      emit(gs.slice(0, cut.end).join(""), out);
      buffer = gs.slice(cut.end).join("");
      if (cut.reason === "sentence" && opts.emotionScope === "sentence") emotion = DEFAULT_EMOTION;
    }
  }

  function pushText(text: string, out: Segment[]): void {
    buffer += text;
    drain(out);
  }

  /** A tag starts a new sentence: flush what came before it under the old emotion. */
  function pushTag(next: Emotion, out: Segment[]): void {
    emit(buffer, out);
    buffer = "";
    emotion = next;
  }

  /** Split raw input into text and tags; an incomplete "[..." at the end is kept in `pending`. */
  function consume(raw: string, out: Segment[]): void {
    let i = 0;
    while (i < raw.length) {
      let open = i;
      while (open < raw.length && !TAG_OPEN.has(raw[open]!)) open++;
      if (open > i) pushText(raw.slice(i, open), out);
      if (open === raw.length) return;

      let close = open + 1;
      let literal = false;
      for (; close < raw.length; close++) {
        const c = raw[close]!;
        if (TAG_CLOSE.has(c)) break;
        if (TAG_OPEN.has(c) || c === "\n" || close - open > opts.maxTagChars) {
          literal = true;
          break;
        }
      }
      if (literal) {
        pushText(raw[open]!, out);
        i = open + 1;
      } else if (close === raw.length) {
        pending = raw.slice(open);
        return;
      } else {
        pushTag(parseTag(raw.slice(open + 1, close)), out);
        i = close + 1;
      }
    }
  }

  function clear(): void {
    pending = "";
    buffer = "";
    firstDone = false;
    emotion = DEFAULT_EMOTION;
  }

  return {
    push(token) {
      const out: Segment[] = [];
      const raw = pending + token;
      pending = "";
      consume(raw, out);
      return out;
    },
    end() {
      const out: Segment[] = [];
      drain(out);
      emit(buffer, out);
      clear();
      return out;
    },
    reset: clear,
  };
}

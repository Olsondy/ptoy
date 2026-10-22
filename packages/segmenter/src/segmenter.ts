import { DEFAULT_EMOTION, type Emotion } from "./emotion.ts";
import { boundaryAt, graphemes, hasContent, isContent, isTrailing, normalize } from "./text.ts";

export interface Segment {
  /** Clean text for TTS and subtitles: trimmed, never empty, never contains tags. */
  readonly text: string;
  readonly emotion: Emotion;
}

export interface SegmenterOptions {}

export interface Segmenter {
  /** Feed one LLM token (any chunking). Returns segments that became complete. */
  push(token: string): Segment[];
  /** End of reply: flush whatever is left and reset for the next reply. */
  end(): Segment[];
  /** Interruption: discard buffered text and reset for the next reply. */
  reset(): void;
}

type CutReason = "sentence" | "comma";

interface Cut {
  readonly end: number;
  readonly reason: CutReason;
}

export function createSegmenter(_options: SegmenterOptions = {}): Segmenter {
  let buffer = "";
  let firstDone = false;
  let emotion: Emotion = DEFAULT_EMOTION;

  function findCut(gs: readonly string[]): Cut | null {
    let content = 0;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]!;
      if (isContent(g)) {
        content++;
        continue;
      }
      const b = boundaryAt(gs, i);
      if (b === "pending") return null;
      if (b === null || content < 1) continue;
      if (b === "comma" && firstDone) continue;
      let end = i + 1;
      while (end < gs.length && isTrailing(gs[end]!)) end++;
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
    }
  }

  function clear(): void {
    buffer = "";
    firstDone = false;
    emotion = DEFAULT_EMOTION;
  }

  return {
    push(token) {
      const out: Segment[] = [];
      buffer += token;
      drain(out);
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

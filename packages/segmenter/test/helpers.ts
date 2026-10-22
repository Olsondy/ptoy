import { createSegmenter, type Segment, type SegmenterOptions } from "../src/index.ts";

/** Feed tokens one by one, then end(); return every segment emitted. */
export function run(tokens: readonly string[], options?: SegmenterOptions): Segment[] {
  const s = createSegmenter(options);
  const out: Segment[] = [];
  for (const t of tokens) out.push(...s.push(t));
  out.push(...s.end());
  return out;
}

/** Split a string into single-code-unit tokens (worst-case chunking). */
export function chars(text: string): string[] {
  return text.split("");
}

export const texts = (segs: readonly Segment[]): string[] => segs.map((s) => s.text);

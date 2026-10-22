import { createSegmenter, type Segment, type SegmenterOptions } from "./segmenter.ts";

/**
 * Adapt an async LLM token stream to an async segment stream.
 * Segments are yielded as soon as they are complete; the tail is flushed when the
 * token stream ends. To interrupt, stop iterating (break / return()): buffered text
 * is dropped with the generator.
 */
export async function* segmentStream(
  tokens: AsyncIterable<string>,
  options?: SegmenterOptions,
): AsyncGenerator<Segment, void, undefined> {
  const segmenter = createSegmenter(options);
  for await (const token of tokens) yield* segmenter.push(token);
  yield* segmenter.end();
}

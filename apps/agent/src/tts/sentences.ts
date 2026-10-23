import { tokenize } from '@livekit/agents';

/** Sentence-final punctuation (CJK + ASCII) and trailing closers that stay with the sentence. */
const SENTENCE_END = /[。！？；!?;…\n]+[”’"'）)]*/gu;

const SUBSTANTIVE = /[\p{L}\p{N}]/u;

/**
 * Splits text after sentence-final punctuation, returning `[sentence, start, end]` spans as the
 * framework's buffered tokenizer expects. The tail without final punctuation is the last span.
 */
export function splitZhSentences(text: string): [string, number, number][] {
  const spans: [string, number, number][] = [];
  const add = (from: number, to: number) => {
    const sentence = text.slice(from, to).trim();
    if (!sentence) return;
    const prev = spans.at(-1);
    // Punctuation-only pieces (e.g. the `。` after `？”`) stay with the previous sentence.
    if (prev && !SUBSTANTIVE.test(sentence)) spans[spans.length - 1] = [text.slice(prev[1], to).trim(), prev[1], to];
    else spans.push([sentence, from, to]);
  };
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    add(start, end);
    start = end;
  }
  add(start, text.length);
  return spans;
}

/**
 * Per-sentence tokenizer for Chinese replies. The framework's `basic.SentenceTokenizer` only
 * splits on ASCII `.?!` and merges short sentences, so a whole Chinese reply would become one
 * synthesis. Each sentence here goes to TTS as soon as its final punctuation arrives.
 * #11 replaces this with `@ptoy/segmenter` (short first segment + emotion tags).
 */
export class ZhSentenceTokenizer extends tokenize.SentenceTokenizer {
  tokenize(text: string): string[] {
    return splitZhSentences(text).map(([s]) => s);
  }

  stream(): tokenize.SentenceStream {
    // minTokenLength 1: emit every sentence alone (merging would join them with a space).
    return new tokenize.BufferedSentenceStream(splitZhSentences, 1, 1) as unknown as tokenize.SentenceStream;
  }
}

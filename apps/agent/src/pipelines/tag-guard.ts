/** Same rule as `@ptoy/segmenter`: `[`/`【` closed within this many characters is a tag. */
const MAX_TAG_CHARS = 10;
const CLOSER: Readonly<Record<string, string>> = { '[': ']', '【': '】' };

/**
 * Streaming guard that removes `[...]` / `【...】` tags (e.g. a stray `[喜]`) from LLM text before
 * it reaches TTS and subtitles. Tags split across chunks are held back until they close.
 * An opener not closed within {@link MAX_TAG_CHARS} is kept as text; a half tag left at the end
 * is dropped. #11 replaces this with the segmenter, which parses the tags instead.
 */
export class TagStripper {
  #pending = '';

  /** Feeds one chunk; returns the text that is safe to emit now. */
  push(chunk: string): string {
    let out = '';
    for (const ch of chunk) {
      if (this.#pending) {
        this.#pending += ch;
        const closer = CLOSER[this.#pending[0] as string];
        if (ch === closer) {
          this.#pending = '';
        } else if ([...this.#pending].length > MAX_TAG_CHARS + 1) {
          out += this.#pending;
          this.#pending = '';
        }
      } else if (ch in CLOSER) {
        this.#pending = ch;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /** Ends the stream: an unclosed tag is dropped. */
  end(): string {
    this.#pending = '';
    return '';
  }
}

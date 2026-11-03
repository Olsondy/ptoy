/**
 * A `{"reply":"…","intensity":"…"}` object the model sometimes wraps its reply in. Speech and
 * subtitles keep `reply` only, decoded as it streams in, so the first sentence is not held until
 * the object closes. The scanner is fed the input after the opening `{`.
 */
export interface ReplyJsonScanner {
  /**
   * Decoded `reply` characters from `input`. Once the object closes, `rest` is the input after it,
   * and `raw` is the whole object when it had no string `reply` field (speak it as-is).
   */
  feed(input: string): { readonly text: string; readonly closed: false } | { readonly text: string; readonly closed: true; readonly rest: string; readonly raw?: string };
  /** The object text so far when the reply ended inside an object that had no `reply` field. */
  unfinished(): string | undefined;
}

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: " ", r: "", b: "", f: "" };

export function createReplyJsonScanner(): ReplyJsonScanner {
  let raw = "{";
  let depth = 1;
  let inString = false;
  let escape = false;
  let unicode: string | undefined;
  let expect: "key" | "value" = "key";
  let readingKey = false;
  let key = "";
  let inReply = false;
  let sawReply = false;

  function take(c: string): string {
    if (inReply) return c;
    if (readingKey) key += c;
    return "";
  }

  return {
    feed(input) {
      let text = "";
      for (let i = 0; i < input.length; i++) {
        const c = input[i]!;
        raw += c;
        if (unicode !== undefined) {
          unicode += c;
          if (unicode.length === 4) {
            const code = Number.parseInt(unicode, 16);
            if (!Number.isNaN(code)) text += take(String.fromCharCode(code));
            unicode = undefined;
          }
          continue;
        }
        if (inString) {
          if (escape) {
            escape = false;
            if (c === "u") unicode = "";
            else text += take(ESCAPES[c] ?? c);
          } else if (c === "\\") escape = true;
          else if (c === '"') {
            inString = false;
            readingKey = false;
            inReply = false;
          } else text += take(c);
          continue;
        }
        if (c === '"') {
          inString = true;
          if (depth !== 1) continue;
          if (expect === "key") {
            readingKey = true;
            key = "";
          } else if (key === "reply" && !sawReply) {
            inReply = true;
            sawReply = true;
          }
        } else if (depth === 1 && c === ":") expect = "value";
        else if (depth === 1 && c === ",") expect = "key";
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) {
            const rest = input.slice(i + 1);
            return sawReply ? { text, closed: true, rest } : { text, closed: true, rest, raw };
          }
        }
      }
      return { text, closed: false };
    },
    unfinished() {
      return sawReply ? undefined : raw;
    },
  };
}

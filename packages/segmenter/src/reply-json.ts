/**
 * A leading `{"reply":"…","intensity":"…"}` object the model writes after `<video:…>`.
 * Speech and subtitles keep `reply` only. Incomplete input stays buffered.
 */
export function leadingReplyJson(input: string): { reply: string; rest: string } | "incomplete" | "not-json" {
  if (!input.startsWith("{")) return "not-json";
  let i = 1;
  while (i < input.length && /\s/.test(input[i]!)) i++;
  if (i >= input.length) return "incomplete";
  if (input[i] !== '"') return "not-json";
  const split = splitObject(input);
  if (split === "incomplete") return "incomplete";
  try {
    const value = JSON.parse(split.json) as { reply?: unknown };
    if (typeof value.reply !== "string") return { reply: split.json, rest: split.rest };
    return { reply: value.reply, rest: split.rest };
  } catch {
    return { reply: split.json, rest: split.rest };
  }
}

function splitObject(input: string): { json: string; rest: string } | "incomplete" {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { json: input.slice(0, i + 1), rest: input.slice(i + 1) };
    }
  }
  return "incomplete";
}

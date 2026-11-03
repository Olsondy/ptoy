import { describe, expect, it } from "vitest";
import { createSegmenter } from "../src/index.ts";
import { chars, run, texts } from "./helpers.ts";

const REPLY = { emotionScope: "reply" } as const;

describe("reply JSON after the video tag", () => {
  it("speaks only the reply field and still keeps the video scene", () => {
    const segs = run(['<video:takecup>{"reply":"来了，就放在身边了。","intensity":"low"}'], REPLY);
    expect(texts(segs)).toEqual(["来了，", "就放在身边了。"]);
    expect(segs.every((s) => s.video === "takecup")).toBe(true);
    expect(texts(segs).join("")).not.toContain("intensity");
    expect(texts(segs).join("")).not.toContain("{");
  });

  it("unwraps the object when it arrives in pieces", () => {
    const whole = '<video:slow>{"reply":"慢慢来。","intensity":"low"}';
    expect(texts(run(chars(whole), REPLY)).join("")).toBe("慢慢来。");
  });

  it("leaves a brace that is not a reply object in the speech", () => {
    expect(texts(run(["好{呀}。"], REPLY)).join("")).toBe("好{呀}。");
  });

  it("emits the first sentence before the object closes", () => {
    const s = createSegmenter(REPLY);
    const early = chars('<video:slow>{"reply":"第一句话说完了。第二句').flatMap((c) => s.push(c));
    expect(texts(early)).toEqual(["第一句话说完了。"]);
    expect(texts([...s.push('。","intensity":"low"}'), ...s.end()])).toEqual(["第二句。"]);
  });

  it("finds reply after other fields and decodes escapes split across tokens", () => {
    const whole = '{"intensity":"low","reply":"他说\\"好\\"\\u3002然后走了。"}';
    expect(texts(run(chars(whole), REPLY)).join("")).toBe('他说"好"。然后走了。');
  });

  it("does not hold the reply on a brace later in the text", () => {
    const s = createSegmenter(REPLY);
    const early = chars('他说{"好"，然后第一句话说完了。第二句').flatMap((c) => s.push(c));
    expect(texts(early).join("")).toBe('他说{"好"，然后第一句话说完了。');
  });

  it("speaks an object without a reply field as written", () => {
    expect(texts(run(chars('{"mood":"low"}好的。'), REPLY)).join("")).toBe('{"mood":"low"}好的。');
  });

  it("parses an emotion tag inside the reply field instead of speaking it", () => {
    const segs = run(['<video:common>{"reply":"[喜]今天真开心。","intensity":"low"}'], REPLY);
    expect(texts(segs)).toEqual(["今天真开心。"]);
    expect(segs.every((s) => s.emotion === "喜")).toBe(true);
    expect(segs.every((s) => s.video === "common")).toBe(true);
  });
});

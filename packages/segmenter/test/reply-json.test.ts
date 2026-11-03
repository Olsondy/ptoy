import { describe, expect, it } from "vitest";
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

  it("parses an emotion tag inside the reply field instead of speaking it", () => {
    const segs = run(['<video:common>{"reply":"[喜]今天真开心。","intensity":"low"}'], REPLY);
    expect(texts(segs)).toEqual(["今天真开心。"]);
    expect(segs.every((s) => s.emotion === "喜")).toBe(true);
    expect(segs.every((s) => s.video === "common")).toBe(true);
  });
});

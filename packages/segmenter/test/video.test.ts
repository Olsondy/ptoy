import { describe, expect, it } from "vitest";
import { chars, run, texts } from "./helpers.ts";

const REPLY = { emotionScope: "reply" } as const;

describe("video tag <video:…>", () => {
  it("is removed from speech and carried on every segment of the reply", () => {
    const segs = run(["<video:takecup>", "[平静]我拿出来了，", "给你看。"], REPLY);
    expect(texts(segs)).toEqual(["我拿出来了，", "给你看。"]);
    expect(segs.map((s) => s.video)).toEqual(["takecup", "takecup"]);
  });

  it("keeps the first known scene when a later tag disagrees", () => {
    const segs = run(["<video:slow>慢慢来。<video:fast>再快点。"], REPLY);
    expect(texts(segs)).toEqual(["慢慢来。", "再快点。"]);
    expect(segs.every((s) => s.video === "slow")).toBe(true);
  });

  it("drops an unknown scene without speaking the tag", () => {
    expect(run(["<video:nope>还在聊天。"], REPLY)).toEqual([{ text: "还在聊天。", emotion: "平静" }]);
  });

  it("is recognized when the tag is split across tokens", () => {
    expect(run(chars("<video:fast>快点。"), REPLY)).toEqual([{ text: "快点。", emotion: "平静", video: "fast" }]);
  });
});

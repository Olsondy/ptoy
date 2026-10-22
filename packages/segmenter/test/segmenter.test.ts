import { describe, expect, it } from "vitest";
import { createSegmenter } from "../src/index.ts";
import { chars, run, texts } from "./helpers.ts";

describe("first segment", () => {
  it("is emitted as soon as the first comma arrives", () => {
    const s = createSegmenter();
    expect(s.push("好的呀")).toEqual([]);
    expect(s.push("，我们")).toEqual([{ text: "好的呀，", emotion: "平静" }]);
  });

  it("cuts at a sentence ender if it comes before any comma", () => {
    expect(texts(run(["好的呀！我们走吧，", "现在就出发。"]))).toEqual([
      "好的呀！",
      "我们走吧，现在就出发。",
    ]);
  });
});

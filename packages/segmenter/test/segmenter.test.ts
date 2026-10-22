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

describe("first segment guards", () => {
  it("merges a too-short opener like 嗯， into the next clause", () => {
    expect(texts(run(chars("嗯，好的，我们走吧。")))).toEqual(["嗯，好的，", "我们走吧。"]);
  });

  it("is force-cut after 12 characters when no punctuation shows up", () => {
    const out = texts(run(chars("一二三四五六七八九十甲乙丙丁戊，然后。")));
    expect(out[0]).toBe("一二三四五六七八九十甲乙");
    expect(out.slice(1)).toEqual(["丙丁戊，然后。"]);
  });

  it("honours custom first-segment limits", () => {
    const opts = { firstSegmentMinChars: 1, firstSegmentMaxChars: 4 };
    expect(texts(run(chars("嗯，好的。"), opts))).toEqual(["嗯，", "好的。"]);
    expect(texts(run(chars("一二三四五六，好。"), opts))).toEqual(["一二三四", "五六，好。"]);
  });
});

describe("subsequent segments", () => {
  it("cut only at sentence-ending punctuation, not at commas", () => {
    expect(texts(run(chars("好的，我知道了，你说得对。那我们明天见！好吗？嗯；再见…")))).toEqual([
      "好的，",
      "我知道了，你说得对。",
      "那我们明天见！",
      "好吗？",
      "嗯；",
      "再见…",
    ]);
  });

  it("keep punctuation runs and closing quotes with the sentence they end", () => {
    expect(texts(run(chars("真的吗？！他说：“好的。”然后走了……再见。")))).toEqual([
      "真的吗？！",
      "他说：“好的。”",
      "然后走了……",
      "再见。",
    ]);
  });

  it("wait for the next character so a closing quote in a later token stays attached", () => {
    const s = createSegmenter();
    expect(s.push("真的吗。")).toEqual([]);
    expect(s.push("”")).toEqual([]);
    expect(texts(s.push("好"))).toEqual(["真的吗。”"]);
    expect(texts(s.end())).toEqual(["好"]);
  });

  it("cut at newlines", () => {
    expect(texts(run(chars("第一点很重要\n第二点也是\n")))).toEqual(["第一点很重要", "第二点也是"]);
  });
});

describe("ASCII punctuation", () => {
  it("is treated like its full-width counterpart", () => {
    expect(texts(run(chars("OK, sounds good. Let's go! Ready? Yes; done")))).toEqual([
      "OK,",
      "sounds good.",
      "Let's go!",
      "Ready?",
      "Yes;",
      "done",
    ]);
  });

  it("does not cut inside numbers", () => {
    expect(texts(run(chars("圆周率是3.14，人口有1,000万。")))).toEqual(["圆周率是3.14，", "人口有1,000万。"]);
  });

  it("waits for the next character before deciding on a period after a digit", () => {
    const s = createSegmenter({ firstSegmentMinChars: 1 });
    expect(s.push("版本3.")).toEqual([]);
    expect(texts(s.push("0好"))).toEqual([]);
    expect(texts(s.end())).toEqual(["版本3.0好"]);
  });
});

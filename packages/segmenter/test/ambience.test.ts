import { describe, expect, it } from "vitest";
import { createSegmenter } from "../src/index.ts";
import { chars, run, texts } from "./helpers.ts";

const REPLY = { emotionScope: "reply" } as const;

describe("ambience tag <bg:…>", () => {
  it("is removed from the text and carried on the reply's segments", () => {
    const segs = run(["<bg:mid>", "[喜]你来啦，", "我等你好久了。"], REPLY);
    expect(texts(segs)).toEqual(["你来啦，", "我等你好久了。"]);
    expect(segs.map((s) => s.ambience)).toEqual(["mid", "mid"]);
    expect(segs.map((s) => s.emotion)).toEqual(["喜", "喜"]);
  });

  it("is recognized when split across tokens, before or after the emotion tag", () => {
    expect(run(chars("<bg:high>[怒]别停下来。"), REPLY)).toEqual([{ text: "别停下来。", emotion: "怒", ambience: "high" }]);
    expect(run(chars("[怒]<bg:high>别停下来。"), REPLY)).toEqual([{ text: "别停下来。", emotion: "怒", ambience: "high" }]);
  });

  it("keeps the reply's first tag; later ones are dropped without cutting a segment", () => {
    const segs = run(["<bg:low>慢慢来<bg:climax>，", "不着急哦。"], REPLY);
    expect(texts(segs)).toEqual(["慢慢来，", "不着急哦。"]);
    expect(segs.map((s) => s.ambience)).toEqual(["low", "low"]);
  });

  it("does not cut the first segment where the tag stands", () => {
    expect(texts(run(["你好呀<bg:low>，我在呢。"], REPLY))).toEqual(["你好呀，", "我在呢。"]);
  });

  it("passes an unknown level through for the caller to judge, still removed from the text", () => {
    expect(run(["<bg:wild>好呀。"], REPLY)).toEqual([{ text: "好呀。", emotion: "平静", ambience: "wild" }]);
  });

  it("drops other <key:value> directives without setting the ambience", () => {
    expect(run(["<fx:rain>下雨了。"], REPLY)).toEqual([{ text: "下雨了。", emotion: "平静" }]);
  });

  it("leaves a reply without the tag with no ambience", () => {
    expect(run(["[哀]我有点累了。"], REPLY)).toEqual([{ text: "我有点累了。", emotion: "哀" }]);
  });

  it("keeps angle brackets that are not a directive as literal text", () => {
    expect(texts(run(["我爱你<3，", "真的。"]))).toEqual(["我爱你<3，", "真的。"]);
    expect(texts(run(["a<b 才对。"]))).toEqual(["a<b 才对。"]);
    expect(texts(run(chars("比分是2<3。")))).toEqual(["比分是2<3。"]);
  });

  it("starts each reply without the previous reply's ambience", () => {
    const s = createSegmenter(REPLY);
    expect([...s.push("<bg:mid>第一句话说完。"), ...s.end()].map((x) => x.ambience)).toEqual(["mid"]);
    expect([...s.push("第二段没有标签。"), ...s.end()].map((x) => x.ambience)).toEqual([undefined]);
    s.push("<bg:high>被打断");
    s.reset();
    expect([...s.push("重新开始。"), ...s.end()].map((x) => x.ambience)).toEqual([undefined]);
  });
});

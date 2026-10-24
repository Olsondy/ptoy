import { describe, expect, it } from "vitest";
import { createSegmenter, EMOTION_VECTOR_INDEX, EMOTIONS, emotionVector } from "../src/index.ts";
import { chars, run } from "./helpers.ts";

describe("emotion tags", () => {
  it("apply to the sentence they prefix and never reach the output text", () => {
    expect(run(chars("[喜]太好了，我们出发吧！[哀]可惜下雨了。"))).toEqual([
      { text: "太好了，", emotion: "喜" },
      { text: "我们出发吧！", emotion: "喜" },
      { text: "可惜下雨了。", emotion: "哀" },
    ]);
  });

  it("parse every emotion in the canonical set", () => {
    for (const e of EMOTIONS) {
      expect(run([`[${e}]好的好的。`])).toEqual([{ text: "好的好的。", emotion: e }]);
    }
  });

  it("parse correctly when split across tokens", () => {
    expect(run(["[厌", "恶]真", "受不了，", "[", "惊", "喜", "]哇", "！"])).toEqual([
      { text: "真受不了，", emotion: "厌恶" },
      { text: "哇！", emotion: "惊喜" },
    ]);
  });

  it("fall back to 平静 when a sentence has no tag", () => {
    expect(run(chars("[怒]你怎么才来！好吧，没关系。"))).toEqual([
      { text: "你怎么才来！", emotion: "怒" },
      { text: "好吧，没关系。", emotion: "平静" },
    ]);
  });

  it("keep a repeated tag on the next sentence even when the emotion does not change", () => {
    expect(run(chars("[喜]太好了。[喜]走吧。"))).toEqual([
      { text: "太好了。", emotion: "喜" },
      { text: "走吧。", emotion: "喜" },
    ]);
  });

  it("can instead carry the last emotion forward until the next tag", () => {
    expect(run(chars("[怒]你怎么才来！好吧。[喜]走吧。"), { emotionScope: "untilNextTag" })).toEqual([
      { text: "你怎么才来！", emotion: "怒" },
      { text: "好吧。", emotion: "怒" },
      { text: "走吧。", emotion: "喜" },
    ]);
  });

  it("can instead keep the first tag's emotion for the whole reply", () => {
    const seg = createSegmenter({ emotionScope: "reply" });
    const reply = (s: string) => [...chars(s).flatMap((t) => seg.push(t)), ...seg.end()];
    expect(reply("[哀]唉，辛苦啦。[喜]不过我挺佩服你的。[平静]早点睡。")).toEqual([
      { text: "唉，辛苦啦。", emotion: "哀" },
      { text: "不过我挺佩服你的。", emotion: "哀" },
      { text: "早点睡。", emotion: "哀" },
    ]);
    expect(reply("[喜]好呀！[哀]唉。")).toEqual([
      { text: "好呀！", emotion: "喜" },
      { text: "唉。", emotion: "喜" },
    ]);
  });

  it("in reply scope a later tag does not cut, so short sentences can still merge", () => {
    expect(run(chars("[哀]累成这样啊，[哀]真辛苦。[平静]要不要我给你讲个故事？"), { emotionScope: "reply", minSegmentChars: 10 })).toEqual([
      { text: "累成这样啊，", emotion: "哀" },
      { text: "真辛苦。要不要我给你讲个故事？", emotion: "哀" },
    ]);
  });

  it("treat unknown or malformed bracket content as 平静 and drop it from the text", () => {
    expect(run(chars("[开心]好的好的。[用户语气:喜]嗯嗯。【喜】行吧。[ 哀 ]唉。"))).toEqual([
      { text: "好的好的。", emotion: "平静" },
      { text: "嗯嗯。", emotion: "平静" },
      { text: "行吧。", emotion: "喜" },
      { text: "唉。", emotion: "哀" },
    ]);
  });

  it("keep a bracket as literal text when it never closes within the tag length limit", () => {
    expect(run(chars("[这其实不是一个标签，而是一段话。"))).toEqual([
      { text: "[这其实不是一个标签，", emotion: "平静" },
      { text: "而是一段话。", emotion: "平静" },
    ]);
  });

  it("drop an unclosed tag fragment at the end of the reply", () => {
    expect(run(["好的好的。[厌"])).toEqual([{ text: "好的好的。", emotion: "平静" }]);
  });

  it("cut the buffer when the emotion changes mid-sentence", () => {
    expect(run(chars("好的好的，[喜]我们走[哀]还是算了。"))).toEqual([
      { text: "好的好的，", emotion: "平静" },
      { text: "我们走", emotion: "喜" },
      { text: "还是算了。", emotion: "哀" },
    ]);
  });

  it("emit nothing for a reply that is only tags and whitespace", () => {
    const s = createSegmenter();
    expect(s.push("[喜]  ")).toEqual([]);
    expect(s.push("\n[哀]")).toEqual([]);
    expect(s.end()).toEqual([]);
  });
});

describe("IndexTTS2 emotion vector mapping", () => {
  it("maps emotions to indices 0..7 in the canonical order", () => {
    expect(EMOTION_VECTOR_INDEX).toEqual({ 喜: 0, 怒: 1, 哀: 2, 惧: 3, 厌恶: 4, 低落: 5, 惊喜: 6, 平静: 7 });
  });

  it("builds a one-hot vector with an optional weight", () => {
    expect(emotionVector("哀")).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
    expect(emotionVector("平静", 0.6)).toEqual([0, 0, 0, 0, 0, 0, 0, 0.6]);
  });
});

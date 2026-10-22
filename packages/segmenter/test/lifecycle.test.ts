import { describe, expect, it } from "vitest";
import { createSegmenter, segmentStream, type Segment } from "../src/index.ts";
import { chars, run, texts } from "./helpers.ts";

describe("end of reply", () => {
  it("flushes the remaining text as a final segment", () => {
    const s = createSegmenter();
    expect(texts(s.push("好的，我们明天"))).toEqual(["好的，"]);
    expect(s.push("再说")).toEqual([]);
    expect(texts(s.end())).toEqual(["我们明天再说"]);
  });

  it("flushes a short first segment that never reached a cut", () => {
    expect(run(["嗯"])).toEqual([{ text: "嗯", emotion: "平静" }]);
  });

  it("skips a tail that is only whitespace or punctuation", () => {
    expect(texts(run(["好的好的。", "  \n", "”"]))).toEqual(["好的好的。"]);
  });

  it("starts the next reply with first-segment rules again", () => {
    const s = createSegmenter();
    s.push("好的，我们走吧。");
    s.end();
    expect(texts(s.push("行吧，那就"))).toEqual(["行吧，"]);
  });

  it("never emits empty or untrimmed segments", () => {
    const out = run(chars("  [喜]  好的 ， 走吧 。 \n\n 。。 [哀] \n 唉 "));
    expect(out).toEqual([
      { text: "好的 ，", emotion: "喜" },
      { text: "走吧 。", emotion: "喜" },
      { text: "唉", emotion: "哀" },
    ]);
  });
});

describe("interruption", () => {
  it("reset() discards buffered text, a half-read tag and the current emotion", () => {
    const s = createSegmenter();
    expect(texts(s.push("[怒]你听我说，这件事其实"))).toEqual(["你听我说，"]);
    s.push("[厌");
    s.reset();
    expect(s.push("恶]")).toEqual([]);
    expect(s.end()).toEqual([{ text: "恶]", emotion: "平静" }]);
  });

  it("reset() restores first-segment rules for the next reply", () => {
    const s = createSegmenter();
    s.push("好的，我们");
    s.reset();
    expect(s.push("行吧，那就")).toEqual([{ text: "行吧，", emotion: "平静" }]);
    expect(s.end()).toEqual([{ text: "那就", emotion: "平静" }]);
  });
});

describe("multi-byte safety", () => {
  it("never splits emoji, ZWJ sequences or surrogate pairs when hard-cutting", () => {
    const family = "👨‍👩‍👧";
    const body = `${family}😀`.repeat(10);
    const out = run(chars(`好的，${body}`), { maxSegmentChars: 3 });
    const joined = out.slice(1).map((s) => s.text).join("");
    expect(joined).toBe(body);
    for (const s of out.slice(1)) expect([...new Intl.Segmenter().segment(s.text)].length).toBeLessThanOrEqual(3);
    for (const s of out) expect(s.text.isWellFormed()).toBe(true);
  });

  it("keeps emoji next to punctuation intact", () => {
    expect(texts(run(chars("太棒了😀！我们走吧🎉。")))).toEqual(["太棒了😀！", "我们走吧🎉。"]);
  });
});

describe("segmentStream", () => {
  async function* from(tokens: readonly string[]): AsyncGenerator<string> {
    for (const t of tokens) yield t;
  }

  it("adapts an async token stream to an async segment stream, flushing at the end", async () => {
    const out: Segment[] = [];
    for await (const seg of segmentStream(from(["[喜]好的", "，我们", "走吧。", "[哀]唉"]))) out.push(seg);
    expect(out).toEqual([
      { text: "好的，", emotion: "喜" },
      { text: "我们走吧。", emotion: "喜" },
      { text: "唉", emotion: "哀" },
    ]);
  });

  it("yields a segment before the token stream finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* tokens(): AsyncGenerator<string> {
      yield "好的，我";
      await gate;
      yield "们走吧。";
    }
    const it = segmentStream(tokens())[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ text: "好的，", emotion: "平静" });
    release();
    expect((await it.next()).value).toEqual({ text: "我们走吧。", emotion: "平静" });
    expect((await it.next()).done).toBe(true);
  });
});

describe("options", () => {
  it("rejects limits that cannot produce segments", () => {
    expect(() => createSegmenter({ maxSegmentChars: 0 })).toThrow(RangeError);
    expect(() => createSegmenter({ firstSegmentMinChars: 5, firstSegmentMaxChars: 4 })).toThrow(RangeError);
    expect(() => createSegmenter({ maxTagChars: 1.5 })).toThrow(RangeError);
  });
});

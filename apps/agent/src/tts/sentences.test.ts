import { describe, expect, it } from 'vitest';
import { splitZhSentences } from './sentences.js';

const split = (text: string) => splitZhSentences(text).map(([s]) => s);

describe('splitZhSentences', () => {
  it('splits after Chinese and ASCII sentence-final punctuation, keeping closers', () => {
    expect(split('你好呀！今天怎么样？我说“好的。”然后呢')).toEqual(['你好呀！', '今天怎么样？', '我说“好的。”', '然后呢']);
  });

  it('keeps punctuation-only pieces with the previous sentence', () => {
    expect(split('你说的是“你是谁？”。还想聊什么？')).toEqual(['你说的是“你是谁？”。', '还想聊什么？']);
  });
});

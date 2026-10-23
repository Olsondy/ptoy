import { describe, expect, it } from 'vitest';
import { TagStripper } from './tag-guard.js';

const strip = (chunks: string[]) => {
  const s = new TagStripper();
  return chunks.map((c) => s.push(c)).join('') + s.end();
};

describe('TagStripper', () => {
  it('removes emotion tags, also when split across chunks', () => {
    expect(strip(['[喜]你好呀！', '[平', '静]今天', '怎么样？'])).toBe('你好呀！今天怎么样？');
    expect(strip(['【惊喜】真的吗？'])).toBe('真的吗？');
  });

  it('keeps brackets that do not close within 10 characters as text', () => {
    expect(strip(['我说[这是一段很长的没有闭合的括号内容', '呢'])).toBe('我说[这是一段很长的没有闭合的括号内容呢');
  });

  it('drops a half tag left at the end of the reply', () => {
    expect(strip(['好的。[平'])).toBe('好的。');
  });
});

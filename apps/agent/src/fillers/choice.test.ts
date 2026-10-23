import { describe, expect, it } from 'vitest';
import { FillerPicker, type FillerGroup, chooseFillerGroup } from './choice.js';

describe('chooseFillerGroup', () => {
  it.each<[string, FillerGroup]>([
    ['你叫什么名字？', 'thinking'],
    ['今天天气怎么样', 'thinking'],
    ['你喜欢猫吗', 'thinking'],
    ['为什么天是蓝的', 'thinking'],
    ['帮我想个名字', 'ack'],
    ['你可以给我讲个故事吗？', 'ack'],
    ['那我们周末一起去爬山好不好？', 'ack'],
    ['麻烦你再说一遍', 'ack'],
    ['你好', 'ack'],
    ['我刚下班。', 'ack'],
    ['我今天好累啊', 'empathy'],
    ['我好难过，怎么办？', 'empathy'],
    ['唉，又被老板骂了', 'empathy'],
  ])('%s → %s', (text, group) => {
    expect(chooseFillerGroup(text)).toBe(group);
  });

  it('a negative ASR emotion makes it empathy', () => {
    expect(chooseFillerGroup('今天天气怎么样', 'sad')).toBe('empathy');
    expect(chooseFillerGroup('今天天气怎么样', 'happy')).toBe('thinking');
  });
});

const groups = (spec: Partial<Record<FillerGroup, string[]>>) =>
  new Map(Object.entries(spec).map(([g, ids]) => [g as FillerGroup, ids.map((id) => ({ id }))]));

/** Deterministic "random" cycling through the given values. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

describe('FillerPicker', () => {
  it('picks from the requested group', () => {
    const picker = new FillerPicker(groups({ thinking: ['t1', 't2'], ack: ['a1'] }), seq(0));
    expect(picker.pick('thinking')?.id).toBe('t1');
  });

  it('never repeats the previous filler, even when the random source would', () => {
    const picker = new FillerPicker(groups({ thinking: ['t1', 't2', 't3'], ack: ['a1', 'a2'] }), seq(0));
    const ids = ['thinking', 'thinking', 'thinking', 'ack', 'ack', 'thinking'].map((g) => picker.pick(g as FillerGroup)?.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
  });

  it('never repeats over many random turns', () => {
    const picker = new FillerPicker(groups({ thinking: ['t1', 't2'], ack: ['a1', 'a2', 'a3'], empathy: ['e1', 'e2'] }));
    const order: FillerGroup[] = ['thinking', 'ack', 'empathy'];
    let last: string | undefined;
    for (let i = 0; i < 300; i++) {
      const id = picker.pick(order[i % 7 < 4 ? 0 : i % 3]!)?.id;
      expect(id).toBeDefined();
      expect(id).not.toBe(last);
      last = id;
    }
  });

  it('falls back to another filler when the group only has the previous one', () => {
    const picker = new FillerPicker(groups({ empathy: ['e1'], ack: ['a1'] }), seq(0));
    expect(picker.pick('empathy')?.id).toBe('e1');
    expect(picker.pick('empathy')?.id).toBe('a1');
    expect(picker.pick('empathy')?.id).toBe('e1');
  });

  it('falls back to ack for an empty group, and returns undefined with no fillers at all', () => {
    expect(new FillerPicker(groups({ ack: ['a1'] }), seq(0)).pick('empathy')?.id).toBe('a1');
    expect(new FillerPicker(groups({})).pick('ack')).toBeUndefined();
  });
});

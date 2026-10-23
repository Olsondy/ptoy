import { describe, expect, it } from 'vitest';
import { isBackchannel } from './backchannel.js';
import { looksUnfinished } from './endpointing.js';

describe('looksUnfinished', () => {
  it.each(['我觉得', '我觉得。', '如果明天不下雨的话', '那个', '我今天去了超市，', '然后', '我想问一下', '我和'])(
    '"%s" waits for more',
    (text) => expect(looksUnfinished(text)).toBe(true),
  );
  it.each(['你好', '你叫什么名字？', '我今天好累啊。', '周末去爬山吧！', '好的', '嗯', ''])('"%s" is complete', (text) =>
    expect(looksUnfinished(text)).toBe(false),
  );
});

describe('isBackchannel', () => {
  it.each(['嗯', '嗯嗯。', '对对对', '好的', '是的，', '哦'])('"%s" is feedback', (text) => expect(isBackchannel(text)).toBe(true));
  it.each(['等一下', '不对', '好的我知道了但是', '嗯，我想问一下', ''])('"%s" takes the turn', (text) =>
    expect(isBackchannel(text)).toBe(false),
  );
});

import { ChatContext } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { VideoCue, videoRules } from './cue.js';

describe('VideoCue', () => {
  it('stays on common until a reply with a known tag is heard', () => {
    const cue = new VideoCue();
    expect(cue.scene).toBe('common');
    cue.replyGenerating();
    cue.tagged('nope');
    expect(cue.heard()).toBe('common');
    cue.replyGenerating();
    cue.tagged('takecup');
    cue.tagged('fast');
    expect(cue.heard()).toBe('takecup');
    expect(cue.heard()).toBeUndefined();
  });

  it('prefixes earlier replies with the scene they left', () => {
    const cue = new VideoCue();
    cue.replyGenerating();
    cue.tagged('slow');
    cue.heard();
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'assistant', content: '第一句。' });
    ctx.addMessage({ role: 'user', content: '继续。' });
    const tagged = cue.withTaggedHistory(ctx);
    expect(tagged.items[0]).toMatchObject({ role: 'assistant' });
    expect((tagged.items[0] as { textContent?: string }).textContent).toBe('<video:slow>第一句。');
    expect(ctx.items[0]).toMatchObject({ textContent: '第一句。' });
  });
});

describe('videoRules', () => {
  it('names every scene the page can play', () => {
    const rules = videoRules();
    for (const scene of ['common', 'takecup', 'slow', 'mid', 'fast']) expect(rules).toContain(scene);
    expect(rules).toContain('<video:档位>');
  });
});

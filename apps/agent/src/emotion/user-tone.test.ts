import { ChatContext } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { ASR_EMOTION_TONE, UserToneTracker, turnTone, withTone, withUserTone } from './user-tone.js';

describe('SenseVoice emotion → caller tone', () => {
  it('maps every SenseVoice class; neutral and unknown are 平静', () => {
    expect(ASR_EMOTION_TONE).toEqual({
      happy: '喜',
      angry: '怒',
      sad: '哀',
      fearful: '惧',
      disgusted: '厌恶',
      surprised: '惊喜',
      neutral: '平静',
      unknown: '平静',
    });
  });

  it('a turn takes its last non-calm utterance', () => {
    expect(turnTone([])).toBe('平静');
    expect(turnTone(['neutral', 'unknown'])).toBe('平静');
    expect(turnTone(['angry', 'neutral'])).toBe('怒');
    expect(turnTone(['sad', 'angry', 'neutral'])).toBe('怒');
  });

  it('prefixes the text, except for 平静', () => {
    expect(withTone('我都说了三遍了', '怒')).toBe('[用户语气:怒] 我都说了三遍了');
    expect(withTone('你好', '平静')).toBe('你好');
  });
});

describe('withUserTone', () => {
  const ctx = () => {
    const c = new ChatContext();
    c.addMessage({ role: 'system', content: '你是小悠。' });
    c.addMessage({ role: 'user', content: '你好' });
    c.addMessage({ role: 'assistant', content: '你好呀。' });
    c.addMessage({ role: 'user', content: '我都说了三遍了' });
    return c;
  };
  const texts = (c: ChatContext) => c.items.map((i) => (i.type === 'message' ? i.textContent : i.type));

  it('prefixes only the last user message of a copy; the original stays raw', () => {
    const original = ctx();
    const sent = withUserTone(original, (t) => (t === '我都说了三遍了' ? '怒' : '喜'));
    expect(texts(sent)).toEqual(['你是小悠。', '你好', '你好呀。', '[用户语气:怒] 我都说了三遍了']);
    expect(texts(original)).toEqual(['你是小悠。', '你好', '你好呀。', '我都说了三遍了']);
    expect(sent.items.at(-1)?.id).toBe(original.items.at(-1)?.id);
  });

  it('returns the context itself for 平静 or when the last item is not a user message', () => {
    const calm = ctx();
    expect(withUserTone(calm, () => '平静')).toBe(calm);
    const afterReply = ctx();
    afterReply.addMessage({ role: 'assistant', content: '对不起。' });
    expect(withUserTone(afterReply, () => '怒')).toBe(afterReply);
  });
});

describe('UserToneTracker', () => {
  it('finds the tone of a message from the utterances it is made of', () => {
    const tones = new UserToneTracker();
    tones.utterance('你好', 'happy');
    tones.utterance('我都说了', 'angry');
    tones.utterance('三遍了', 'neutral');
    expect(tones.toneOf('我都说了 三遍了')).toBe('怒');
    // An earlier turn's utterance is not part of the message.
    tones.utterance('好吧', 'neutral');
    expect(tones.toneOf('好吧')).toBe('平静');
    expect(tones.toneOf('没识别过的话')).toBe('平静');
  });
});

/**
 * Listener feedback that is not a request to take the turn: interjections ("嗯", "啊", "哦") and
 * bare acknowledgements ("对", "是的", "好的"), alone or repeated, with any punctuation.
 */
const BACKCHANNEL = /^(?:[嗯恩啊阿哦噢喔呃额唔哼呀诶欸哎嘿哈]|对|是|好|行|的|没错)+$/u;
const PUNCTUATION_OR_SPACE = /[\p{P}\p{S}\s]/gu;

export function isBackchannel(text: string): boolean {
  const bare = text.replace(PUNCTUATION_OR_SPACE, '');
  return bare.length > 0 && bare.length <= 6 && BACKCHANNEL.test(bare);
}

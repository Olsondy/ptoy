import type { ChatContext } from '@livekit/agents';

/**
 * Endings that promise more: a trailing comma/colon, a connective ("然后", "但是", "因为"),
 * a clause opener ("我觉得", "如果…的话"), a filled pause ("那个", "呃") or a dangling function
 * word ("和", "把", "的时候"). SenseVoice transcribes each VAD segment on its own and often closes
 * it with "。", so the final full stop is ignored; "？" / "！" count as complete.
 */
const INCOMPLETE_ENDING = new RegExp(
  '(?:' +
  [
    '[，,、：:；;…—-]',
    '然后|然后呢|接着|就是|就是说|还有|而且|并且|但是|可是|不过|所以|因为|因此|如果|要是|假如|的话|比如|比如说|例如|包括|或者|还是',
    '我想|我觉得|我感觉|我认为|我是说|我要|我想问|想问一下|问一下|我跟你说|你知道|你说|其实|反正|首先|另外|总之',
    '那个|内个|这个|那么|呃|额|嗯那个|然后那个',
    '和|跟|与|把|被|给|从|向|对于|关于|为了|因为|的时候|之后|以后|之前|以前|一边|虽然|即使|只要|只有|除了',
  ].join('|') + ')$',
  'u',
);
const TRAILING_FULL_STOP = /[。.\s]+$/u;

/** True if the transcript so far looks like the speaker is mid-sentence. */
export function looksUnfinished(text: string): boolean {
  const t = text.trim().replace(TRAILING_FULL_STOP, '');
  if (!t) return false;
  return INCOMPLETE_ENDING.test(t);
}

/**
 * Text "turn detector" for `turnHandling.turnDetection` (the framework's `_TurnDetector` shape).
 *
 * The framework asks it once per VAD-ended segment (after the transcript arrived): a probability
 * below `unlikelyThreshold` makes it wait `endpointing.maxDelay` of silence instead of `minDelay`
 * before committing the turn; speech resuming in the meantime cancels the commit. So a sentence
 * that ends cleanly is answered after `minDelay`, one that stops on "然后" / "我觉得" / "，" waits
 * longer for the rest. No model, no I/O.
 */
export class TranscriptTurnDetector {
  readonly model = 'transcript-endings';
  readonly provider = 'ptoy';

  async unlikelyThreshold(): Promise<number> {
    return 0.5;
  }

  async supportsLanguage(): Promise<boolean> {
    return true;
  }

  async predictEndOfTurn(chatCtx: ChatContext): Promise<number> {
    const last = [...chatCtx.items].reverse().find((i) => i.type === 'message' && i.role === 'user');
    const text = last?.type === 'message' ? (last.textContent ?? '') : '';
    return looksUnfinished(text) ? 0 : 1;
  }
}

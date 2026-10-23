/** The slice of `voice.SpeechHandle` the guard needs. */
export interface Speech {
  readonly id: string;
  done(): boolean;
  interrupt(): unknown;
}

export interface FillerTurnGuardOptions {
  /** Caller speech this long while the reply is still queued drops the reply (= interruption `minDuration`). */
  readonly minSpeechMs: number;
  /** The filler's first audio played (agent state → speaking), `at` = event time. */
  readonly onFillerStart?: (at: number) => void;
  /** The queued reply was dropped because the caller talked over the filler. */
  readonly onReplyDropped?: (replyId: string) => void;
}

interface Turn {
  readonly filler: Speech;
  fillerStarted: boolean;
  reply?: Speech;
  replyStarted: boolean;
}

/**
 * Follows one filler + reply pair through the AgentSession events.
 *
 * The reply is queued behind the filler and only waits for the caller to be silent before it
 * plays. If the caller talks over the filler, the framework pauses/stops the filler, but the
 * queued reply would start in the first pause of the caller's speech and be cut a moment later
 * when their new turn is committed (an audible fragment of an answer to the old turn). So once
 * the caller has spoken for `minSpeechMs` before the reply started, the reply is interrupted:
 * what they say now gets its own filler and reply.
 *
 * Feed it every event in order; it never throws.
 */
export class FillerTurnGuard {
  readonly #opts: FillerTurnGuardOptions;
  /** Replies created since the last commit (preemptive generation may create several). */
  readonly #replies = new Map<string, Speech>();
  #turn: Turn | undefined;
  #userSpeaking: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: FillerTurnGuardOptions) {
    this.#opts = opts;
  }

  /** `speech_created` with source `generate_reply`. */
  replyCreated(reply: Speech): void {
    this.#replies.set(reply.id, reply);
  }

  /** A filler was queued for the user turn that is ending. */
  fillerQueued(filler: Speech): void {
    this.#turn = { filler, fillerStarted: false, replyStarted: false };
  }

  /** The user turn was committed (`eou_metrics`): `replyId` is the speech that answers it. */
  turnCommitted(replyId: string): void {
    const reply = this.#replies.get(replyId);
    this.#replies.clear();
    if (this.#turn && !this.#turn.reply && reply) this.#turn.reply = reply;
  }

  /** `agent_state_changed`. Returns true if this `speaking` is the filler starting. */
  agentState(state: string, at: number): boolean {
    const turn = this.#turn;
    if (state !== 'speaking' || !turn) return false;
    if (!turn.fillerStarted && !turn.filler.done()) {
      turn.fillerStarted = true;
      this.#opts.onFillerStart?.(at);
      return true;
    }
    if (turn.filler.done()) turn.replyStarted = true;
    return false;
  }

  /** `user_state_changed`. */
  userState(state: string): void {
    clearTimeout(this.#userSpeaking);
    this.#userSpeaking = undefined;
    if (state !== 'speaking') return;
    const turn = this.#turn;
    if (!turn || turn.replyStarted) return;
    this.#userSpeaking = setTimeout(() => {
      this.#userSpeaking = undefined;
      const reply = turn.reply;
      if (this.#turn !== turn || turn.replyStarted || !reply || reply.done()) return;
      reply.interrupt();
      this.#opts.onReplyDropped?.(reply.id);
    }, this.#opts.minSpeechMs);
  }

  close(): void {
    clearTimeout(this.#userSpeaking);
    this.#turn = undefined;
    this.#replies.clear();
  }
}

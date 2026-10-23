/** The slice of `voice.SpeechHandle` the guard needs. */
export interface Speech {
  readonly id: string;
  done(): boolean;
  interrupt(): unknown;
}

export interface FillerTurnGuardOptions {
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
 * plays. If the caller says something new before the reply started (over the filler, or in the
 * gap after it), that reply answers a turn the caller has moved on from: it would start in a
 * pause of their speech and be cut a moment later when their new turn is committed (an audible
 * fragment). So the first final transcript after the turn was committed drops the reply; what
 * they say now gets its own filler and reply. Noise and backchannels produce no transcript (the
 * STT drops them), so a cough over the filler only pauses it and the reply still plays.
 *
 * Feed it every event in order; it never throws.
 */
export class FillerTurnGuard {
  readonly #opts: FillerTurnGuardOptions;
  /** Replies created since the last commit (preemptive generation may create several). */
  readonly #replies = new Map<string, Speech>();
  #turn: Turn | undefined;

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

  /** A non-empty final user transcript (`user_input_transcribed`, `isFinal`). */
  userTranscript(): void {
    const turn = this.#turn;
    const reply = turn?.reply;
    if (!turn || turn.replyStarted || !reply || reply.done()) return;
    reply.interrupt();
    this.#opts.onReplyDropped?.(reply.id);
  }

  close(): void {
    this.#turn = undefined;
    this.#replies.clear();
  }
}

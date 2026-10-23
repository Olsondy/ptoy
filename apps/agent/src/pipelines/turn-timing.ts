import type { metrics } from '@livekit/agents';

/**
 * One line per turn (`turn timing` log). All durations in ms; `t*` fields are offsets from the
 * moment the user stopped speaking (VAD end of speech, before the silence wait).
 * Documented in docs/architecture/server.md §12.
 */
export interface TurnTiming {
  readonly speechId: string;
  /** User stopped speaking → turn committed (VAD silence + ASR + endpointing wait). */
  readonly eouDelayMs: number;
  /** User stopped speaking → final transcript available. */
  readonly transcriptionDelayMs: number;
  /** STT request round trip as seen by the agent (last utterance of the turn). */
  readonly asrMs?: number;
  /** ASR server-side inference time (`duration_ms`). */
  readonly asrInferenceMs?: number;
  readonly llmTtftMs?: number;
  readonly llmDurationMs?: number;
  readonly llmTokens?: number;
  /** First TTS segment: request → audio (includes waiting for the serialized backend). */
  readonly ttsFirstMs?: number;
  readonly ttsFirstChars?: number;
  readonly ttsFirstAudioMs?: number;
  /** Segments synthesized in this turn and their total audio length. */
  readonly ttsSegments: number;
  readonly ttsAudioMs: number;
  readonly tLlmFirstToken?: number;
  readonly tTtsFirstAudio?: number;
  readonly tPlayout?: number;
  /** = tPlayout: user stopped speaking → first agent audio played. */
  readonly totalMs?: number;
  readonly interrupted: boolean;
  readonly error?: string;
  readonly user?: string;
  readonly reply?: string;
}

interface OpenTurn {
  speechId: string;
  stoppedAt: number;
  eou: metrics.EOUMetrics;
  asr?: { durationMs: number; inferenceMs?: number };
  llm?: metrics.LLMMetrics;
  ttsFirst?: metrics.TTSMetrics;
  ttsSegments: number;
  ttsAudioMs: number;
  playoutAt?: number;
  interrupted: boolean;
  error?: string;
  user?: string;
  reply?: string;
}

const round = (v: number | undefined) => (v === undefined ? undefined : Math.round(v));

/**
 * Assembles per-turn stage timings from AgentSession events. Feed it events in order; it calls
 * `emit` once per turn: when the agent's reply is committed to the history, or when the next
 * turn starts / the session closes before that (no reply: LLM failed, or interrupted early).
 */
export class TurnTimingTracker {
  readonly #emit: (timing: TurnTiming) => void;
  #pendingAsr: { durationMs: number; inferenceMs?: number } | undefined;
  #pendingUser: string | undefined;
  readonly #turns = new Map<string, OpenTurn>();
  #current: OpenTurn | undefined;

  constructor(emit: (timing: TurnTiming) => void) {
    this.#emit = emit;
  }

  onMetrics(m: metrics.AgentMetrics): void {
    switch (m.type) {
      case 'stt_metrics':
        this.#pendingAsr = { ...this.#pendingAsr, durationMs: m.durationMs };
        break;
      case 'eou_metrics': {
        if (!m.speechId) return;
        if (this.#current) this.#finish(this.#current);
        const turn: OpenTurn = {
          speechId: m.speechId,
          stoppedAt: m.lastSpeakingTimeMs,
          eou: m,
          asr: this.#pendingAsr,
          user: this.#pendingUser,
          ttsSegments: 0,
          ttsAudioMs: 0,
          interrupted: false,
        };
        this.#pendingAsr = undefined;
        this.#pendingUser = undefined;
        this.#turns.set(m.speechId, turn);
        this.#current = turn;
        break;
      }
      case 'llm_metrics': {
        const turn = m.speechId ? this.#turns.get(m.speechId) : undefined;
        if (turn && !turn.llm) turn.llm = m;
        break;
      }
      case 'tts_metrics': {
        const turn = m.speechId ? this.#turns.get(m.speechId) : undefined;
        if (!turn) return;
        turn.ttsFirst ??= m;
        turn.ttsSegments += 1;
        turn.ttsAudioMs += m.audioDurationMs;
        break;
      }
      default:
        break;
    }
  }

  /** ASR server-side time for the latest utterance (from the STT plugin's `onTranscript`). */
  onAsrResult(inferenceMs: number): void {
    this.#pendingAsr = { durationMs: this.#pendingAsr?.durationMs ?? 0, ...this.#pendingAsr, inferenceMs };
  }

  onUserTranscript(text: string): void {
    this.#pendingUser = this.#pendingUser ? `${this.#pendingUser} ${text}` : text;
  }

  /** The agent's message was committed to the chat history (after playout or interruption): the turn is done. */
  onAgentReply(text: string, interrupted: boolean): void {
    const turn = this.#current;
    if (!turn) return;
    turn.reply = text;
    turn.interrupted ||= interrupted;
    this.#finish(turn);
  }

  onError(message: string): void {
    if (this.#current) this.#current.error ??= message;
  }

  onAgentState(newState: string, at: number): void {
    const turn = this.#current;
    if (!turn) return;
    if (newState === 'speaking') turn.playoutAt ??= at;
    // A failed turn that never played anything: nothing more will come.
    else if (newState === 'listening' && turn.error && turn.playoutAt === undefined) this.#finish(turn);
  }

  /** Flushes the open turn (session closing). */
  close(): void {
    if (this.#current) this.#finish(this.#current);
  }

  #finish(turn: OpenTurn): void {
    this.#turns.delete(turn.speechId);
    if (this.#current === turn) this.#current = undefined;
    const at = (absolute: number | undefined) =>
      absolute === undefined || !turn.stoppedAt ? undefined : Math.round(absolute - turn.stoppedAt);
    const llm = turn.llm && turn.llm.ttftMs >= 0 ? turn.llm : undefined;
    const tts = turn.ttsFirst;
    const llmStart = llm ? llm.timestamp - llm.durationMs : undefined;
    const ttsStart = tts ? tts.timestamp - tts.durationMs : undefined;
    this.#emit({
      speechId: turn.speechId,
      eouDelayMs: Math.round(turn.eou.endOfUtteranceDelayMs),
      transcriptionDelayMs: Math.round(turn.eou.transcriptionDelayMs),
      asrMs: round(turn.asr?.durationMs || undefined),
      asrInferenceMs: round(turn.asr?.inferenceMs),
      llmTtftMs: round(llm?.ttftMs),
      llmDurationMs: round(llm?.durationMs),
      llmTokens: llm?.completionTokens,
      ttsFirstMs: tts && tts.ttfbMs >= 0 ? Math.round(tts.ttfbMs) : undefined,
      ttsFirstChars: tts?.charactersCount,
      ttsFirstAudioMs: tts?.audioDurationMs,
      ttsSegments: turn.ttsSegments,
      ttsAudioMs: Math.round(turn.ttsAudioMs),
      tLlmFirstToken: llm && llmStart !== undefined ? at(llmStart + llm.ttftMs) : undefined,
      tTtsFirstAudio: tts && ttsStart !== undefined && tts.ttfbMs >= 0 ? at(ttsStart + tts.ttfbMs) : undefined,
      tPlayout: at(turn.playoutAt),
      totalMs: at(turn.playoutAt),
      interrupted: turn.interrupted,
      error: turn.error,
      user: turn.user,
      reply: turn.reply,
    });
  }
}

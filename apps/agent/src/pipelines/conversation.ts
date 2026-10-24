import {
  APITimeoutError,
  type ChatContext,
  type ChatMessage,
  type ModelSettings,
  type TimedString,
  type llm,
  createTimedString,
  isTimedString,
  log,
  voice,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Emotion, SegmenterOptions } from '@ptoy/segmenter';
import { existsSync } from 'node:fs';
import { ATTRIBUTE_CHARACTER, loadCharacters } from '../characters.js';
import { loadConversationConfig } from '../config.js';
import { UserToneTracker, withUserTone } from '../emotion/user-tone.js';
import { createLlm, withReasoningEffort } from '../llm/index.js';
import {
  type Filler,
  type FillerBank,
  fillerAudio,
  fillerGate,
  fillerManifestPath,
  loadFillerBank,
} from '../fillers/bank.js';
import { FillerTurnGuard } from '../fillers/turn.js';
import { IndexTTS, TtsError, createTtsBackend } from '../tts/index.js';
import { isBackchannel } from './backchannel.js';
import { attributePublisher, createStt, createTurnTaking, publishSttErrors } from './listening.js';
import { TurnTimingTracker } from './turn-timing.js';
import type { CallPipeline } from './types.js';

/**
 * Agent participant attribute carrying a user-facing LLM/TTS failure message ('' = no error).
 * The web shows it in place of the agent subtitle; cleared when the agent speaks again.
 */
export const ATTRIBUTE_AGENT_ERROR = 'ptoy.agent_error';

/**
 * How a reply is cut for TTS (also used by `scripts/chat.ts`).
 * One emotion per reply (its first tag): per-sentence tags switched between the plain reference
 * voice (平静) and emotion-vector synthesis mid-reply, which sounded like the voice changing.
 * Sentences under 10 characters ride with the next one: a short segment takes longer to synthesize
 * than to play (~1.3 s fixed cost each), so the next one was not ready and the reply paused.
 * The first segment needs 4 characters: IndexTTS2 drags out an opener synthesized on its own
 * ("哈哈，" alone took 1.2 s, half that inside "哈哈，真的假的？").
 */
export const REPLY_SEGMENTER: SegmenterOptions = {
  emotionScope: 'reply',
  dropLeadingInterjection: true,
  firstSegmentMinChars: 4,
  minSegmentChars: 10,
};

function llmErrorMessage(error: unknown): string {
  if (error instanceof APITimeoutError) return 'AI 想得太久没有回应，请再说一次。';
  return 'AI 暂时连不上语言模型，这句话没有回答。';
}

function ttsErrorMessage(error: unknown): string {
  if (error instanceof TtsError && error.kind === 'timeout') return 'AI 的语音合成超时，这句话没能说出来。';
  return 'AI 的语音合成服务不可用，这句话没能说出来。';
}

/**
 * Invisible word break inserted after every CJK character of the agent transcript.
 *
 * LiveKit's transcription sync paces text word by word, splitting words on whitespace
 * (`basic.splitWords`, not configurable through RoomIO). Chinese has no spaces, so a whole reply
 * would be released as one "word" the moment playback starts. U+FEFF counts as whitespace for that
 * split but renders as nothing, so the subtitle advances character by character with the audio.
 * It never reaches the LLM: {@link stripWordBreaks} cleans the committed history message.
 */
const WORD_BREAK = '\uFEFF';
const CJK_CHAR = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef])/gu;

function addWordBreaks(): TransformStream<string | TimedString, string | TimedString> {
  const breakText = (text: string) => text.replace(CJK_CHAR, `$1${WORD_BREAK}`);
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(
        isTimedString(chunk) ? createTimedString({ ...chunk, text: breakText(chunk.text) }) : breakText(chunk),
      );
    },
  });
}

/** Removes the transcript word breaks from a committed message (mutates: it is the history entry). */
function stripWordBreaks(message: ChatMessage): void {
  message.content = message.content.map((c) => (typeof c === 'string' ? c.replaceAll(WORD_BREAK, '') : c));
}

/** One LLM call as the `llm reply` log line shows it (the per-turn emotion diagnostic). */
export interface LlmReplyLog {
  /** The user message as the LLM saw it, `[用户语气:X]` prefix included. */
  readonly input: string;
  /** The raw reply with its emotion tags, before the segmenter. */
  readonly reply: string;
  /** The reply's first tag: the emotion the whole reply is voiced with (`emotionScope: 'reply'`). */
  readonly voicedEmotion: string;
  /** The stream was cancelled (barge-in, or a discarded preemptive generation). */
  readonly cancelled: boolean;
}

const FIRST_TAG = /^\s*[[【]([^\]】]{1,10})[\]】]/;

/** Passes LLM chunks through and reports the full raw text once the stream ends or is cancelled. */
function captureReply(onDone: (reply: string, cancelled: boolean) => void): TransformStream<llm.ChatChunk | string, llm.ChatChunk | string> {
  let reply = '';
  return new TransformStream({
    transform(chunk, controller) {
      reply += typeof chunk === 'string' ? chunk : (chunk.delta?.content ?? '');
      controller.enqueue(chunk);
    },
    flush: () => onDone(reply, false),
    cancel: () => onDone(reply, true),
  });
}

interface FillerHooks {
  readonly bank: FillerBank;
  /** SenseVoice emotion of the turn's last utterance. */
  readonly asrEmotion: () => string | undefined;
  /** Hold the filler this long after the turn ends; skip it if the reply's audio is ready by then. */
  readonly delayMs: number;
  readonly onPlay: (filler: Filler, handle: voice.SpeechHandle) => void;
  /** The filler was skipped: the reply's first audio was ready within `delayMs`. */
  readonly onSkip: (filler: Filler) => void;
}

/**
 * The character: its system prompt (picked per call), CJK-paced transcript, and a filler at the end of each user turn.
 *
 * The reply text itself is cut and cleaned (tags removed) by `@ptoy/segmenter` inside the TTS
 * plugin's `stream()`; subtitles and the committed history come from its per-segment transcripts.
 */
class CharacterAgent extends voice.Agent {
  readonly #fillers: FillerHooks | undefined;
  readonly #toneOf: (userText: string) => Emotion;
  readonly #onReply: (entry: LlmReplyLog) => void;
  /** Signals the current turn's reply audio is ready (first TTS frame); set per filler turn. */
  #replyAudioReady: (() => void) | undefined;

  constructor(
    options: voice.AgentOptions<unknown>,
    toneOf: (userText: string) => Emotion,
    onReply: (entry: LlmReplyLog) => void,
    fillers?: FillerHooks,
  ) {
    super(options);
    this.#toneOf = toneOf;
    this.#onReply = onReply;
    this.#fillers = fillers;
  }

  /**
   * The LLM sees the user message being answered with the caller's tone, e.g. `[用户语气:怒] …`
   * (#13). Only this request's copy is changed: history and subtitles keep the raw transcript.
   * The raw tagged reply is reported to `onReply` for the `llm reply` log line.
   */
  override async llmNode(chatCtx: ChatContext, toolCtx: llm.ToolContext, modelSettings: ModelSettings) {
    const ctx = withUserTone(chatCtx, this.#toneOf);
    const stream = await voice.Agent.default.llmNode(this, ctx, toolCtx, modelSettings);
    if (!stream) return stream;
    const last = ctx.items.at(-1);
    const input = last?.type === 'message' ? (last.textContent ?? '') : '';
    return stream.pipeThrough(
      captureReply((reply, cancelled) =>
        this.#onReply({ input, reply, voicedEmotion: FIRST_TAG.exec(reply)?.[1] ?? '平静', cancelled }),
      ),
    );
  }

  /**
   * Runs right before the reply is generated: queue a filler ahead of it. The reply's LLM and TTS
   * start immediately anyway; its playout waits in the speech queue until the filler is done
   * (no overlap). The filler's audio holds for `delayMs` first: if the reply's first audio is
   * ready by then the filler ends without a sound (only a slow reply gets one); a filler right at
   * the end of every turn sounded like the agent jumping in.
   * The filler is a normal interruptible speech: user speech pauses/stops it like any reply.
   * It is not added to the chat history (`addToChatCtx: false`) and has no subtitle (empty text).
   */
  override async onUserTurnCompleted(_chatCtx: ChatContext, newMessage: ChatMessage): Promise<void> {
    this.#replyAudioReady = undefined;
    const hooks = this.#fillers;
    if (!hooks) return;
    const filler = hooks.bank.next(newMessage.textContent ?? '', hooks.asrEmotion());
    if (!filler) return;
    const replyAudio = new Promise<void>((resolve) => (this.#replyAudioReady = resolve));
    const play = fillerGate(hooks.delayMs, replyAudio);
    const handle = this.session.say('', {
      audio: fillerAudio(filler, play),
      addToChatCtx: false,
      allowInterruptions: true,
    });
    hooks.onPlay(filler, handle);
    void play.then((played) => {
      if (!played && !handle.interrupted) hooks.onSkip(filler);
    });
  }

  /** Reply audio passes through unchanged; its first frame tells a held filler to stand down. */
  override async ttsNode(text: ReadableStream<string> | AsyncIterable<string>, modelSettings: ModelSettings) {
    const ready = this.#replyAudioReady;
    const audio = await voice.Agent.default.ttsNode(this, text, modelSettings);
    if (!audio || !ready) return audio;
    return audio.pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        transform(frame, controller) {
          ready();
          controller.enqueue(frame);
        },
      }),
    );
  }

  override async transcriptionNode(
    text: ReadableStream<string | TimedString> | AsyncIterable<string | TimedString>,
    modelSettings: ModelSettings,
  ) {
    const stream = await voice.Agent.default.transcriptionNode(this, text, modelSettings);
    return stream ? stream.pipeThrough(addWordBreaks()) : null;
  }
}

/**
 * Full conversation: VAD + SenseVoice STT → llama-server LLM → segmenter + IndexTTS → agent audio
 * track, with a pre-recorded filler played as soon as each user turn ends (M2 #11).
 * User transcripts and agent replies go out on `lk.transcription`; LiveKit's transcription sync
 * paces the agent text with playback (sentence timestamps from the TTS, per-character advance via
 * {@link addWordBreaks}). One `turn timing` log line per turn (docs/architecture/server.md §12).
 */
export const conversationPipeline: CallPipeline = async (ctx, caller) => {
  const loaded = loadConversationConfig();
  const config = { ...loaded, llm: await withReasoningEffort(loaded.llm) };
  const logger = log().child({ pipeline: 'conversation', caller: caller.identity });
  const { vad, turnHandling } = createTurnTaking(config);

  // The page's pick arrives as a caller attribute (ADR 0007); a stale or missing id gets the default.
  const requested = caller.attributes[ATTRIBUTE_CHARACTER] || undefined;
  const character = loadCharacters(config.characters.dir, config.characters.defaultId).resolve(requested);
  if (requested !== undefined && requested !== character.id) {
    logger.warn({ requested, character: character.id }, 'unknown character, using the default');
  }

  const timing = new TurnTimingTracker((turn) => logger.info({ turn }, 'turn timing'));
  let asrEmotion: string | undefined;
  const tones = new UserToneTracker();
  // Agent speech queued, playing or paused: while it holds the floor a bare "嗯" / "对" is
  // listener feedback, not a turn (dropped by the STT, so a paused reply resumes).
  const agentSpeeches = new Set<voice.SpeechHandle>();
  const backchannelWhileAgentTalks = (text: string) => {
    if (agentSpeeches.size === 0 || !isBackchannel(text)) return false;
    logger.debug({ text }, 'backchannel while the agent holds the floor, ignored');
    return true;
  };
  const stt = createStt(
    config,
    (t) => {
      asrEmotion = t.emotion;
      tones.utterance(t.text, t.emotion);
      timing.onAsrResult(t.inferenceMs);
      logger.info({ text: t.text, emotion: t.emotion, asrMs: t.inferenceMs, audioMs: t.audioMs }, 'user utterance');
    },
    backchannelWhileAgentTalks,
  );
  const toneOf = (userText: string) => {
    const tone = tones.toneOf(userText);
    logger.debug({ tone }, 'user tone for the llm');
    return tone;
  };
  const tts = new IndexTTS({
    backend: createTtsBackend(config.tts, character.voice, character.tts),
    sampleRate: config.audioSampleRate,
    segmenter: REPLY_SEGMENTER,
  });
  // Loads the character's voice on the TTS service while the caller is still settling in (ADR 0008).
  tts.prewarm();
  if (config.tts.backend === 'gradio') {
    logger.warn(
      { voice: character.voice, tuning: character.tts },
      'gradio tts speaks every character with TTS_REF_AUDIO and ignores the per-character speed and pauses',
    );
  }
  // Fillers in another voice would sound like a second person answering: no set, no fillers.
  let fillerBank: FillerBank | undefined;
  if (config.fillers) {
    const manifest = fillerManifestPath(config.fillers.dir, character.voice);
    if (existsSync(manifest)) fillerBank = await loadFillerBank(manifest, config.audioSampleRate, config.fillers.always);
    else logger.warn({ voice: character.voice, manifest }, 'no fillers recorded for this voice');
  }
  const fillerGuard = new FillerTurnGuard({
    onFillerStart: (at) => timing.onFillerStart(at),
    onReplyDropped: (id) => logger.info({ speechId: id }, 'caller spoke over the filler, queued reply dropped'),
  });
  const fillerHooks: FillerHooks | undefined = fillerBank && {
    bank: fillerBank,
    asrEmotion: () => asrEmotion,
    delayMs: config.fillers?.delayMs ?? 0,
    onPlay: (f, handle) => {
      fillerGuard.fillerQueued(handle);
      timing.onFiller(f.id, f.durationMs);
      logger.debug({ filler: f.id, group: f.group, text: f.text, durationMs: f.durationMs }, 'filler queued');
    },
    onSkip: (f) => {
      timing.onFillerSkipped();
      logger.debug({ filler: f.id }, 'reply audio ready first, filler skipped');
    },
  };

  const session = new voice.AgentSession({
    vad,
    stt,
    llm: createLlm(config.llm),
    tts,
    turnHandling,
    connOptions: {
      llmConnOptions: { timeoutMs: config.llm.timeoutMs, maxRetry: config.llm.maxRetry, retryIntervalMs: 500 },
      ttsConnOptions: { timeoutMs: config.tts.timeoutMs, maxRetry: 0 },
      // A dead LLM/TTS must not end the call: keep the session up and report every failure.
      maxUnrecoverableErrors: Number.MAX_SAFE_INTEGER,
    },
  });

  const onAttributeFail = (error: unknown) => logger.warn({ error }, 'failed to publish error attribute');
  publishSttErrors(ctx, session, onAttributeFail);
  const setAgentError = attributePublisher(ctx, ATTRIBUTE_AGENT_ERROR, onAttributeFail);

  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    if (ev.error.type !== 'llm_error' && ev.error.type !== 'tts_error') return;
    const { type, error, recoverable } = ev.error;
    const fields = { type, recoverable, err: error.message };
    if (recoverable) {
      logger.warn(fields, `${type === 'llm_error' ? 'llm' : 'tts'} failed, retrying`);
      return;
    }
    logger.error(fields, `${type === 'llm_error' ? 'llm' : 'tts'} failed`);
    const message = type === 'llm_error' ? llmErrorMessage(error) : ttsErrorMessage(error);
    timing.onError(type);
    setAgentError(message);
  });
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
    if (ev.metrics.type === 'eou_metrics' && ev.metrics.speechId) fillerGuard.turnCommitted(ev.metrics.speechId);
    timing.onMetrics(ev.metrics);
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (!ev.isFinal || !ev.transcript) return;
    timing.onUserTranscript(ev.transcript);
    fillerGuard.userTranscript();
  });
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
    const handle = ev.speechHandle;
    agentSpeeches.add(handle);
    handle.addDoneCallback(() => agentSpeeches.delete(handle));
    if (ev.source === 'generate_reply') fillerGuard.replyCreated(handle);
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (!fillerGuard.agentState(ev.newState, ev.createdAt)) timing.onAgentState(ev.newState, ev.createdAt);
    if (ev.newState === 'speaking') setAgentError('');
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type !== 'message' || item.role !== 'assistant') return;
    stripWordBreaks(item);
    const startedAt = item.metrics?.startedSpeakingAt;
    timing.onAgentReply(item.textContent ?? '', item.interrupted, startedAt === undefined ? undefined : startedAt * 1000);
  });
  session.on(voice.AgentSessionEventTypes.Close, (ev) => {
    timing.close();
    fillerGuard.close();
    logger.info({ reason: ev.reason }, 'agent session closed');
  });

  await session.start({
    agent: new CharacterAgent(
      { instructions: character.instructions },
      toneOf,
      (entry) => logger.info(entry, 'llm reply'),
      fillerHooks,
    ),
    room: ctx.room,
    inputOptions: { participantIdentity: caller.identity },
    outputOptions: { audioSampleRate: config.audioSampleRate },
  });
  logger.info(
    {
      character: character.id,
      voice: character.voice,
      ttsTuning: character.tts,
      asr: config.asrUrl,
      llm: config.llm.baseUrl,
      model: config.llm.model,
      reasoningEffort: config.llm.reasoningEffort ?? 'not sent',
      tts: tts.provider,
      ttsUrl: config.tts.url,
      fillers: fillerBank?.fillers.length ?? 0,
    },
    'conversation ready',
  );

  ctx.addShutdownCallback(async () => {
    await session.close();
  });
};

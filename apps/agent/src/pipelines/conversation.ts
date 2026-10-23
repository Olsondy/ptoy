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
import type { Emotion } from '@ptoy/segmenter';
import { readFileSync } from 'node:fs';
import { type ConversationConfig, loadConversationConfig } from '../config.js';
import { UserToneTracker, withUserTone } from '../emotion/user-tone.js';
import { createLlm } from '../llm/index.js';
import { type Filler, type FillerBank, fillerAudio, loadFillerBank } from '../fillers/bank.js';
import { FillerTurnGuard } from '../fillers/turn.js';
import { IndexTTS, TtsError, createTtsBackend } from '../tts/index.js';
import {
  INTERRUPTION_MIN_SPEECH_MS,
  attributePublisher,
  createStt,
  createTurnTaking,
  publishSttErrors,
} from './listening.js';
import { TurnTimingTracker } from './turn-timing.js';
import type { CallPipeline } from './types.js';

/**
 * Agent participant attribute carrying a user-facing LLM/TTS failure message ('' = no error).
 * The web shows it in place of the agent subtitle; cleared when the agent speaks again.
 */
export const ATTRIBUTE_AGENT_ERROR = 'ptoy.agent_error';

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

interface FillerHooks {
  readonly bank: FillerBank;
  /** SenseVoice emotion of the turn's last utterance. */
  readonly asrEmotion: () => string | undefined;
  readonly onPlay: (filler: Filler, handle: voice.SpeechHandle) => void;
}

/**
 * The character: fixed system prompt, CJK-paced transcript, and a filler at the end of each user turn.
 *
 * The reply text itself is cut and cleaned (tags removed) by `@ptoy/segmenter` inside the TTS
 * plugin's `stream()`; subtitles and the committed history come from its per-segment transcripts.
 */
class CharacterAgent extends voice.Agent {
  readonly #fillers: FillerHooks | undefined;
  readonly #toneOf: (userText: string) => Emotion;

  constructor(options: voice.AgentOptions<unknown>, toneOf: (userText: string) => Emotion, fillers?: FillerHooks) {
    super(options);
    this.#toneOf = toneOf;
    this.#fillers = fillers;
  }

  /**
   * The LLM sees the user message being answered with the caller's tone, e.g. `[用户语气:怒] …`
   * (#13). Only this request's copy is changed: history and subtitles keep the raw transcript.
   */
  override async llmNode(chatCtx: ChatContext, toolCtx: llm.ToolContext, modelSettings: ModelSettings) {
    const ctx = withUserTone(chatCtx, this.#toneOf);
    return voice.Agent.default.llmNode(this, ctx, toolCtx, modelSettings);
  }

  /**
   * Runs right before the reply is generated: queue a filler ahead of it. The reply's LLM and TTS
   * start immediately anyway; its playout waits in the speech queue until the filler has played
   * (no overlap), and if the filler is shorter the caller just hears silence until the reply.
   * The filler is a normal interruptible speech: user speech pauses/stops it like any reply.
   * It is not added to the chat history (`addToChatCtx: false`) and has no subtitle (empty text).
   */
  override async onUserTurnCompleted(_chatCtx: ChatContext, newMessage: ChatMessage): Promise<void> {
    const hooks = this.#fillers;
    if (!hooks) return;
    const filler = hooks.bank.next(newMessage.textContent ?? '', hooks.asrEmotion());
    if (!filler) return;
    const handle = this.session.say('', { audio: fillerAudio(filler), addToChatCtx: false, allowInterruptions: true });
    hooks.onPlay(filler, handle);
  }

  override async transcriptionNode(
    text: ReadableStream<string | TimedString> | AsyncIterable<string | TimedString>,
    modelSettings: ModelSettings,
  ) {
    const stream = await voice.Agent.default.transcriptionNode(this, text, modelSettings);
    return stream ? stream.pipeThrough(addWordBreaks()) : null;
  }
}

function loadCharacterPrompt(config: ConversationConfig): string {
  const prompt = readFileSync(config.characterPromptFile, 'utf8').trim();
  if (!prompt) throw new Error(`Character prompt file is empty: ${config.characterPromptFile}`);
  return prompt;
}

/**
 * Full conversation: VAD + SenseVoice STT → llama-server LLM → segmenter + IndexTTS → agent audio
 * track, with a pre-recorded filler played as soon as each user turn ends (M2 #11).
 * User transcripts and agent replies go out on `lk.transcription`; LiveKit's transcription sync
 * paces the agent text with playback (sentence timestamps from the TTS, per-character advance via
 * {@link addWordBreaks}). One `turn timing` log line per turn (docs/architecture/server.md §12).
 */
export const conversationPipeline: CallPipeline = async (ctx, caller) => {
  const config = loadConversationConfig();
  const logger = log().child({ pipeline: 'conversation', caller: caller.identity });
  const { vad, turnHandling } = createTurnTaking(config);

  const timing = new TurnTimingTracker((turn) => logger.info({ turn }, 'turn timing'));
  let asrEmotion: string | undefined;
  const tones = new UserToneTracker();
  const stt = createStt(config, (t) => {
    asrEmotion = t.emotion;
    tones.utterance(t.text, t.emotion);
    timing.onAsrResult(t.inferenceMs);
    logger.debug({ text: t.text, emotion: t.emotion, asrMs: t.inferenceMs, audioMs: t.audioMs }, 'user utterance');
  });
  const toneOf = (userText: string) => {
    const tone = tones.toneOf(userText);
    logger.debug({ tone }, 'user tone for the llm');
    return tone;
  };
  const tts = new IndexTTS({ backend: createTtsBackend(config.tts), sampleRate: config.audioSampleRate });
  const fillerBank = config.fillers ? await loadFillerBank(config.fillers.manifestPath, config.audioSampleRate) : undefined;
  const fillerGuard = new FillerTurnGuard({
    minSpeechMs: INTERRUPTION_MIN_SPEECH_MS,
    onFillerStart: (at) => timing.onFillerStart(at),
    onReplyDropped: (id) => logger.info({ speechId: id }, 'caller spoke over the filler, queued reply dropped'),
  });
  const fillerHooks: FillerHooks | undefined = fillerBank && {
    bank: fillerBank,
    asrEmotion: () => asrEmotion,
    onPlay: (f, handle) => {
      fillerGuard.fillerQueued(handle);
      timing.onFiller(f.id, f.durationMs);
      logger.debug({ filler: f.id, group: f.group, text: f.text, durationMs: f.durationMs }, 'filler queued');
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
    if (ev.isFinal && ev.transcript) timing.onUserTranscript(ev.transcript);
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => fillerGuard.userState(ev.newState));
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
    if (ev.source === 'generate_reply') fillerGuard.replyCreated(ev.speechHandle);
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
    agent: new CharacterAgent({ instructions: loadCharacterPrompt(config) }, toneOf, fillerHooks),
    room: ctx.room,
    inputOptions: { participantIdentity: caller.identity },
    outputOptions: { audioSampleRate: config.audioSampleRate },
  });
  logger.info(
    {
      asr: config.asrUrl,
      llm: config.llm.baseUrl,
      model: config.llm.model,
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

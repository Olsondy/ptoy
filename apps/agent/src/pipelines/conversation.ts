import {
  APITimeoutError,
  type ChatChunk,
  type ChatContext,
  type ChatMessage,
  type ModelSettings,
  type TimedString,
  type ToolContext,
  createTimedString,
  isTimedString,
  log,
  voice,
} from '@livekit/agents';
import { readFileSync } from 'node:fs';
import { type ConversationConfig, loadConversationConfig } from '../config.js';
import { createLlm } from '../llm/index.js';
import { IndexTTS, TtsError, createTtsBackend } from '../tts/index.js';
import { attributePublisher, createStt, createTurnTaking, publishSttErrors } from './listening.js';
import { TagStripper } from './tag-guard.js';
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

/** Strips stray `[...]` tags from the LLM stream so they are neither spoken nor shown. */
function stripTags(): TransformStream<ChatChunk | string, ChatChunk | string> {
  const stripper = new TagStripper();
  return new TransformStream({
    transform(chunk, controller) {
      if (typeof chunk === 'string') {
        const text = stripper.push(chunk);
        if (text) controller.enqueue(text);
        return;
      }
      const content = chunk.delta?.content;
      if (!content || !chunk.delta) {
        controller.enqueue(chunk);
        return;
      }
      controller.enqueue({ ...chunk, delta: { ...chunk.delta, content: stripper.push(content) } });
    },
    flush() {
      stripper.end();
    },
  });
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

/** The character: fixed system prompt, tag guard on the LLM output, CJK-paced transcript. */
class CharacterAgent extends voice.Agent {
  override async llmNode(chatCtx: ChatContext, toolCtx: ToolContext, modelSettings: ModelSettings) {
    const stream = await voice.Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
    return stream ? stream.pipeThrough(stripTags()) : null;
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
 * M1 full conversation: VAD + SenseVoice STT → llama-server LLM → IndexTTS → agent audio track.
 * User transcripts and agent replies go out on `lk.transcription`; LiveKit's transcription sync
 * paces the agent text with playback (sentence timestamps from the TTS, per-character advance via
 * {@link addWordBreaks}). One `turn timing` log line per turn (docs/architecture/server.md §12).
 */
export const conversationPipeline: CallPipeline = async (ctx, caller) => {
  const config = loadConversationConfig();
  const logger = log().child({ pipeline: 'conversation', caller: caller.identity });
  const { vad, turnHandling } = createTurnTaking(config);

  const timing = new TurnTimingTracker((turn) => logger.info({ turn }, 'turn timing'));
  const stt = createStt(config, (t) => {
    timing.onAsrResult(t.inferenceMs);
    logger.debug({ text: t.text, emotion: t.emotion, asrMs: t.inferenceMs, audioMs: t.audioMs }, 'user utterance');
  });
  const tts = new IndexTTS({ backend: createTtsBackend(config.tts), sampleRate: config.audioSampleRate });

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
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => timing.onMetrics(ev.metrics));
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal && ev.transcript) timing.onUserTranscript(ev.transcript);
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    timing.onAgentState(ev.newState, ev.createdAt);
    if (ev.newState === 'speaking') setAgentError('');
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type !== 'message' || item.role !== 'assistant') return;
    stripWordBreaks(item);
    timing.onAgentReply(item.textContent ?? '', item.interrupted);
  });
  session.on(voice.AgentSessionEventTypes.Close, (ev) => {
    timing.close();
    logger.info({ reason: ev.reason }, 'agent session closed');
  });

  await session.start({
    agent: new CharacterAgent({ instructions: loadCharacterPrompt(config) }),
    room: ctx.room,
    inputOptions: { participantIdentity: caller.identity },
    outputOptions: { audioSampleRate: config.audioSampleRate },
  });
  logger.info(
    { asr: config.asrUrl, llm: config.llm.baseUrl, model: config.llm.model, tts: tts.provider, ttsUrl: config.tts.url },
    'conversation ready',
  );

  ctx.addShutdownCallback(async () => {
    await session.close();
  });
};

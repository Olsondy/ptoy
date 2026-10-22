import { inference, log, voice } from '@livekit/agents';
import { type CallConfig, loadCallConfig } from '../config.js';
import { AsrError, SenseVoiceSTT } from '../stt/sensevoice.js';
import type { CallPipeline } from './types.js';

/**
 * Agent participant attribute carrying a user-facing STT failure message ('' = no error).
 * The web subtitle shows it in place of the user's transcript.
 */
export const ATTRIBUTE_STT_ERROR = 'ptoy.stt_error';

/**
 * Silero VAD and the `v1-mini` end-of-turn model both run in-process via `@livekit/local-inference`
 * (prebuilt for darwin-x64/arm64 and win32-x64; the worker preloads the weights). Nothing here
 * calls LiveKit Cloud.
 */
function createTurnTaking(config: CallConfig) {
  const vad = new inference.VAD({ minSilenceDuration: config.vadMinSilenceMs });
  const turnDetection = config.turnDetector === 'eot' ? new inference.TurnDetector({ version: 'v1-mini' }) : 'vad';
  return { vad, turnDetection } as const;
}

function sttErrorMessage(error: unknown): string {
  if (error instanceof AsrError && error.kind === 'timeout') return '语音识别超时，这句话没有识别出来。';
  if (error instanceof AsrError && error.kind === 'service') return '语音识别出错，这句话没有识别出来。';
  return '语音识别服务不可用，这句话没有识别出来。';
}

/**
 * M1 listening half: Silero VAD cuts utterances → SenseVoice STT → user transcripts.
 * No LLM/TTS yet; the framework's room IO publishes every final transcript on
 * `lk.transcription` (sender = caller), which the web renders as the user subtitle.
 */
export const transcribePipeline: CallPipeline = async (ctx, caller) => {
  const config = loadCallConfig();
  const logger = log().child({ pipeline: 'transcribe', caller: caller.identity });
  const { vad, turnDetection } = createTurnTaking(config);

  const stt = new SenseVoiceSTT({
    baseUrl: config.asrUrl,
    timeoutMs: config.asrTimeoutMs,
    language: config.asrLanguage,
    onTranscript: (t) =>
      logger.info(
        { text: t.text, emotion: t.emotion, events: t.events, asrMs: t.inferenceMs, audioMs: t.audioMs },
        'user utterance recognized',
      ),
  });

  const session = new voice.AgentSession({
    vad,
    stt,
    turnHandling: {
      turnDetection,
      endpointing: { minDelay: config.endpointingMinDelayMs, maxDelay: config.endpointingMaxDelayMs },
      // Plain VAD interruption: 'adaptive' would call LiveKit Cloud.
      interruption: { mode: 'vad' },
    },
  });

  const setSttError = (message: string) =>
    ctx.room.localParticipant?.setAttributes({ [ATTRIBUTE_STT_ERROR]: message }).catch((error: unknown) => {
      logger.warn({ error }, 'failed to publish stt error attribute');
    });

  let showingError = false;
  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    if (ev.error.type !== 'stt_error') return;
    showingError = true;
    void setSttError(sttErrorMessage(ev.error.error));
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal && showingError) {
      showingError = false;
      void setSttError('');
    }
  });
  session.on(voice.AgentSessionEventTypes.Close, (ev) => {
    logger.info({ reason: ev.reason }, 'agent session closed');
  });

  await session.start({
    agent: new voice.Agent({ instructions: '' }),
    room: ctx.room,
    inputOptions: { participantIdentity: caller.identity },
  });
  logger.info({ asr: config.asrUrl, turnDetector: config.turnDetector }, 'listening to caller');

  ctx.addShutdownCallback(async () => {
    await session.close();
  });
};

import { log, voice } from '@livekit/agents';
import { loadCallConfig } from '../config.js';
import { createStt, createTurnTaking, publishSttErrors } from './listening.js';
import type { CallPipeline } from './types.js';

export { ATTRIBUTE_STT_ERROR } from './listening.js';

/**
 * M1 listening half: Silero VAD cuts utterances → SenseVoice STT → user transcripts.
 * No LLM/TTS; the framework's room IO publishes every final transcript on
 * `lk.transcription` (sender = caller), which the web renders as the user subtitle.
 */
export const transcribePipeline: CallPipeline = async (ctx, caller) => {
  const config = loadCallConfig();
  const logger = log().child({ pipeline: 'transcribe', caller: caller.identity });
  const { vad, turnHandling } = createTurnTaking(config);

  const stt = createStt(config, (t) =>
    logger.info(
      { text: t.text, emotion: t.emotion, events: t.events, asrMs: t.inferenceMs, audioMs: t.audioMs },
      'user utterance recognized',
    ),
  );

  const session = new voice.AgentSession({ vad, stt, turnHandling });
  publishSttErrors(ctx, session, (error) => logger.warn({ error }, 'failed to publish stt error attribute'));
  session.on(voice.AgentSessionEventTypes.Close, (ev) => {
    logger.info({ reason: ev.reason }, 'agent session closed');
  });

  await session.start({
    agent: new voice.Agent({ instructions: '' }),
    room: ctx.room,
    inputOptions: { participantIdentity: caller.identity },
  });
  logger.info({ asr: config.asrBaseUrl, turnDetector: config.turnDetector }, 'listening to caller');

  ctx.addShutdownCallback(async () => {
    await session.close();
  });
};

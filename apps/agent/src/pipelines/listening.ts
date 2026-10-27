import { inference, voice } from '@livekit/agents';
import type { JobContext } from '@livekit/agents';
import type { CallConfig } from '../config.js';
import { AsrError, type AsrTranscript, SenseVoiceSTT } from '../stt/sensevoice.js';
import { TranscriptTurnDetector } from './endpointing.js';

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
export function createTurnTaking(config: CallConfig) {
  const vad = new inference.VAD({ minSilenceDuration: config.vadMinSilenceMs });
  const turnDetection =
    config.turnDetector === 'eot'
      ? new inference.TurnDetector({ version: 'v1-mini' })
      : config.turnDetector === 'transcript'
        ? new TranscriptTurnDetector()
        : 'vad';
  const turnHandling = {
    turnDetection,
    endpointing: { minDelay: config.endpointingMinDelayMs, maxDelay: config.endpointingMaxDelayMs },
    // Plain VAD interruption: 'adaptive' would call LiveKit Cloud.
    interruption: {
      mode: 'vad',
      minDuration: config.interruptionMinSpeechMs,
      falseInterruptionTimeout: config.falseInterruptionTimeoutMs,
    },
  } as const;
  return { vad, turnHandling } as const;
}

export function createStt(
  config: CallConfig,
  onTranscript: (t: AsrTranscript) => void,
  ignore?: (text: string) => boolean,
): SenseVoiceSTT {
  return new SenseVoiceSTT({
    baseUrl: config.asrBaseUrl,
    timeoutMs: config.asrTimeoutMs,
    language: config.asrLanguage,
    apiKey: config.asrApiKey,
    model: config.asrModel,
    onTranscript,
    ignore,
  });
}

function sttErrorMessage(error: unknown): string {
  if (error instanceof AsrError && error.kind === 'timeout') return '语音识别超时，这句话没有识别出来。';
  if (error instanceof AsrError && error.kind === 'service') return '语音识别出错，这句话没有识别出来。';
  return '语音识别服务不可用，这句话没有识别出来。';
}

/**
 * Publishes a user-facing message on an agent participant attribute ('' clears it).
 * Returns a setter that skips redundant updates.
 */
export function attributePublisher(ctx: JobContext, key: string, onFail: (error: unknown) => void) {
  let current = '';
  return (message: string) => {
    if (message === current) return;
    current = message;
    void ctx.room.localParticipant?.setAttributes({ [key]: message }).catch(onFail);
  };
}

/** `ptoy.stt_error`: set on a failed recognition, cleared by the next successful one. */
export function publishSttErrors(ctx: JobContext, session: voice.AgentSession, onFail: (error: unknown) => void): void {
  const set = attributePublisher(ctx, ATTRIBUTE_STT_ERROR, onFail);
  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    if (ev.error.type === 'stt_error') set(sttErrorMessage(ev.error.error));
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal) set('');
  });
}

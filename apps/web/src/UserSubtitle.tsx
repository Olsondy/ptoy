import { useRoomContext, useTranscriptions, useVoiceAssistant } from '@livekit/components-react';
import './UserSubtitle.css';

/** Set by the agent (apps/agent/src/pipelines/transcribe.ts) when ASR fails; '' once it recovers. */
const ATTRIBUTE_STT_ERROR = 'ptoy.stt_error';

/**
 * The caller's latest recognized utterance. The agent publishes user transcripts on LiveKit's
 * standard `lk.transcription` text streams with the caller as sender, so we only keep our own.
 * Must render inside a `RoomContext`.
 */
export function UserSubtitle() {
  const room = useRoomContext();
  const transcriptions = useTranscriptions({ participantIdentities: [room.localParticipant.identity] });
  const { agentAttributes } = useVoiceAssistant();

  const error = agentAttributes?.[ATTRIBUTE_STT_ERROR] || undefined;
  const text = transcriptions.at(-1)?.text ?? '';

  return (
    <p
      className={`user-subtitle${error ? ' is-error' : ''}`}
      data-testid="user-subtitle"
      data-state={error ? 'error' : text ? 'text' : 'empty'}
      aria-live="polite"
    >
      {error ?? text}
    </p>
  );
}

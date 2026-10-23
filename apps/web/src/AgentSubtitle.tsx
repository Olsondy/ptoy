import { useVoiceAssistant } from '@livekit/components-react';
import './AgentSubtitle.css';

/** Set by the agent (apps/agent/src/pipelines/conversation.ts) when LLM/TTS fails; '' once it speaks again. */
const ATTRIBUTE_AGENT_ERROR = 'ptoy.agent_error';

/**
 * The agent's current reply. The agent publishes it on `lk.transcription` paced by its audio
 * playback (LiveKit's transcription sync), so the text grows as the reply is spoken.
 * Must render inside a `RoomContext`.
 */
export function AgentSubtitle() {
  const { agentTranscriptions, agentAttributes } = useVoiceAssistant();

  const error = agentAttributes?.[ATTRIBUTE_AGENT_ERROR] || undefined;
  // The agent inserts invisible U+FEFF word breaks so LiveKit paces Chinese per character.
  const text = (agentTranscriptions.at(-1)?.text ?? '').replaceAll('\uFEFF', '');

  return (
    <p
      className={`agent-subtitle${error ? ' is-error' : ''}`}
      data-testid="agent-subtitle"
      data-state={error ? 'error' : text ? 'text' : 'empty'}
      aria-live="polite"
    >
      {error ?? text}
    </p>
  );
}

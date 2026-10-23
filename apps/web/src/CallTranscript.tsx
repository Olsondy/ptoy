import { useRoomContext, useTranscriptions, useVoiceAssistant } from '@livekit/components-react';

const STATE_LABEL: Record<string, string> = {
  connecting: '正在等候回应', initializing: '正在等候回应',
  listening: '在听你说', thinking: '正在想一想', speaking: '正在回应',
};

export function CallTranscript({ visible, characterName }: { visible: boolean; characterName: string }) {
  const room = useRoomContext();
  const assistant = useVoiceAssistant();
  const transcriptions = useTranscriptions();
  const entries = transcriptions
    .filter((entry) => entry.participantInfo.identity === room.localParticipant.identity || entry.participantInfo.identity === assistant.agent?.identity)
    .map((entry) => ({
      id: entry.streamInfo.attributes?.['lk.segment_id'] ?? entry.streamInfo.id,
      text: entry.text.replace(/\uFEFF/g, '').trim(),
      speaker: entry.participantInfo.identity === room.localParticipant.identity ? 'user' : 'agent',
    }))
    .filter((entry) => entry.text);
  const lastUser = entries.filter((entry) => entry.speaker === 'user').at(-1);
  const lastAgent = entries.filter((entry) => entry.speaker === 'agent').at(-1);
  const latest = entries.filter((entry) => entry === lastUser || entry === lastAgent);
  const agentError = assistant.agentAttributes?.['ptoy.agent_error'];
  const sttError = assistant.agentAttributes?.['ptoy.stt_error'];

  return (
    <div className="transcript-area">
      <p className="conversation-state" aria-live="polite">{STATE_LABEL[assistant.state] ?? '正在等候回应'}</p>
      <div className="caption-window" hidden={!visible} aria-label="实时字幕" data-testid="caption-window">
        {latest.length ? latest.map((entry) => (
          <div className={`caption-line caption-${entry.speaker}`} key={entry.id}>
            <span className="caption-speaker">{entry.speaker === 'user' ? '你' : characterName}</span>
            <p data-testid={`${entry.speaker}-subtitle`} data-state="text" aria-live="polite"><span>{entry.text}</span></p>
          </div>
        )) : <p className="caption-empty">说点什么吧，字幕会出现在这里</p>}
      </div>
      {(agentError || sttError) && <div className="transcript-errors">
        {agentError && <p role="alert" data-testid="agent-error">{agentError}</p>}
        {sttError && <p role="alert" data-testid="stt-error">{sttError}</p>}
      </div>}
    </div>
  );
}

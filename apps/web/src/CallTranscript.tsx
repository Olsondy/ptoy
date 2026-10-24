import { useRoomContext, useTranscriptions, useVoiceAssistant } from '@livekit/components-react';
import { useLayoutEffect, useRef } from 'react';

const STATE_LABEL: Record<string, string> = {
  connecting: '正在等候回应', initializing: '正在等候回应',
  listening: '在听你说', thinking: '正在想一想', speaking: '正在回应',
};

/** Within this many px of the bottom counts as following the live text. */
const FOLLOW_SLACK_PX = 8;

/**
 * A caption that scrolls: it follows the words being spoken, and stays put while the caller has
 * scrolled up to reread the start of a long reply (scrolling back to the bottom follows again).
 */
function CaptionText({ text, speaker }: { text: string; speaker: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const onScroll = () => {
    const el = ref.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };
  return (
    <p ref={ref} onScroll={onScroll} data-testid={`${speaker}-subtitle`} data-state="text" aria-live="polite">
      <span>{text}</span>
    </p>
  );
}

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
            <CaptionText text={entry.text} speaker={entry.speaker} />
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

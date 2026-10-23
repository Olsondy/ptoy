import { useState } from 'react';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CallControls } from './CallControls';
import { CallTranscript } from './CallTranscript';
import { CharacterPicker } from './CharacterPicker';
import { CallOrb } from './orb/CallOrb';
import { type CallStatus, useCall } from './useCall';
import { useCharacters } from './useCharacters';

const STATUS_LABEL: Record<CallStatus, string> = {
  disconnected: '已断开', connecting: '连接中', connected: '通话中',
};

export function App() {
  const call = useCall();
  const characters = useCharacters();
  const [captions, setCaptions] = useState(true);
  const inCall = call.status !== 'disconnected';
  const characterName = characters.options.find((character) => character.id === characters.selectedId)?.name ?? '伙伴';

  return (
    <TooltipProvider delayDuration={350}>
      <RoomContext.Provider value={call.room}>
        <main className="call">
          <header className="call-header">
            <span className="call-wordmark" aria-label="ptoy">ptoy<span>.</span></span>
            <p className="call-status" data-testid="call-status" data-status={call.status} aria-live="polite">
              <span className={`dot dot-${call.status}`} aria-hidden="true" />{STATUS_LABEL[call.status]}
            </p>
            <div className="call-header-actions"><CharacterPicker {...characters} disabled={inCall} /></div>
          </header>
          <section className="call-stage" aria-label="语音通话">
            <CallOrb room={call.room} status={call.status} />
            <div className="call-conversation">
              {call.room ? <CallTranscript key={call.room.name} visible={captions} characterName={characterName} /> : (
                <div className="call-welcome">
                  <h1>{inCall ? '马上就好' : '想聊点什么？'}</h1>
                  <p className="welcome-description">{inCall ? '接通后，就可以自然地说话' : '不必想好开场，随时开始就好'}</p>
                </div>
              )}
            </div>
          </section>
          <CallControls status={call.status} error={call.error}
            captions={captions} onCaptionsChange={setCaptions}
            onToggle={inCall ? call.stop : () => void call.start(characters.selectedId)} />
          {call.room && <RoomAudioRenderer />}
        </main>
      </RoomContext.Provider>
    </TooltipProvider>
  );
}

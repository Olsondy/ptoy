import { useState } from 'react';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CallControls } from './CallControls';
import { CaptionsToggle } from './CaptionsToggle';
import { CallTranscript } from './CallTranscript';
import { CharacterPicker } from './CharacterPicker';
import { CharacterLinkButton } from './CharacterLinkButton';
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
  const fixedUnavailable = characters.locked && (characters.loading || !characters.selectedId || Boolean(characters.error));

  return (
    <TooltipProvider delayDuration={350}>
      <RoomContext.Provider value={call.room}>
        <main className="call">
          <header className="call-header">
            <span className="call-wordmark" aria-label="ptoy">ptoy<span>.</span></span>
            <p className="call-status" data-testid="call-status" data-status={call.status} aria-live="polite">
              <span className={`dot dot-${call.status}`} aria-hidden="true" />{STATUS_LABEL[call.status]}
            </p>
            <div className="call-header-actions">
              {!characters.locked && <CharacterPicker {...characters} disabled={inCall} />}
              {!characters.locked && characters.selectedId && <CharacterLinkButton key={characters.selectedId}
                characterId={characters.selectedId} characterName={characterName} disabled={inCall} />}
              <CaptionsToggle visible={captions} onVisibleChange={setCaptions} />
            </div>
          </header>
          <section className="call-stage" aria-label="语音通话">
            <CallOrb room={call.room} status={call.status} />
            <div className="call-conversation">
              {call.room ? <CallTranscript key={call.room.name} visible={captions} characterName={characterName} /> : (
                <div className="call-welcome">
                  <h1>{inCall ? '马上就好' : characters.locked
                    ? characters.loading ? '正在加载角色' : characters.error ? '暂时无法开始通话' : `和${characterName}聊聊`
                    : '想聊点什么？'}</h1>
                  {!characters.error && <p className="welcome-description">{inCall ? '接通后，就可以自然地说话'
                    : characters.locked && characters.loading ? '正在确认链接中的通话角色' : '不必想好开场，随时开始就好'}</p>}
                </div>
              )}
            </div>
          </section>
          <CallControls status={call.status} error={characters.error ?? call.error}
            disabled={fixedUnavailable}
            onToggle={inCall ? call.stop : () => {
              if (fixedUnavailable) return;
              void call.start(characters.selectedId, characters.characterLink);
            }} />
          {call.room && <RoomAudioRenderer />}
        </main>
      </RoomContext.Provider>
    </TooltipProvider>
  );
}

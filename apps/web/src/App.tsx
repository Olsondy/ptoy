import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { CallControls } from './CallControls';
import { CaptionsToggle } from './CaptionsToggle';
import { CallTranscript } from './CallTranscript';
import { CharacterPicker } from './CharacterPicker';
import { CharacterLinkButton } from './CharacterLinkButton';
import { CallOrb } from './orb/CallOrb';
import { type CallStatus, useCall } from './useCall';
import { useCharacters } from './useCharacters';
import { useAccess } from './useAccess';
import { InviteGate } from './InviteGate';
import { accessErrorMessage } from './token';
import { useAvailability } from './useAvailability';

const STATUS_LABEL: Record<CallStatus, string> = {
  disconnected: '已断开', connecting: '连接中', connected: '通话中',
};

export function App() {
  const access = useAccess();
  const availability = useAvailability(access.authenticated);
  const call = useCall();
  const characters = useCharacters(access.authenticated || call.status !== 'disconnected');
  const [captions, setCaptions] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const inCall = call.status !== 'disconnected';
  const characterName = characters.options.find((character) => character.id === characters.selectedId)?.name ?? '伙伴';
  const fixedUnavailable = characters.locked && (characters.loading || !characters.selectedId || Boolean(characters.error));
  useEffect(() => {
    if (access.resolved && !access.authenticated && inCall) call.resolveAccessLoss();
  }, [access.resolved, access.authenticated, inCall, call.resolveAccessLoss]);
  if (!access.authenticated && !inCall) {
    const notice = access.code === 'revoked' ? '这个邀请已失效，请联系邀请你的朋友。'
      : access.code === 'unauthorized' ? '请输入邀请码以继续访问。' : undefined;
    return <InviteGate loading={access.checking} notice={notice} sessionError={access.error}
      onRetry={() => void access.refresh()} onRedeem={access.redeem} />;
  }
  const logout = async () => {
    if (inCall || loggingOut) return;
    setLoggingOut(true); setLogoutError('');
    try { await access.logout(); }
    catch (error) { setLogoutError(accessErrorMessage(error)); }
    finally { setLoggingOut(false); }
  };

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
              <Tooltip><TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-11 rounded-full text-muted-foreground"
                  aria-label="退出此设备" disabled={inCall || loggingOut} onClick={() => void logout()}>
                  <LogOut aria-hidden="true" />
                </Button>
              </TooltipTrigger><TooltipContent>{inCall ? '先挂断，再退出此设备' : '退出此设备'}</TooltipContent></Tooltip>
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
          <CallControls status={call.status} error={characters.error ?? call.error ?? (logoutError || access.error || (!inCall && availability.error) || undefined)}
            notice={!inCall && availability.checking ? '正在检查通话服务，请稍候。' : undefined}
            disabled={fixedUnavailable || (!inCall && (!access.authenticated || loggingOut || !availability.available))}
            onToggle={inCall ? call.stop : () => {
              if (fixedUnavailable || !availability.available) return;
              void call.start(characters.selectedId, characters.characterLink);
            }} />
          {call.room && <RoomAudioRenderer />}
        </main>
      </RoomContext.Provider>
    </TooltipProvider>
  );
}

import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import { type CallStatus, useCall } from './useCall';

const STATUS_LABEL: Record<CallStatus, string> = {
  disconnected: '已断开',
  connecting: '连接中',
  connected: '通话中',
};

export function App() {
  const call = useCall();
  const inCall = call.status !== 'disconnected';

  return (
    <main className="call">
      <p className="call-status" data-testid="call-status" data-status={call.status} aria-live="polite">
        <span className={`dot dot-${call.status}`} aria-hidden="true" />
        {STATUS_LABEL[call.status]}
      </p>

      {/* Placeholder for the voice orb (#9). Keep this slot; the orb canvas replaces its contents. */}
      <section className="orb-slot" data-testid="orb-slot" data-status={call.status} aria-hidden="true" />

      <div className="call-footer">
        {call.error && (
          <p className="call-error" role="alert" data-testid="call-error">
            {call.error}
          </p>
        )}
        <button
          type="button"
          className={`call-toggle ${inCall ? 'is-active' : ''}`}
          data-testid="call-toggle"
          aria-pressed={inCall}
          onClick={inCall ? call.stop : () => void call.start()}
        >
          {inCall ? '挂断' : '开始通话'}
        </button>
      </div>

      {call.room && (
        <RoomContext.Provider value={call.room}>
          <RoomAudioRenderer />
        </RoomContext.Provider>
      )}
    </main>
  );
}

import { RoomContext, useLocalParticipant, useVoiceAssistant } from '@livekit/components-react';
import type { AgentState } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import { useEffect, useState } from 'react';
import type { CallStatus } from '../useCall';
import { Orb } from './Orb';
import { OrbPreviewPanel, readPreviewState } from './OrbPreview';
import type { OrbState } from './renderer';

interface LiveOrbInput {
  readonly state: OrbState;
  readonly micTrack?: MediaStreamTrack;
  readonly agentTrack?: MediaStreamTrack;
}

const IDLE_INPUT: LiveOrbInput = { state: 'idle' };

export function toOrbState(agent: AgentState): OrbState {
  switch (agent) {
    case 'listening':
    case 'thinking':
    case 'speaking':
      return agent;
    default:
      return 'idle';
  }
}

/** Lives inside RoomContext and reports agent state + audio tracks upward. Renders nothing. */
function RoomBinding({ onChange }: { onChange: (input: LiveOrbInput) => void }) {
  const assistant = useVoiceAssistant();
  const { microphoneTrack } = useLocalParticipant();
  const state = toOrbState(assistant.state);
  const micTrack = microphoneTrack?.track?.mediaStreamTrack;
  const agentTrack = assistant.audioTrack?.publication.track?.mediaStreamTrack;

  useEffect(() => {
    onChange({ state, micTrack, agentTrack });
  }, [onChange, state, micTrack, agentTrack]);

  return null;
}

export interface CallOrbProps {
  readonly room: Room | undefined;
  readonly status: CallStatus;
}

/** The orb slot: idle outside a call, driven by the LiveKit agent state during one. */
export function CallOrb({ room, status }: CallOrbProps) {
  const [live, setLive] = useState<LiveOrbInput>(IDLE_INPUT);
  const [preview, setPreview] = useState<OrbState | undefined>(() =>
    import.meta.env.DEV ? readPreviewState() : undefined,
  );

  useEffect(() => {
    if (!room) setLive(IDLE_INPUT);
  }, [room]);

  const input = room ? live : IDLE_INPUT;
  const state = preview ?? input.state;
  const simulateAudio = preview === 'listening' || preview === 'speaking';

  return (
    <section className="orb-slot" data-testid="orb-slot" data-status={status} data-orb-state={state}>
      <Orb
        state={state}
        micTrack={preview ? undefined : input.micTrack}
        agentTrack={preview ? undefined : input.agentTrack}
        simulateAudio={simulateAudio}
      />
      {room && (
        <RoomContext.Provider value={room}>
          <RoomBinding onChange={setLive} />
        </RoomContext.Provider>
      )}
      {import.meta.env.DEV && preview && <OrbPreviewPanel value={preview} onChange={setPreview} />}
    </section>
  );
}

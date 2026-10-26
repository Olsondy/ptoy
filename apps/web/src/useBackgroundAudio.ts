import { useEffect } from 'react';
import { type Room, RoomEvent } from 'livekit-client';

/** The agent's background ambience track (ADR 0013; `BackgroundAudioPlayer`'s fixed name). */
export const BACKGROUND_TRACK = 'background_audio';

/**
 * Pauses or resumes the agent's background track in this browser only: the agent keeps playing,
 * so turning it back on picks up the current level. Also applies to a track published later.
 */
export function useBackgroundAudio(room: Room | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!room) return;
    const apply = () => {
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.trackName === BACKGROUND_TRACK && publication.isEnabled !== enabled) publication.setEnabled(enabled);
        }
      }
    };
    apply();
    room.on(RoomEvent.TrackPublished, apply).on(RoomEvent.TrackSubscribed, apply);
    return () => {
      room.off(RoomEvent.TrackPublished, apply).off(RoomEvent.TrackSubscribed, apply);
    };
  }, [room, enabled]);
}

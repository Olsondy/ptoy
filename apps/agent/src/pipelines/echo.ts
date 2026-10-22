import { log } from '@livekit/agents';
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { CallPipeline } from './types.js';

/** Same attribute `voice.AgentSession` publishes; the web reads it via `useVoiceAssistant`. */
const ATTRIBUTE_AGENT_STATE = 'lk.agent.state';
const SAMPLE_RATE = 48000;
const NUM_CHANNELS = 1;

/**
 * M0 echo: subscribe to the caller's microphone and play it straight back on
 * the agent's own microphone track, so the caller hears themselves.
 */
export const echoPipeline: CallPipeline = async (ctx, caller) => {
  const logger = log().child({ pipeline: 'echo', caller: caller.identity });
  const room = ctx.room;

  const source = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('agent-echo', source);
  const publishOptions = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
  await room.localParticipant?.publishTrack(track, publishOptions);

  let activeStream: AudioStream | undefined;

  const pump = async (remote: RemoteTrack): Promise<void> => {
    const stream = new AudioStream(remote, { sampleRate: SAMPLE_RATE, numChannels: NUM_CHANNELS });
    activeStream = stream;
    logger.info({ track: remote.sid }, 'echoing caller microphone');
    try {
      for await (const frame of stream) {
        if (source.closed) break;
        await source.captureFrame(frame);
      }
    } catch (error) {
      logger.warn({ error }, 'echo stream ended with error');
    } finally {
      if (activeStream === stream) activeStream = undefined;
    }
  };

  const isCallerMic = (publication: RemoteTrackPublication, participant: RemoteParticipant) =>
    participant.identity === caller.identity &&
    publication.kind === TrackKind.KIND_AUDIO &&
    publication.source === TrackSource.SOURCE_MICROPHONE;

  const onTrackSubscribed = (
    remote: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (isCallerMic(publication, participant)) void pump(remote);
  };
  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

  // The mic may already be subscribed before this listener was attached.
  for (const publication of caller.trackPublications.values()) {
    if (publication.track && isCallerMic(publication, caller)) void pump(publication.track);
  }

  await room.localParticipant?.setAttributes({ [ATTRIBUTE_AGENT_STATE]: 'listening' });

  ctx.addShutdownCallback(async () => {
    room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    await activeStream?.cancel();
    await source.close();
    await track.close();
  });
};

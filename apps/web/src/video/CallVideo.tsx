import { RoomEvent, type Room } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { localVideoUrl } from './local';
import { allVideoSources, nextClip, parseVideoScene, playbackClips, type VideoScene } from './playlist';

const ATTRIBUTE_VIDEO = 'ptoy.video';

function useVideoScene(room: Room | undefined): VideoScene {
  const [scene, setScene] = useState<VideoScene>('common');
  useEffect(() => {
    if (!room) {
      setScene('common');
      return;
    }
    const read = () => {
      for (const participant of room.remoteParticipants.values()) {
        const value = participant.attributes[ATTRIBUTE_VIDEO];
        if (value) {
          setScene(parseVideoScene(value));
          return;
        }
      }
    };
    read();
    room.on(RoomEvent.ParticipantAttributesChanged, read);
    room.on(RoomEvent.ParticipantConnected, read);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, read);
      room.off(RoomEvent.ParticipantConnected, read);
    };
  }, [room]);
  return scene;
}

function clipOf(el: HTMLVideoElement): string {
  return el.dataset.clip ?? '';
}

function playMuted(el: HTMLVideoElement): void {
  el.muted = true;
  el.defaultMuted = true;
  el.playsInline = true;
  void el.play().catch(() => undefined);
}

function loadClip(el: HTMLVideoElement, src: string): void {
  if (clipOf(el) === src && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  el.dataset.clip = src;
  el.src = src;
  el.load();
}

function holdFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement | null): void {
  if (!canvas || video.videoWidth === 0) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    ctx.drawImage(video, 0, 0);
    canvas.classList.add('is-holding');
  } catch {
    canvas.classList.remove('is-holding');
  }
}

/** One player. A canvas keeps the last frame while the next local clip replaces `src`, so the box does not go black and a covered second element is not left waiting on iOS. */
function ClipStage({ scene, clips }: { readonly scene: VideoScene; readonly clips: readonly string[] }) {
  const clipsRef = useRef(clips);
  const sceneRef = useRef(scene);
  const indexRef = useRef(0);
  const tokenRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const playIndex = (index: number) => {
    const el = videoRef.current;
    const src = clipsRef.current[index];
    if (!el || !src) return;
    indexRef.current = index;
    if (clipOf(el) === src && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (el.currentTime > 0.2) el.currentTime = 0;
      canvasRef.current?.classList.remove('is-holding');
      playMuted(el);
      return;
    }
    holdFrame(el, canvasRef.current);
    const token = ++tokenRef.current;
    const start = () => {
      if (tokenRef.current !== token || clipOf(el) !== src) return;
      canvasRef.current?.classList.remove('is-holding');
      playMuted(el);
    };
    el.addEventListener('loadeddata', start, { once: true });
    loadClip(el, src);
  };

  useEffect(() => {
    clipsRef.current = clips;
    sceneRef.current = scene;
    const el = videoRef.current;
    if (!el || !clips[0]) return;
    el.loop = clips.length === 1;
    if (clipOf(el) === clips[0] && indexRef.current === 0 && !el.ended && !el.paused) return;
    playIndex(0);
    // Phones block the first play() until a gesture. Keep trying, and start on the next tap,
    // so the silent clip runs as soon as the files are ready instead of waiting for speech.
    const kick = () => {
      const node = videoRef.current;
      if (!node || !node.paused) return;
      playMuted(node);
    };
    kick();
    window.addEventListener('pointerdown', kick);
    const timer = window.setInterval(kick, 400);
    return () => {
      window.removeEventListener('pointerdown', kick);
      window.clearInterval(timer);
    };
  }, [clips, scene]);

  const advance = () => {
    if (clipsRef.current.length <= 1) return;
    playIndex(nextClip(sceneRef.current, indexRef.current, clipsRef.current.length));
  };

  return (
    <div className="call-video" data-testid="call-video" data-scene={scene}>
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        preload="auto"
        aria-label="对话画面"
        loop={clips.length === 1}
        onEnded={advance}
        onError={advance}
      />
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}

/** Blob URLs for the clips on screen now; the previous ones keep playing until these are ready. */
function useLocalClips(remotes: readonly string[]): readonly string[] {
  const key = remotes.join('\n');
  const [shown, setShown] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    // A file that fails stays on its remote URL so playback can still start.
    void Promise.all(key.split('\n').map((url) => localVideoUrl(url).catch(() => url))).then((clips) => {
      if (!cancelled) setShown(clips);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return shown;
}

/** Warms the clips the current scene does not need yet, so switching scenes stays instant. */
function useWarmLibrary(): void {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const url of allVideoSources()) void localVideoUrl(url).catch(() => undefined);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, []);
}

function useAgentSpeaking(room: Room | undefined): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!room) {
      setSpeaking(false);
      return;
    }
    const read = () => {
      let next = false;
      for (const participant of room.remoteParticipants.values()) {
        if (participant.attributes['lk.agent.state'] === 'speaking') next = true;
      }
      setSpeaking(next);
    };
    read();
    room.on(RoomEvent.ParticipantAttributesChanged, read);
    room.on(RoomEvent.ParticipantConnected, read);
    room.on(RoomEvent.ParticipantDisconnected, read);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, read);
      room.off(RoomEvent.ParticipantConnected, read);
      room.off(RoomEvent.ParticipantDisconnected, read);
    };
  }, [room]);
  return speaking;
}

/** Muted looping clips. The scene's clips load first; the rest warm up in the background. */
export function CallVideo({ room }: { readonly room: Room | undefined }) {
  const scene = useVideoScene(room);
  const speaking = useAgentSpeaking(room);
  const clips = useLocalClips(playbackClips(scene, speaking));
  useWarmLibrary();
  if (clips.length === 0) return <div className="call-video" data-testid="call-video" data-scene={scene} />;
  return <ClipStage scene={scene} clips={clips} />;
}

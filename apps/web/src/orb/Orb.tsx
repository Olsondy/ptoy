import { useEffect, useRef } from 'react';
import { AudioMeter, type AudioReading, SILENCE, syntheticReading } from './audioMeter';
import { type OrbState, OrbRenderer } from './renderer';

export interface OrbProps {
  readonly state: OrbState;
  /** Local microphone; drives the orb while listening. */
  readonly micTrack?: MediaStreamTrack;
  /** Agent's voice; drives the orb while speaking. */
  readonly agentTrack?: MediaStreamTrack;
  /** Feed a synthetic speech-like level instead of real audio (dev preview). */
  readonly simulateAudio?: boolean;
}

interface Meters {
  readonly mic?: AudioMeter;
  readonly agent?: AudioMeter;
}

/**
 * Canvas orb. React only hands over the target state and tracks; drawing and audio
 * metering run in a requestAnimationFrame loop that never triggers a re-render.
 */
export function Orb({ state, micTrack, agentTrack, simulateAudio = false }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OrbRenderer | undefined>(undefined);
  const stateRef = useRef(state);
  const metersRef = useRef<Meters>({});
  const simulateRef = useRef(simulateAudio);

  useEffect(() => {
    simulateRef.current = simulateAudio;
  }, [simulateAudio]);

  useEffect(() => {
    stateRef.current = state;
    rendererRef.current?.setState(state);
  }, [state]);

  // Audio graph: one AudioContext per set of tracks, torn down on hangup/unmount.
  useEffect(() => {
    if (!micTrack && !agentTrack) return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const meters: Meters = {
      mic: micTrack ? new AudioMeter(ctx, micTrack) : undefined,
      agent: agentTrack ? new AudioMeter(ctx, agentTrack) : undefined,
    };
    metersRef.current = meters;

    // Some browsers (iOS Safari) keep a context suspended until the next user gesture.
    const resume = () => void ctx.resume().catch(() => undefined);
    resume();
    document.addEventListener('pointerdown', resume, { once: true });

    return () => {
      document.removeEventListener('pointerdown', resume);
      metersRef.current = {};
      meters.mic?.dispose();
      meters.agent?.dispose();
      void ctx.close().catch(() => undefined);
    };
  }, [micTrack, agentTrack]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new OrbRenderer(canvas, stateRef.current);
    rendererRef.current = renderer;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frameId = 0;
    let last = 0;
    let clock = 0;

    const read = (meter: AudioMeter | undefined): AudioReading => meter?.read() ?? SILENCE;

    const tick = (now: number) => {
      const dt = last ? (now - last) / 1000 : 1 / 60;
      last = now;
      clock += dt;
      const simulated = simulateRef.current ? syntheticReading(clock) : undefined;
      const meters = metersRef.current;
      renderer.frame(dt, {
        mic: simulated ?? read(meters.mic),
        agent: simulated ?? read(meters.agent),
        reducedMotion: motionQuery.matches,
      });
      frameId = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frameId || document.hidden) return;
      last = 0;
      frameId = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frameId);
      frameId = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    document.addEventListener('visibilitychange', onVisibility);
    start();

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      rendererRef.current = undefined;
    };
  }, []);

  return <canvas ref={canvasRef} className="orb-canvas" aria-hidden="true" />;
}

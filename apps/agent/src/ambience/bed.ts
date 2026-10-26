import { AudioFrame } from '@livekit/rtc-node';
import { AMBIENCE_SAMPLE_RATE, type Ambience, type AmbienceLevel } from './manifest.js';

/** 10 ms frames: a level change starts fading within a frame of being asked for. */
const FRAME_SAMPLES = AMBIENCE_SAMPLE_RATE / 100;

/** One loop being heard, fading towards `target`. */
interface Voice {
  readonly level: AmbienceLevel;
  readonly loop: Int16Array;
  pos: number;
  gain: number;
  target: number;
  /** Gain change per sample, so every fade takes `fadeMs` whatever the volumes. */
  rate: number;
}

/**
 * The background track's audio: the current level's loop, repeated seamlessly, crossfaded into the
 * next level over `fadeMs` (a silent level fades out). Pulled frame by frame by the
 * `BackgroundAudioPlayer` mixer, which paces it in real time.
 */
export class AmbienceBed {
  readonly #levels: ReadonlyMap<string, AmbienceLevel>;
  /** Samples a fade lasts. */
  readonly #fadeSamples: number;
  #voices: Voice[] = [];
  #closed = false;

  constructor(ambience: Ambience) {
    this.#levels = new Map(ambience.levels.map((l) => [l.id, l]));
    this.#fadeSamples = Math.max(1, (ambience.fadeMs / 1000) * AMBIENCE_SAMPLE_RATE);
  }

  /** Fade to `id` (a known level id). */
  set(id: string): void {
    const level = this.#levels.get(id);
    if (!level) throw new Error(`unknown ambience level "${id}"`);
    const fade = (v: Voice, target: number) => {
      v.target = target;
      v.rate = Math.abs(target - v.gain) / this.#fadeSamples;
    };
    let resumed = false;
    for (const v of this.#voices) {
      // A level faded back in before it was gone resumes where it is instead of restarting.
      if (v.level === level) {
        fade(v, level.volume);
        resumed = true;
      } else fade(v, 0);
    }
    if (!resumed && level.loop) {
      const v: Voice = { level, loop: level.loop, pos: 0, gain: 0, target: 0, rate: 0 };
      fade(v, level.volume);
      this.#voices.push(v);
    }
  }

  close(): void {
    this.#closed = true;
  }

  async *frames(): AsyncGenerator<AudioFrame> {
    const mix = new Float32Array(FRAME_SAMPLES);
    while (!this.#closed) {
      mix.fill(0);
      for (const v of this.#voices) {
        for (let i = 0; i < FRAME_SAMPLES; i++) {
          if (v.gain < v.target) v.gain = Math.min(v.target, v.gain + v.rate);
          else if (v.gain > v.target) v.gain = Math.max(v.target, v.gain - v.rate);
          mix[i] = mix[i]! + v.loop[v.pos]! * v.gain;
          v.pos = v.pos + 1 === v.loop.length ? 0 : v.pos + 1;
        }
      }
      this.#voices = this.#voices.filter((v) => v.gain > 0 || v.target > 0);
      const out = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(mix[i]!)));
      yield new AudioFrame(out, AMBIENCE_SAMPLE_RATE, 1, FRAME_SAMPLES);
    }
  }
}

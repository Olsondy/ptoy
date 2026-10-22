/** One loudness sample: overall level plus four voice-range bands, all normalised to 0..1. */
export interface AudioReading {
  readonly level: number;
  readonly bands: readonly [number, number, number, number];
}

export const SILENCE: AudioReading = { level: 0, bands: [0, 0, 0, 0] };

/** Band edges in Hz, tuned for speech: body, vowels, presence, sibilance. */
const BAND_EDGES = [80, 250, 800, 2500, 6000] as const;
/** RMS in dBFS mapped to 0..1: below FLOOR is silence, FLOOR + RANGE is full scale. */
const DB_FLOOR = -58;
const DB_RANGE = 42;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Taps a MediaStreamTrack with an AnalyserNode. Reads are cheap and meant to be called once per frame. */
export class AudioMeter {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly wave: Float32Array<ArrayBuffer>;
  private readonly spectrum: Uint8Array<ArrayBuffer>;
  private readonly bandBins: readonly (readonly [number, number])[];

  constructor(ctx: AudioContext, track: MediaStreamTrack) {
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -20;
    this.source.connect(this.analyser);
    this.wave = new Float32Array(this.analyser.fftSize);
    this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);

    const hzPerBin = ctx.sampleRate / this.analyser.fftSize;
    const maxBin = this.analyser.frequencyBinCount - 1;
    const toBin = (hz: number) => Math.min(maxBin, Math.max(1, Math.round(hz / hzPerBin)));
    this.bandBins = [
      [toBin(BAND_EDGES[0]), toBin(BAND_EDGES[1])],
      [toBin(BAND_EDGES[1]), toBin(BAND_EDGES[2])],
      [toBin(BAND_EDGES[2]), toBin(BAND_EDGES[3])],
      [toBin(BAND_EDGES[3]), toBin(BAND_EDGES[4])],
    ];
  }

  read(): AudioReading {
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (const v of this.wave) sum += v * v;
    const rms = Math.sqrt(sum / this.wave.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const level = clamp01((db - DB_FLOOR) / DB_RANGE);

    this.analyser.getByteFrequencyData(this.spectrum);
    const band = ([from, to]: readonly [number, number]) => {
      const bins = this.spectrum.subarray(from, Math.max(from + 1, to));
      let acc = 0;
      for (const v of bins) acc += v;
      return clamp01(acc / bins.length / 255);
    };
    const [a, b, c, d] = this.bandBins.map(band);
    return { level, bands: [a ?? 0, b ?? 0, c ?? 0, d ?? 0] };
  }

  dispose(): void {
    this.source.disconnect();
    this.analyser.disconnect();
  }
}

/** Speech-like synthetic signal for previewing the orb without a call: syllables, phrases and pauses. */
export function syntheticReading(t: number): AudioReading {
  const phrase = Math.max(0, Math.sin(t * 0.9) * 0.8 + 0.45);
  const syllable = Math.pow(Math.abs(Math.sin(t * 6.3 + Math.sin(t * 2.1) * 1.4)), 1.6);
  const level = clamp01(phrase * (0.25 + 0.75 * syllable));
  return {
    level,
    bands: [
      clamp01(level * (0.8 + 0.2 * Math.sin(t * 3.1))),
      clamp01(level * (0.7 + 0.3 * Math.sin(t * 4.7 + 1))),
      clamp01(level * (0.5 + 0.4 * Math.sin(t * 7.3 + 2))),
      clamp01(level * (0.3 + 0.3 * Math.sin(t * 9.1 + 3))),
    ],
  };
}

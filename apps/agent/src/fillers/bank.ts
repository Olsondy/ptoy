import { AudioFrame } from '@livekit/rtc-node';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { toFrames } from '../tts/plugin.js';
import { decodeWav } from '../tts/wav.js';
import { FILLER_GROUPS, type FillerGroup, FillerPicker, chooseFillerGroup, fillerPlayChance } from './choice.js';

const entrySchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  file: z.string().min(1),
  duration_ms: z.number().nonnegative().optional(),
});

/** `assets/fillers/<voice>/manifest.json`, version 1 (services/fillers/README.md). Unknown groups are ignored. */
const manifestSchema = z.object({
  version: z.literal(1),
  groups: z.record(z.string(), z.array(entrySchema)),
});

export interface Filler {
  readonly id: string;
  readonly group: FillerGroup;
  /** What the filler says (logs only: it is neither subtitled nor written to the history). */
  readonly text: string;
  readonly durationMs: number;
  /** Mono s16 at the agent track rate, 20 ms frames. */
  readonly frames: readonly AudioFrame[];
}

/**
 * The pre-recorded fillers, decoded and resampled to the agent track rate once per process.
 * `next(transcript, emotion)` picks the one to play for a finished user turn, or none.
 */
export class FillerBank {
  readonly fillers: readonly Filler[];
  readonly #picker: FillerPicker<Filler>;
  readonly #random: () => number;
  /** Group played on the previous turn (`undefined` when that turn had no filler). */
  #lastGroup: FillerGroup | undefined;

  /** `always`: every turn gets a filler (testing); otherwise turns are skipped by chance. */
  constructor(fillers: readonly Filler[], random: () => number = Math.random, always = false) {
    this.fillers = fillers;
    this.#random = always ? () => 0 : random;
    const groups = new Map<FillerGroup, Filler[]>();
    for (const f of fillers) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
    this.#picker = new FillerPicker(groups, random);
  }

  /**
   * Group by {@link chooseFillerGroup}, skipped by chance ({@link fillerPlayChance}), never the
   * filler of the previous turn. `undefined` = this turn gets no filler.
   */
  next(transcript: string, asrEmotion?: string): Filler | undefined {
    const group = chooseFillerGroup(transcript, asrEmotion);
    const play = this.#random() < fillerPlayChance(group, this.#lastGroup);
    const filler = play ? this.#picker.pick(group) : undefined;
    this.#lastGroup = filler && group;
    return filler;
  }
}

/** Fresh frame stream for one playback (the frames' PCM is shared, the frame objects are not). */
export function fillerAudio(filler: Filler): ReadableStream<AudioFrame> {
  let i = 0;
  return new ReadableStream<AudioFrame>({
    pull(controller) {
      const f = filler.frames[i++];
      if (!f) {
        controller.close();
        return;
      }
      controller.enqueue(new AudioFrame(f.data, f.sampleRate, f.channels, f.samplesPerChannel));
    },
  });
}

/** The voice's filler set: fillers are recorded per voice so they sound like the reply after them. */
export function fillerManifestPath(fillersDir: string, voice: string): string {
  return join(fillersDir, voice, 'manifest.json');
}

const cache = new Map<string, Promise<FillerBank>>();

/**
 * Loads (once per manifest path, rate and `always`) every filler of the manifest; throws on a bad
 * manifest or wav. `always`: see {@link FillerBank}.
 */
export function loadFillerBank(manifestPath: string, sampleRate: number, always = false): Promise<FillerBank> {
  const key = `${resolve(manifestPath)}@${sampleRate}${always ? ':always' : ''}`;
  let bank = cache.get(key);
  if (!bank) {
    bank = readFillerBank(manifestPath, sampleRate, always);
    bank.catch(() => cache.delete(key));
    cache.set(key, bank);
  }
  return bank;
}

async function readFillerBank(manifestPath: string, sampleRate: number, always: boolean): Promise<FillerBank> {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch (error) {
    throw new Error(`Invalid filler manifest ${manifestPath}: ${(error as Error).message}`);
  }
  const dir = dirname(manifestPath);
  const fillers: Filler[] = [];
  for (const group of FILLER_GROUPS) {
    for (const entry of manifest.groups[group] ?? []) {
      const path = resolve(dir, entry.file);
      let frames: AudioFrame[];
      try {
        frames = toFrames(decodeWav(new Uint8Array(await readFile(path))), sampleRate);
      } catch (error) {
        throw new Error(`Unreadable filler ${entry.id} (${path}): ${(error as Error).message}`);
      }
      const samples = frames.reduce((n, f) => n + f.samplesPerChannel, 0);
      fillers.push({
        id: entry.id,
        group,
        text: entry.text,
        durationMs: Math.round((samples / sampleRate) * 1000),
        frames,
      });
    }
  }
  if (fillers.length === 0) throw new Error(`Filler manifest ${manifestPath} has no fillers`);
  return new FillerBank(fillers, Math.random, always);
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decodeWav } from '../tts/wav.js';

/** The background track runs at the mixer's rate (`BackgroundAudioPlayer`: 48 kHz mono). */
export const AMBIENCE_SAMPLE_RATE = 48000;

export const AMBIENCE_MANIFEST = 'manifest.json';

/** The reply tag the levels are picked with: `<bg:level>` (ADR 0013). */
export const AMBIENCE_TAG = 'bg';

const levelSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, "_" or "-"'),
  /** What the level means, shown to the LLM. */
  description: z.string().min(1),
  /** Seamless loop in the manifest's directory, 48 kHz mono 16-bit WAV; none = silence. */
  file: z.string().min(1).optional(),
  volume: z.number().min(0).max(1).default(1),
});

/**
 * `<AMBIENCE_DIR>/manifest.json`. Layered so an environment layer can join the intensity one later;
 * this version plays exactly one layer, picked with `<bg:…>`. Its first level is where a call starts.
 */
const manifestSchema = z.object({
  /** Crossfade length when the level changes. */
  fadeMs: z.number().int().min(0).max(10000).default(1500),
  layers: z
    .array(
      z.object({
        id: z.string().min(1),
        tag: z.literal(AMBIENCE_TAG),
        levels: z.array(levelSchema).min(2),
      }),
    )
    .length(1, 'exactly one layer (the `bg` intensity layer) is supported'),
});

export interface AmbienceLevel {
  readonly id: string;
  readonly description: string;
  /** 48 kHz mono loop, or `undefined` for silence. */
  readonly loop: Int16Array | undefined;
  readonly volume: number;
}

export interface Ambience {
  readonly fadeMs: number;
  /** In manifest order; the first is the starting level. */
  readonly levels: readonly AmbienceLevel[];
}

/** Reads and checks the manifest and every loop; throws an `Error` naming what is wrong. */
export function loadAmbience(dir: string): Ambience {
  const path = join(dir, AMBIENCE_MANIFEST);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const [layer] = parsed.data.layers;
  const ids = new Set<string>();
  const levels = layer!.levels.map((level): AmbienceLevel => {
    if (ids.has(level.id)) throw new Error(`${path}: level "${level.id}" appears twice`);
    ids.add(level.id);
    return { id: level.id, description: level.description, volume: level.volume, loop: level.file ? readLoop(dir, level.file) : undefined };
  });
  return { fadeMs: parsed.data.fadeMs, levels };
}

function readLoop(dir: string, file: string): Int16Array {
  const path = join(dir, file);
  let audio;
  try {
    audio = decodeWav(new Uint8Array(readFileSync(path)));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (audio.sampleRate !== AMBIENCE_SAMPLE_RATE || audio.channels !== 1) {
    throw new Error(
      `${path} is ${audio.sampleRate} Hz / ${audio.channels} ch; expected ${AMBIENCE_SAMPLE_RATE} Hz mono (convert with services/ambience)`,
    );
  }
  if (audio.samples.length < AMBIENCE_SAMPLE_RATE) throw new Error(`${path} is shorter than 1 s`);
  return seamless(audio.samples);
}

/** Length of the crossfade that joins a loop's end to its start. */
const SEAM_SAMPLES = AMBIENCE_SAMPLE_RATE / 20;

/**
 * The loop with its last 50 ms crossfaded into its first 50 ms (and dropped), so repeating it has
 * no click at the seam whatever the source file ends on.
 */
export function seamless(samples: Int16Array): Int16Array {
  const n = SEAM_SAMPLES;
  const out = samples.slice(0, samples.length - n);
  const tail = samples.length - n;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = Math.round(samples[i]! * t + samples[tail + i]! * (1 - t));
  }
  return out;
}

/**
 * The LLM's instructions for the tag, built from the manifest so levels and loops never drift apart.
 * Appended to the persona of characters with `ambience: true`, with or without `_rules.md`.
 */
export function ambienceRules(ambience: Ambience): string {
  const levels = ambience.levels.map((l) => `- ${l.id}：${l.description}`).join('\n');
  return [
    '## 背景音标签（系统用，用户听不到）',
    `每段回复的最开头先写一个背景音标签 <${AMBIENCE_TAG}:档位>，再写正文；有情绪标签时写在它后面。档位按整段场景到目前为止的气氛判断，不按单句里的字眼；气氛缓和下来可以降档：`,
    levels,
    `档位只能用上面的英文小写 id，例如 <${AMBIENCE_TAG}:${ambience.levels[1]?.id ?? ambience.levels[0]!.id}>。每段回复只写一个标签，不要在正文里提到背景音或标签。`,
  ].join('\n');
}

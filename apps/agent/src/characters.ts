import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Caller participant attribute carrying the character id picked on the page. The token server
 * writes it into the access token; the agent reads it when the caller joins (ADR 0007).
 */
export const ATTRIBUTE_CHARACTER = 'ptoy.character';

/** Shared call rules (length, fillers, emotion tags) appended to every character's persona. */
const RULES_FILE = '_rules.md';

/** What the page shows in the character picker. */
export interface CharacterSummary {
  /** File name without `.md`. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Per-character TTS tuning from the front matter (ADR 0009); sent with every synthesis request. */
export interface TtsTuning {
  /** Speaking-rate multiplier (`tts_speed`), 1 = the model's own pace. */
  readonly speed: number;
  /** Inner-pause cap in ms (`tts_max_pause_ms`); undefined = the TTS service's setting. */
  readonly maxPauseMs?: number;
  /** Emotion strength for tagged sentences (`tts_emo_weight`); undefined = `TTS_EMO_WEIGHT`. */
  readonly emoWeight?: number;
}

export interface Character extends CharacterSummary {
  /**
   * TTS voice id: a speaker reference of `services/tts` (`<voice>.wav` in its `TTS_VOICES_DIR`)
   * and the filler set `assets/fillers/<voice>/` (ADR 0008).
   */
  readonly voice: string;
  readonly tts: TtsTuning;
  /** Full system prompt: the persona followed by the shared call rules. */
  readonly instructions: string;
}

export class CharacterCatalog {
  /** Default character first, the others by id. */
  readonly characters: readonly Character[];
  readonly defaultCharacter: Character;

  constructor(characters: readonly Character[], defaultId: string) {
    const fallback = characters.find((c) => c.id === defaultId);
    if (!fallback) {
      throw new Error(`DEFAULT_CHARACTER "${defaultId}" not found (have: ${characters.map((c) => c.id).join(', ')})`);
    }
    this.defaultCharacter = fallback;
    this.characters = [fallback, ...characters.filter((c) => c !== fallback)];
  }

  get(id: string): Character | undefined {
    return this.characters.find((c) => c.id === id);
  }

  /** The requested character, or the default when none was asked for or it no longer exists. */
  resolve(id: string | undefined): Character {
    return (id !== undefined && this.get(id)) || this.defaultCharacter;
  }
}

const SPEED_RANGE = [0.8, 1.5] as const;
const MAX_PAUSE_RANGE = [100, 1000] as const;
const EMO_WEIGHT_RANGE = [0, 1] as const;

function parseTtsTuning(id: string, fields: ReadonlyMap<string, string>): TtsTuning {
  const number = (key: string, [min, max]: readonly [number, number], integer: boolean): number | undefined => {
    const raw = fields.get(key);
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      const kind = integer ? 'an integer' : 'a number';
      throw new Error(`Character "${id}" has \`${key}: ${raw}\`; expected ${kind} in [${min}, ${max}]`);
    }
    return value;
  };
  const maxPauseMs = number('tts_max_pause_ms', MAX_PAUSE_RANGE, true);
  const emoWeight = number('tts_emo_weight', EMO_WEIGHT_RANGE, false);
  return {
    speed: number('tts_speed', SPEED_RANGE, false) ?? 1,
    ...(maxPauseMs !== undefined && { maxPauseMs }),
    ...(emoWeight !== undefined && { emoWeight }),
  };
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/**
 * `---\nname: …\ndescription: …\nvoice: …\n[tts_speed: …]\n[tts_max_pause_ms: …]\n[tts_emo_weight: …]\n---\n<persona>`;
 * only flat `key: value` lines are supported.
 */
export function parseCharacterFile(id: string, text: string, rules: string): Character {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = FRONT_MATTER.exec(normalized);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split('\n') ?? []) {
    const sep = line.indexOf(':');
    if (sep > 0) fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  const name = fields.get('name');
  if (!name) throw new Error(`Character "${id}" has no \`name:\` in its front matter`);
  const voice = fields.get('voice');
  if (!voice) throw new Error(`Character "${id}" has no \`voice:\` in its front matter`);
  const tts = parseTtsTuning(id, fields);
  const persona = normalized.slice(match?.[0].length ?? 0).trim();
  if (!persona) throw new Error(`Character "${id}" has an empty persona`);
  const shared = rules.replace(/\r\n/g, '\n').trim();
  return {
    id,
    name,
    description: fields.get('description') ?? '',
    voice,
    tts,
    instructions: shared ? `${persona}\n\n${shared}` : persona,
  };
}

/**
 * Reads every `<id>.md` in `dir` plus the shared `_rules.md`. Read per call, so editing a
 * prompt takes effect on the next call without restarting anything.
 */
export function loadCharacters(dir: string, defaultId: string): CharacterCatalog {
  const rules = readFileSync(join(dir, RULES_FILE), 'utf8');
  const characters = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((f) => parseCharacterFile(f.slice(0, -'.md'.length), readFileSync(join(dir, f), 'utf8'), rules));
  return new CharacterCatalog(characters, defaultId);
}

export function summarize({ id, name, description }: Character): CharacterSummary {
  return { id, name, description };
}

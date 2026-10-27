/**
 * Checks the character files the way the agent and token server load them, without printing their
 * content: every `<id>.md` must parse, and DEFAULT_CHARACTER must exist for TTS_BACKEND.
 *
 *   pnpm --filter @ptoy/agent check:characters                    # values from apps/agent/.env
 *   pnpm --filter @ptoy/agent check:characters -- --env hk        # values from .env.hk
 *   pnpm --filter @ptoy/agent check:characters -- --dir prompts/characters   # another directory
 *
 * CHARACTERS_DIR, DEFAULT_CHARACTER, TTS_BACKEND and LLM_SHARED_RULES come from the environment;
 * `--dir` overrides CHARACTERS_DIR (the HK deploy checks the new checkout before syncing it).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCharacters, parseCharacterFile } from '../src/characters.js';
import { DEFAULT_CHARACTERS_DIR, TTS_BACKENDS, type TtsBackendName } from '../src/config.js';

const { values } = parseArgs({ options: { dir: { type: 'string' } } });
const dir = resolve(values.dir ?? process.env.CHARACTERS_DIR ?? DEFAULT_CHARACTERS_DIR);
const defaultId = process.env.DEFAULT_CHARACTER || 'xiaoyou';
const backend = (process.env.TTS_BACKEND || 'gradio') as TtsBackendName;
const sharedRules = !['false', '0'].includes(process.env.LLM_SHARED_RULES ?? 'true');

if (!(TTS_BACKENDS as readonly string[]).includes(backend)) {
  console.error(`TTS_BACKEND "${backend}" is not one of ${TTS_BACKENDS.join(', ')}`);
  process.exit(1);
}

const failures: string[] = [];
const rules = sharedRules ? readFileSync(join(dir, '_rules.md'), 'utf8') : '';
for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort()) {
  try {
    parseCharacterFile(file.slice(0, -'.md'.length), readFileSync(join(dir, file), 'utf8'), rules);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
if (failures.length === 0) {
  try {
    const catalog = loadCharacters(dir, defaultId, { sharedRules, ttsBackend: backend });
    console.log(`ok: ${dir}`);
    console.log(`  ${backend}, default ${catalog.defaultCharacter.id}: ${catalog.characters.map((c) => c.id).join(', ')}`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

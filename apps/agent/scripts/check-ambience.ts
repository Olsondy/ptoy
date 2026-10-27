/**
 * Checks an ambience directory the way the agent loads it per call (ADR 0013): manifest.json plus
 * every loop it names, 48 kHz mono 16-bit WAV of at least 1 s. Convert sources with
 * services/ambience/convert.py first.
 *
 *   pnpm --filter @ptoy/agent check:ambience -- <dir>     # default: AMBIENCE_DIR from .env
 */
import { resolve } from 'node:path';
import { loadAmbience } from '../src/ambience/manifest.js';

const arg = process.argv.slice(2).find((a) => a !== '--');
const dir = arg ?? process.env.AMBIENCE_DIR;
if (!dir) {
  console.error('usage: check:ambience -- <dir> (or set AMBIENCE_DIR)');
  process.exit(1);
}
try {
  const ambience = loadAmbience(resolve(process.env.INIT_CWD ?? process.cwd(), dir));
  console.log(`ok: ${resolve(process.env.INIT_CWD ?? process.cwd(), dir)}`);
  console.log(`  ${ambience.levels.map((l) => l.id + (l.loop ? '' : ' (silent)')).join(', ')}`);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

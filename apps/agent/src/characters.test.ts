import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHARACTERS_DIR } from './config.js';
import { loadCharacters, parseCharacterFile } from './characters.js';

describe('parseCharacterFile', () => {
  it('reads name and description from the front matter and appends the shared rules', () => {
    const c = parseCharacterFile('a', '---\nname: 小悠\ndescription: 老朋友\n---\n你叫小悠。\n', '通话规则');
    expect(c).toEqual({ id: 'a', name: '小悠', description: '老朋友', instructions: '你叫小悠。\n\n通话规则' });
  });

  it('accepts CRLF files (edited on Windows)', () => {
    const c = parseCharacterFile('a', '---\r\nname: 小悠\r\n---\r\n你叫小悠。\r\n', 'R');
    expect(c.name).toBe('小悠');
    expect(c.description).toBe('');
    expect(c.instructions).toBe('你叫小悠。\n\nR');
  });

  it('rejects a file without a name or without a persona', () => {
    expect(() => parseCharacterFile('a', '你叫小悠。', 'R')).toThrow(/name/);
    expect(() => parseCharacterFile('a', '---\nname: 小悠\n---\n  \n', 'R')).toThrow(/empty/);
  });
});

describe('loadCharacters', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'characters-'));
    writeFileSync(join(dir, '_rules.md'), '规则');
    writeFileSync(join(dir, 'b.md'), '---\nname: B\n---\n我是 B。');
    writeFileSync(join(dir, 'a.md'), '---\nname: A\n---\n我是 A。');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every .md except the _-prefixed rules, default first', () => {
    const catalog = loadCharacters(dir, 'b');
    expect(catalog.characters.map((c) => c.id)).toEqual(['b', 'a']);
    expect(catalog.defaultCharacter.instructions).toBe('我是 B。\n\n规则');
  });

  it('resolves unknown or missing ids to the default', () => {
    const catalog = loadCharacters(dir, 'a');
    expect(catalog.get('b')?.name).toBe('B');
    expect(catalog.get('nope')).toBeUndefined();
    expect(catalog.resolve(undefined).id).toBe('a');
    expect(catalog.resolve('nope').id).toBe('a');
  });

  it('fails when the default character does not exist', () => {
    expect(() => loadCharacters(dir, 'c')).toThrow(/DEFAULT_CHARACTER "c"/);
  });

  it('loads the characters shipped with the agent', () => {
    const catalog = loadCharacters(DEFAULT_CHARACTERS_DIR, 'xiaoyou');
    expect(catalog.characters.length).toBeGreaterThanOrEqual(2);
    for (const c of catalog.characters) expect(c.instructions).toContain('情绪标签');
  });
});

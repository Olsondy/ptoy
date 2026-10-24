import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHARACTERS_DIR } from './config.js';
import { loadCharacters, parseCharacterFile } from './characters.js';

describe('parseCharacterFile', () => {
  it('reads name and description from the front matter and appends the shared rules', () => {
    const c = parseCharacterFile('a', '---\nname: 小悠\ndescription: 老朋友\nvoice: chunqing\n---\n你叫小悠。\n', '通话规则');
    expect(c).toEqual({
      id: 'a',
      name: '小悠',
      description: '老朋友',
      voice: 'chunqing',
      tts: { speed: 1 },
      ttsBackends: ['gradio', 'fastapi'],
      instructions: '你叫小悠。\n\n通话规则',
    });
  });

  it('reads the optional TTS tuning and rejects values out of range', () => {
    const file = (extra: string) => `---\nname: 小悠\nvoice: v\n${extra}\n---\n你叫小悠。`;
    expect(parseCharacterFile('a', file('tts_speed: 1.06\ntts_max_pause_ms: 300\ntts_emo_weight: 0.3\ntts_style: 轻声耳语'), 'R').tts).toEqual({
      speed: 1.06,
      maxPauseMs: 300,
      emoWeight: 0.3,
      style: '轻声耳语',
    });
    const bads = ['tts_speed: 快', 'tts_speed: 1.6', 'tts_max_pause_ms: 30', 'tts_max_pause_ms: 250.5', 'tts_emo_weight: 2'];
    for (const bad of bads) {
      expect(() => parseCharacterFile('x', file(bad), 'R'), bad).toThrow(new RegExp(`"x".*${bad.split(':')[0]}`));
    }
  });

  it('accepts CRLF files (edited on Windows)', () => {
    const c = parseCharacterFile('a', '---\r\nname: 小悠\r\nvoice: v\r\n---\r\n你叫小悠。\r\n', 'R');
    expect(c.name).toBe('小悠');
    expect(c.description).toBe('');
    expect(c.instructions).toBe('你叫小悠。\n\nR');
  });

  it('rejects a file without a name, a voice or a persona', () => {
    expect(() => parseCharacterFile('a', '你叫小悠。', 'R')).toThrow(/name/);
    expect(() => parseCharacterFile('a', '---\nname: 小悠\n---\n你叫小悠。', 'R')).toThrow(/voice/);
    expect(() => parseCharacterFile('a', '---\nname: 小悠\nvoice: v\n---\n  \n', 'R')).toThrow(/empty/);
  });
});

describe('loadCharacters', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'characters-'));
    writeFileSync(join(dir, '_rules.md'), '规则');
    writeFileSync(join(dir, 'b.md'), '---\nname: B\nvoice: v\n---\n我是 B。');
    writeFileSync(join(dir, 'a.md'), '---\nname: A\nvoice: v\n---\n我是 A。');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every .md except the _-prefixed rules, default first', () => {
    const catalog = loadCharacters(dir, 'b');
    expect(catalog.characters.map((c) => c.id)).toEqual(['b', 'a']);
    expect(catalog.defaultCharacter.instructions).toBe('我是 B。\n\n规则');
  });

  it('leaves the shared rules out when they are off', () => {
    expect(loadCharacters(dir, 'b', { sharedRules: false }).defaultCharacter.instructions).toBe('我是 B。');
  });

  it('resolves unknown or missing ids to the default', () => {
    const catalog = loadCharacters(dir, 'a');
    expect(catalog.get('b')?.name).toBe('B');
    expect(catalog.get('nope')).toBeUndefined();
    expect(catalog.resolve(undefined).id).toBe('a');
    expect(catalog.resolve('nope').id).toBe('a');
  });

  it('keeps only the characters made for the TTS backend (default: the IndexTTS ones)', () => {
    writeFileSync(join(dir, 'f.md'), '---\nname: F\nvoice: v\ntts_backends: openrouter\n---\n我是 F。');
    const ids = (backend?: 'fastapi' | 'openrouter') =>
      loadCharacters(dir, backend === 'openrouter' ? 'f' : 'a', { ttsBackend: backend }).characters.map((c) => c.id);
    expect(ids('fastapi')).toEqual(['a', 'b']);
    expect(ids('openrouter')).toEqual(['f']);
    expect(ids(undefined)).toEqual(['a', 'b', 'f']);
    expect(() => loadCharacters(dir, 'a', { ttsBackend: 'openrouter' })).toThrow(/not made for this TTS_BACKEND/);
    expect(() => parseCharacterFile('x', '---\nname: X\nvoice: v\ntts_backends: fish\n---\n我。', 'R')).toThrow(/tts_backends/);
  });

  it('fails when the default character does not exist', () => {
    expect(() => loadCharacters(dir, 'c')).toThrow(/DEFAULT_CHARACTER "c"/);
  });

  it('loads the characters shipped with the agent', () => {
    const catalog = loadCharacters(DEFAULT_CHARACTERS_DIR, 'xiaoyou');
    expect(catalog.characters.length).toBeGreaterThanOrEqual(2);
    for (const c of catalog.characters) expect(c.instructions).toContain('情绪标签');
  });

  it('ships the TTS tuning ADR 0009 picked for each character', () => {
    const tuning = Object.fromEntries(
      loadCharacters(DEFAULT_CHARACTERS_DIR, 'xiaoyou').characters.map((c) => [c.id, c.tts]),
    );
    expect(tuning).toEqual({
      linqian: { speed: 1.5, maxPauseMs: 300 },
      rouyi: { speed: 1, style: '亲密中文耳语，轻声性感' },
      xiaoyou: { speed: 1.06, maxPauseMs: 300 },
      zhixia: { speed: 1.12, maxPauseMs: 300 },
      zhixin: { speed: 1.1, maxPauseMs: 300, emoWeight: 0.3 },
    });
  });
});

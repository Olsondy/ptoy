import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { loadCharacters } from '../characters.js';
import { DEFAULT_CHARACTERS_DIR, DEFAULT_FILLERS_DIR } from '../config.js';
import { type Filler, FillerBank, fillerAudio, fillerManifestPath, loadFillerBank } from './bank.js';

describe('loadFillerBank', () => {
  it('ships a filler set for every shipped character voice', () => {
    for (const c of loadCharacters(DEFAULT_CHARACTERS_DIR, 'xiaoyou').characters) {
      expect(existsSync(fillerManifestPath(DEFAULT_FILLERS_DIR, c.voice)), `${c.id} → ${c.voice}`).toBe(true);
    }
  });

  it('loads every filler of the shipped manifest at the agent track rate', async () => {
    const bank = await loadFillerBank(fillerManifestPath(DEFAULT_FILLERS_DIR, 'chunqing'), 24000);
    expect(bank.fillers.length).toBeGreaterThanOrEqual(6);
    expect(new Set(bank.fillers.map((f) => f.group))).toEqual(new Set(['thinking', 'ack', 'empathy']));
    for (const f of bank.fillers) {
      expect(f.frames.every((fr) => fr.sampleRate === 24000 && fr.channels === 1)).toBe(true);
      expect(f.durationMs).toBeGreaterThan(200);
    }
    let frames = 0;
    for await (const _ of fillerAudio(bank.fillers[0]!)) frames++;
    expect(frames).toBe(bank.fillers[0]!.frames.length);
  });

  it('rejects a missing manifest', async () => {
    await expect(loadFillerBank('/nonexistent/manifest.json', 24000)).rejects.toThrow(/Invalid filler manifest/);
  });
});

describe('FillerBank.next', () => {
  const filler = (id: string, group: Filler['group']): Filler => ({ id, group, text: id, durationMs: 500, frames: [] });
  const fillers = [filler('t1', 'thinking'), filler('t2', 'thinking'), filler('a1', 'ack'), filler('a2', 'ack')];
  const question = '你最喜欢的电影是什么？';
  const statement = '我刚下班。';

  it('skips a plain acknowledgement by chance, never a real question', () => {
    const bank = new FillerBank(fillers, () => 0.7);
    expect(bank.next(statement)).toBeUndefined();
    expect(bank.next(question)?.group).toBe('thinking');
  });

  it('halves the chance of a group that played on the turn before', () => {
    const bank = new FillerBank(fillers, () => 0.7);
    expect(bank.next(question)).toBeDefined();
    expect(bank.next(question)).toBeUndefined();
    expect(bank.next(question)).toBeDefined();
  });

  it('plays every turn with always', () => {
    const bank = new FillerBank(fillers, () => 0.99, true);
    expect([statement, statement, question, question].map((t) => bank.next(t)?.id).every(Boolean)).toBe(true);
  });
});

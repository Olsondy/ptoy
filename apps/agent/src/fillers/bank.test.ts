import { describe, expect, it } from 'vitest';
import { DEFAULT_FILLERS_MANIFEST } from '../config.js';
import { fillerAudio, loadFillerBank } from './bank.js';

describe('loadFillerBank', () => {
  it('loads every filler of the shipped manifest at the agent track rate', async () => {
    const bank = await loadFillerBank(DEFAULT_FILLERS_MANIFEST, 24000);
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

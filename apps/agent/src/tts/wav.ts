import type { PcmAudio } from './backend.js';

/**
 * Decodes a RIFF/WAVE file to interleaved s16 PCM.
 * Supports PCM 16-bit and IEEE float 32-bit (IndexTTS writes 16-bit mono 22.05 kHz).
 * Throws a plain `Error` on anything else; callers wrap it.
 */
export function decodeWav(input: Uint8Array): PcmAudio {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const tag = (offset: number) => String.fromCharCode(...input.subarray(offset, offset + 4));
  if (input.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let offset = 12;
  while (offset + 8 <= input.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let audioFormat = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first 2 bytes of the sub-format GUID.
      if (audioFormat === 0xfffe && size >= 26) audioFormat = view.getUint16(body + 24, true);
      format = {
        audioFormat,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('wav data chunk before fmt chunk');
      // Some writers leave the size at 0 / 0xffffffff when streaming; clamp to what is there.
      const end = Math.min(body + size, input.byteLength);
      return { ...decodeSamples(view, body, end, format), sampleRate: format.sampleRate, channels: format.channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('wav has no data chunk');
}

function decodeSamples(
  view: DataView,
  start: number,
  end: number,
  f: { audioFormat: number; channels: number; bitsPerSample: number },
): { samples: Int16Array } {
  if (f.channels < 1) throw new Error('wav has no channels');
  if (f.audioFormat === 1 && f.bitsPerSample === 16) {
    const n = Math.floor((end - start) / 2);
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = view.getInt16(start + i * 2, true);
    return { samples };
  }
  if (f.audioFormat === 3 && f.bitsPerSample === 32) {
    const n = Math.floor((end - start) / 4);
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, view.getFloat32(start + i * 4, true)));
      samples[i] = Math.round(v * 32767);
    }
    return { samples };
  }
  throw new Error(`unsupported wav encoding (format ${f.audioFormat}, ${f.bitsPerSample}-bit)`);
}

/** Encodes interleaved s16 PCM as a 16-bit PCM wav (used by fakes and fixtures). */
export function encodeWav(audio: PcmAudio): Uint8Array {
  const dataBytes = audio.samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, audio.channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * audio.channels * 2, true);
  view.setUint16(32, audio.channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < audio.samples.length; i++) view.setInt16(44 + i * 2, audio.samples[i] ?? 0, true);
  return out;
}

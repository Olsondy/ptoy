import type { TtsConfig } from '../config.js';
import type { TtsBackend } from './backend.js';
import { IndexTtsGradioBackend } from './gradio.js';

export { type PcmAudio, type TtsBackend, TtsError, type TtsErrorKind, type TtsSegment } from './backend.js';
export { IndexTTS } from './plugin.js';

/** Picks the TTS backend from config (`TTS_BACKEND`). #14 adds `fastapi` here. */
export function createTtsBackend(config: TtsConfig): TtsBackend {
  switch (config.backend) {
    case 'gradio':
      return new IndexTtsGradioBackend({
        url: config.url,
        refAudioPath: config.refAudioPath,
        language: config.language,
        emotionControl: config.emotionControl,
        timeoutMs: config.timeoutMs,
      });
  }
}

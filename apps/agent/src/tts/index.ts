import type { TtsConfig } from '../config.js';
import type { TtsBackend } from './backend.js';
import { IndexTtsFastApiBackend } from './fastapi.js';
import { IndexTtsGradioBackend } from './gradio.js';

export { type PcmAudio, type TtsBackend, TtsError, type TtsErrorKind, type TtsSegment } from './backend.js';
export { IndexTTS } from './plugin.js';

/**
 * Picks the TTS backend from config (`TTS_BACKEND`). `voice` (the character's) selects the speaker
 * reference on the FastAPI service; the Gradio backend always uploads `TTS_REF_AUDIO`.
 */
export function createTtsBackend(config: TtsConfig, voice?: string): TtsBackend {
  switch (config.backend) {
    case 'gradio':
      return new IndexTtsGradioBackend({
        url: config.url,
        refAudioPath: config.refAudioPath,
        language: config.language,
        emotionControl: config.emotionControl,
        emotionWeight: config.emotionWeight,
        timeoutMs: config.timeoutMs,
      });
    case 'fastapi':
      return new IndexTtsFastApiBackend({
        url: config.url,
        voice,
        emotionControl: config.emotionControl,
        emotionWeight: config.emotionWeight,
        timeoutMs: config.timeoutMs,
      });
  }
}

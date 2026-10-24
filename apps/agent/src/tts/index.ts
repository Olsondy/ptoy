import type { TtsTuning } from '../characters.js';
import type { TtsConfig } from '../config.js';
import type { TtsBackend } from './backend.js';
import { IndexTtsFastApiBackend } from './fastapi.js';
import { IndexTtsGradioBackend } from './gradio.js';

export { type PcmAudio, type TtsBackend, TtsError, type TtsErrorKind, type TtsSegment } from './backend.js';
export { IndexTTS } from './plugin.js';

/**
 * Picks the TTS backend from config (`TTS_BACKEND`). `voice` and `tuning` (the character's) select the
 * speaker reference, speaking rate / pauses and emotion strength on the FastAPI service; the Gradio
 * backend always uploads `TTS_REF_AUDIO` and only takes the emotion strength.
 */
export function createTtsBackend(config: TtsConfig, voice?: string, tuning?: TtsTuning): TtsBackend {
  switch (config.backend) {
    case 'gradio':
      return new IndexTtsGradioBackend({
        url: config.url,
        refAudioPath: config.refAudioPath,
        language: config.language,
        emotionControl: config.emotionControl,
        emotionWeight: tuning?.emoWeight ?? config.emotionWeight,
        timeoutMs: config.timeoutMs,
      });
    case 'fastapi':
      return new IndexTtsFastApiBackend({
        url: config.url,
        voice,
        speed: tuning?.speed,
        maxPauseMs: tuning?.maxPauseMs,
        emotionControl: config.emotionControl,
        emotionWeight: tuning?.emoWeight ?? config.emotionWeight,
        timeoutMs: config.timeoutMs,
      });
  }
}

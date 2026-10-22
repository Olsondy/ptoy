export {
  DEFAULT_EMOTION,
  EMOTION_VECTOR_INDEX,
  EMOTIONS,
  emotionVector,
  isEmotion,
  type Emotion,
} from "./emotion.ts";
export {
  createSegmenter,
  DEFAULT_OPTIONS,
  type Segment,
  type Segmenter,
  type SegmenterOptions,
} from "./segmenter.ts";
export { segmentStream } from "./stream.ts";

import { type APIConnectOptions, USERDATA_TIMED_TRANSCRIPT, createTimedString, tts } from '@livekit/agents';
import { type Segment, type SegmenterOptions, createSegmenter } from '@ptoy/segmenter';
import type { TtsSegment } from './backend.js';

/** What the stream needs from the plugin: one clip per segment (`IndexTTS.synthesizeSegment`). */
export interface SegmentSynthesizer extends tts.TTS {
  synthesizeSegment(segment: TtsSegment, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream;
}

const ASCII_END = /[A-Za-z0-9,.!?;:'")]$/;
const ASCII_START = /^[A-Za-z0-9]/;

/**
 * LLM text stream → `@ptoy/segmenter` → one synthesis per segment.
 *
 * The segmenter is the single place where the reply is cut and its `[情绪]` tags are parsed and
 * removed: the short first segment (first comma, docs/architecture/server.md §8) goes to TTS as
 * soon as it is complete, later ones per sentence. Each segment's clean text is attached to its
 * first audio frame as a timed transcript (start = audio already emitted), which is what the
 * subtitles and the committed history message are built from — so neither ever sees a tag.
 *
 * Same scheduling as the framework's `StreamAdapterWrapper`: every segment's request is issued
 * immediately (the plugin serializes them on the GPU), audio is queued in segment order.
 * A failed segment is skipped (its error is reported by the plugin as a `tts_error`).
 */
export class SegmentedSynthesizeStream extends tts.SynthesizeStream {
  label = 'ptoy.SegmentedSynthesizeStream';
  protected override emitMetrics = false;
  readonly #tts: SegmentSynthesizer;
  readonly #segmenterOptions: SegmenterOptions | undefined;
  readonly #onAmbience: ((level: string) => void) | undefined;
  #segmentError: Error | undefined;

  constructor(
    synth: SegmentSynthesizer,
    segmenterOptions?: SegmenterOptions,
    connOptions?: APIConnectOptions,
    onAmbience?: (level: string) => void,
  ) {
    super(synth, connOptions);
    this.#tts = synth;
    this.#segmenterOptions = segmenterOptions;
    this.#onAmbience = onAmbience;
  }

  override get error(): Error | undefined {
    return super.error ?? this.#segmentError;
  }

  protected async run(): Promise<void> {
    const segmenter = createSegmenter(this.#segmenterOptions);
    const signal = this.abortController.signal;
    let audioSeconds = 0;
    let previousText = '';
    let previous: Promise<void> = Promise.resolve();
    const pending: Promise<void>[] = [];
    let ambienceReported = false;

    const synthesize = async (segment: Segment, after: Promise<void>) => {
      this.markStarted();
      const audio = this.#tts.synthesizeSegment(segment, this.connOptions, this.abortSignal);
      await after;
      if (signal.aborted) {
        audio.close();
        return;
      }
      const spacer = ASCII_END.test(previousText) && ASCII_START.test(segment.text) ? ' ' : '';
      previousText = segment.text;
      const timed = createTimedString({ text: spacer + segment.text, startTime: audioSeconds });
      let first = true;
      for await (const ev of audio) {
        if (signal.aborted) break;
        if (first) {
          ev.frame.userdata[USERDATA_TIMED_TRANSCRIPT] = [timed];
          first = false;
        }
        audioSeconds += ev.frame.samplesPerChannel / ev.frame.sampleRate;
        this.queue.put(ev);
      }
      this.#segmentError ??= audio.error;
    };

    const enqueue = (segments: Segment[]) => {
      for (const segment of segments) {
        // The reply's first `<bg:…>` level, reported once (ADR 0013).
        if (!ambienceReported && segment.ambience !== undefined) {
          ambienceReported = true;
          this.#onAmbience?.(segment.ambience);
        }
        const task = synthesize(segment, previous);
        // Keep ordering even if a segment fails; the failure itself surfaces via the plugin.
        previous = task.catch(() => undefined);
        pending.push(previous);
      }
    };

    for await (const input of this.input) {
      if (signal.aborted) break;
      enqueue(input === tts.SynthesizeStream.FLUSH_SENTINEL ? segmenter.end() : segmenter.push(input));
    }
    if (signal.aborted) {
      segmenter.reset();
    } else {
      enqueue(segmenter.end());
    }
    await Promise.all(pending);
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

import { encodeWav } from '../../src/tts/wav.js';
import { type FakeRequest, type FakeServer, json, sleep, startFakeServer } from './http.js';

/** Parameter list shaped like the real IndexTTS WebUI `/gen_single` (`/gradio_api/info`). */
export const GEN_SINGLE_PARAMETERS = [
  { parameter_name: 'emo_control_method', parameter_has_default: true, parameter_default: '与音色参考音频相同' },
  { parameter_name: 'prompt', parameter_has_default: true, parameter_default: { path: 'C:\\default.wav' } },
  { parameter_name: 'text', parameter_has_default: false, parameter_default: null },
  { parameter_name: 'lang_choice', parameter_has_default: true, parameter_default: 'ZH' },
  { parameter_name: 'emo_ref_path', parameter_has_default: false, parameter_default: null },
  { parameter_name: 'emo_weight', parameter_has_default: true, parameter_default: 0.65 },
  ...Array.from({ length: 8 }, (_, i) => ({
    parameter_name: `vec${i + 1}`,
    parameter_has_default: true,
    parameter_default: 0,
  })),
  { parameter_name: 'max_text_tokens_per_segment', parameter_has_default: true, parameter_default: 80 },
  { parameter_name: 'param_18', parameter_has_default: true, parameter_default: true },
] as const;

export const FAKE_SAMPLE_RATE = 22050;
/** Fake audio length per input character. */
export const FAKE_MS_PER_CHAR = 100;

export interface FakeGradioOptions {
  /** Delay before the SSE result (simulated synthesis time). */
  readonly synthMs?: number;
  /** `error`: SSE error event; `http500`: the call POST fails; `garbage`: result file is not a wav. */
  readonly fail?: () => 'error' | 'http500' | 'garbage' | undefined;
  readonly port?: number;
}

export interface FakeGradio extends FakeServer {
  /** Named view of every `/call/gen_single` request's `data`. */
  readonly calls: Record<string, unknown>[];
  readonly uploads: number;
  /** Highest number of syntheses in flight at once. */
  readonly maxConcurrent: number;
}

/** 440 Hz tone, FAKE_MS_PER_CHAR per character of `text`, 16-bit mono 22.05 kHz like IndexTTS. */
export function fakeSpeech(text: string): Uint8Array {
  const n = Math.round((FAKE_SAMPLE_RATE * FAKE_MS_PER_CHAR * [...text].length) / 1000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / FAKE_SAMPLE_RATE) * 6000);
  return encodeWav({ samples, sampleRate: FAKE_SAMPLE_RATE, channels: 1 });
}

/** Implements the slice of the Gradio 5 REST API that the IndexTTS backend uses. */
export async function startFakeGradio(opts: FakeGradioOptions = {}): Promise<FakeGradio> {
  const calls: Record<string, unknown>[] = [];
  const pending = new Map<string, { text: string; failure: ReturnType<NonNullable<FakeGradioOptions['fail']>> }>();
  const files = new Map<string, Uint8Array>();
  let uploads = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  let nextId = 0;

  const server = await startFakeServer(async (req: FakeRequest, res) => {
    const url = decodeURIComponent(req.url);
    if (req.method === 'GET' && url === '/gradio_api/info') {
      json(res, 200, { named_endpoints: { '/gen_single': { parameters: GEN_SINGLE_PARAMETERS } } });
    } else if (req.method === 'POST' && url === '/gradio_api/upload') {
      uploads++;
      json(res, 200, ['C:\\gradio\\tmp\\ref.wav']);
    } else if (req.method === 'POST' && url === '/gradio_api/call/gen_single') {
      const failure = opts.fail?.();
      if (failure === 'http500') {
        json(res, 500, { error: 'boom' });
        return;
      }
      const { data } = JSON.parse(req.body.toString()) as { data: unknown[] };
      const named = Object.fromEntries(GEN_SINGLE_PARAMETERS.map((p, i) => [p.parameter_name, data[i]]));
      calls.push(named);
      const id = `ev${nextId++}`;
      pending.set(id, { text: String(named.text), failure });
      json(res, 200, { event_id: id });
    } else if (req.method === 'GET' && url.startsWith('/gradio_api/call/gen_single/')) {
      const job = pending.get(url.split('/').pop() ?? '');
      if (!job) return json(res, 404, { detail: 'unknown event' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        await sleep(opts.synthMs ?? 20);
      } finally {
        inFlight--;
      }
      if (job.failure === 'error') {
        res.end('event: error\ndata: null\n\n');
        return;
      }
      const path = `C:\\gradio\\out\\spk_${files.size}.wav`;
      files.set(path, job.failure === 'garbage' ? new TextEncoder().encode('not a wav') : fakeSpeech(job.text));
      const value = { path, url: `http://unreachable.invalid/gradio_api/file=${path}`, meta: { _type: 'gradio.FileData' } };
      res.end(`event: generating\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([{ visible: true, value, __type__: 'update' }])}\n\n`);
    } else if (req.method === 'GET' && url.startsWith('/gradio_api/file=')) {
      const file = files.get(url.slice('/gradio_api/file='.length));
      if (!file) return json(res, 404, { detail: 'no such file' });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(file);
    } else {
      json(res, 404, { detail: 'not found' });
    }
  }, opts.port);

  return {
    ...server,
    calls,
    get uploads() {
      return uploads;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

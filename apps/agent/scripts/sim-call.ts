/**
 * Simulated phone call against the real agent worker: a scripted caller joins a LiveKit room,
 * speaks each turn (macOS `say` voice, 48 kHz mono), and records what the agent sends back
 * (audio, `lk.transcription` text, `ptoy.agent_error`) plus the agent's `turn timing` log lines.
 *
 *   pnpm --filter @ptoy/agent sim:call -- --fake asr,llm,tts --turns "你好|你叫什么名字"
 *   pnpm --filter @ptoy/agent sim:call -- --turns "你好|今天天气怎么样|..."   # real services from .env
 *
 * Options:
 *   --turns "a|b|c"        what the caller says, one turn each (default: 3 short questions)
 *   --fake asr,llm,tts     replace those services with in-process fakes (test/fakes)
 *   --fail llm|tts         with the corresponding fake: every request fails
 *   --voice Ting-Ting      macOS `say` voice
 * Env: LIVEKIT_SERVER_BIN starts a throwaway livekit-server --dev on :7900; otherwise LIVEKIT_URL
 * (+ key/secret) must point at a running server. The rest comes from apps/agent/.env.
 * Exits non-zero if a turn got no agent audio (unless --fail is given).
 */
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import type { RemoteParticipant, RemoteTrack } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startFakeAsr } from '../test/fakes/asr.js';
import { startFakeGradio } from '../test/fakes/gradio.js';
import type { FakeServer } from '../test/fakes/http.js';
import { startFakeOpenAI } from '../test/fakes/openai.js';
import { decodeWav, encodeWav } from '../src/tts/wav.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { values } = parseArgs({
  options: {
    turns: { type: 'string', default: '你好，你是谁？|你平时喜欢做什么？|那我们周末一起去爬山好不好？' },
    fake: { type: 'string', default: '' },
    fail: { type: 'string' },
    voice: { type: 'string', default: 'Ting-Ting' },
    'turn-timeout': { type: 'string', default: '30000' },
  },
});
const turns = values.turns.split('|').map((t) => t.trim()).filter(Boolean);
const fakes = new Set(values.fake.split(',').map((s) => s.trim()).filter(Boolean));
const turnTimeoutMs = Number(values['turn-timeout']);
const agentDir = fileURLToPath(new URL('..', import.meta.url));

const SAMPLE_RATE = 48000;
const FRAME = SAMPLE_RATE / 100; // 10 ms
const cleanups: (() => Promise<void> | void)[] = [];

async function main(): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_PIPELINE: 'conversation', LIVEKIT_AGENT_NAME: '' };
  const scratch = mkdtempSync(join(tmpdir(), 'ptoy-sim-'));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));

  // ---- services ----
  const servers: FakeServer[] = [];
  if (fakes.has('asr')) {
    const asr = await startFakeAsr(turns);
    servers.push(asr);
    env.ASR_URL = asr.url;
  }
  if (fakes.has('llm')) {
    const llm = await startFakeOpenAI({
      fail: values.fail === 'llm' ? () => 'status' : undefined,
      reply: (body) => {
        const messages = body.messages as { role: string; content: string }[];
        const last = messages.at(-1)?.content ?? '';
        if (messages.some((m) => m.content.includes('\uFEFF'))) return ['历史里混进了字幕分隔符。'];
        return ['[喜]', '收到', '，你说的是', `“${last}”。`, '还想', '聊点', '什么？'];
      },
      tokenDelayMs: 20,
    });
    servers.push(llm);
    env.LLM_BASE_URL = llm.baseUrl;
  }
  if (fakes.has('tts')) {
    const tts = await startFakeGradio({ synthMs: 300, fail: values.fail === 'tts' ? () => 'error' : undefined });
    servers.push(tts);
    env.TTS_GRADIO_URL = tts.url;
    const ref = join(scratch, 'ref.wav');
    writeFileSync(ref, encodeWav({ samples: new Int16Array(22050), sampleRate: 22050, channels: 1 }));
    env.TTS_REF_AUDIO = ref;
  }
  cleanups.push(() => Promise.all(servers.map((s) => s.close())).then(() => undefined));

  // ---- LiveKit ----
  if (process.env.LIVEKIT_SERVER_BIN) {
    const lk = spawn(process.env.LIVEKIT_SERVER_BIN, ['--dev', '--bind', '127.0.0.1'], {
      env: { ...process.env, LIVEKIT_CONFIG: 'port: 7900\nrtc:\n  tcp_port: 7901\n  udp_port: 7902\n' },
      stdio: 'ignore',
    });
    cleanups.push(() => stopProcess(lk));
    env.LIVEKIT_URL = 'ws://127.0.0.1:7900';
    env.LIVEKIT_API_KEY = 'devkey';
    env.LIVEKIT_API_SECRET = 'secret';
    await waitHttp('http://127.0.0.1:7900');
  }
  const livekitUrl = env.LIVEKIT_URL ?? 'ws://localhost:7880';

  // ---- agent worker ----
  const timings: Record<string, unknown>[] = [];
  const agentLogs: string[] = [];
  const agent = spawn('pnpm', ['exec', 'tsx', 'src/agent.ts', 'start', '--log-level', 'info'], {
    cwd: agentDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => stopProcess(agent));
  let registered!: () => void;
  const ready = new Promise<void>((resolve) => {
    registered = resolve;
  });
  for (const stream of [agent.stdout, agent.stderr]) {
    createInterface({ input: stream! }).on('line', (line) => {
      agentLogs.push(line);
      if (/registered worker/i.test(line)) registered();
      try {
        const rec = JSON.parse(line) as { msg?: string; turn?: Record<string, unknown>; level?: number };
        if (rec.msg === 'turn timing' && rec.turn) timings.push(rec.turn);
        if (rec.level !== undefined && rec.level >= 50) out(`  [agent error] ${line.slice(0, 300)}`);
      } catch {
        // not JSON
      }
    });
  }
  await Promise.race([ready, sleep(60_000).then(() => Promise.reject(new Error('agent worker did not register')))]);

  // ---- caller ----
  const roomName = `sim-${Date.now()}`;
  const at = new AccessToken(env.LIVEKIT_API_KEY ?? 'devkey', env.LIVEKIT_API_SECRET ?? 'secret', { identity: 'sim-caller' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  const room = new Room();
  cleanups.push(() => room.disconnect());
  await room.connect(livekitUrl, await at.toJwt(), { autoSubscribe: true, dynacast: false });

  const source = new AudioSource(SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('mic', source);
  await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

  // Mic pump: speech when queued, otherwise silence, in real time.
  let speech: Int16Array[] = [];
  let speechDone: (() => void) | undefined;
  let pumping = true;
  const pump = (async () => {
    const silence = new Int16Array(FRAME);
    let next = performance.now();
    while (pumping) {
      const chunk = speech.shift();
      await source.captureFrame(new AudioFrame(chunk ?? silence, SAMPLE_RATE, 1, FRAME));
      if (!chunk && speechDone) {
        speechDone();
        speechDone = undefined;
      }
      next += 10;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
  })();
  cleanups.push(async () => {
    pumping = false;
    await pump;
  });

  // Agent side: audio energy, transcription, state + error attributes.
  let agentState = '';
  const state = () => agentState;
  let agentError = '';
  let lastAudioAt = 0;
  let firstAudioAt = 0;
  const agentText: string[] = [];
  let subtitleFirstAt = 0;
  let subtitleLastAt = 0;
  const watch = (p: RemoteParticipant) => {
    agentState = p.attributes['lk.agent.state'] ?? agentState;
    agentError = p.attributes['ptoy.agent_error'] ?? agentError;
  };
  room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
    if (p.identity === room.localParticipant?.identity) return;
    watch(p as RemoteParticipant);
  });
  room.on(RoomEvent.TrackSubscribed, (remote: RemoteTrack) => {
    if (remote.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      for await (const frame of new AudioStream(remote, { sampleRate: SAMPLE_RATE, numChannels: 1 })) {
        let peak = 0;
        for (const v of frame.data) peak = Math.max(peak, Math.abs(v));
        if (peak > 500) {
          lastAudioAt = Date.now();
          if (!firstAudioAt) firstAudioAt = lastAudioAt;
        }
      }
    })();
  });
  room.registerTextStreamHandler('lk.transcription', async (reader, info) => {
    if (info.identity === room.localParticipant?.identity) return;
    let text = '';
    for await (const chunk of reader) {
      const now = Date.now();
      if (chunk.trim()) {
        if (!subtitleFirstAt) subtitleFirstAt = now;
        subtitleLastAt = now;
      }
      text += chunk;
    }
    if (text.trim()) agentText.push(text.replaceAll('\uFEFF', ''));
  });

  // Wait for the agent to join and listen.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const p of room.remoteParticipants.values()) watch(p);
    if (agentState === 'listening') break;
    await sleep(100);
  }
  if (agentState !== 'listening') throw new Error(`agent never reached listening (state: ${agentState || 'none'})`);
  await sleep(1000);

  const results: {
    said: string;
    heard: string;
    clientLatencyMs?: number;
    audioMs: number;
    /** First / last subtitle text relative to first / last audible agent audio (sync check). */
    subtitleStartVsAudioMs?: number;
    subtitleEndVsAudioMs?: number;
    error: string;
  }[] = [];
  for (const [i, sentence] of turns.entries()) {
    const wav = join(scratch, `turn${i}.wav`);
    execFileSync('say', ['-v', values.voice, '-o', wav, `--data-format=LEI16@${SAMPLE_RATE}`, sentence]);
    const pcm = trimSilence(decodeWav(new Uint8Array(readFileSync(wav))).samples);
    firstAudioAt = 0;
    subtitleFirstAt = 0;
    subtitleLastAt = 0;
    agentText.length = 0;
    agentError = '';
    const frames: Int16Array[] = [];
    for (let o = 0; o + FRAME <= pcm.length; o += FRAME) frames.push(pcm.slice(o, o + FRAME));
    const spoken = new Promise<void>((resolve) => {
      speechDone = resolve;
    });
    speech = frames;
    await spoken;
    const stoppedAt = Date.now();

    // Wait for the reply to finish: audio started and then 1.5s of silence, or an error, or timeout.
    const until = stoppedAt + turnTimeoutMs;
    while (Date.now() < until) {
      if (firstAudioAt && state() !== 'speaking' && Date.now() - lastAudioAt > 1500) break;
      if (!firstAudioAt && agentError && state() === 'listening') break;
      await sleep(50);
    }
    await sleep(300);
    const heard = agentText.join(' / ');
    results.push({
      said: sentence,
      heard,
      clientLatencyMs: firstAudioAt ? firstAudioAt - stoppedAt : undefined,
      audioMs: firstAudioAt ? lastAudioAt - firstAudioAt : 0,
      subtitleStartVsAudioMs: firstAudioAt && subtitleFirstAt ? subtitleFirstAt - firstAudioAt : undefined,
      subtitleEndVsAudioMs: firstAudioAt && subtitleLastAt ? subtitleLastAt - lastAudioAt : undefined,
      error: agentError,
    });
    out(
      `turn ${i + 1}: said "${sentence}" → ${firstAudioAt ? `audio after ${firstAudioAt - stoppedAt}ms` : 'NO AUDIO'}` +
        `${heard ? `, subtitle "${heard}"` : ''}${agentError ? `, agent_error "${agentError}"` : ''}`,
    );
    await sleep(800);
  }

  await sleep(1000);
  out('\nagent turn timing logs:');
  for (const t of timings) out(`  ${JSON.stringify(t)}`);
  out('\nsummary:');
  out(JSON.stringify({ results, timings }, null, 2));
  const allAnswered = results.every((r) => r.clientLatencyMs !== undefined && r.heard);
  const expectFailure = Boolean(values.fail);
  const ok = expectFailure ? results.every((r) => r.error) : allAnswered;
  if (!ok) {
    out('\nFAILED — last agent log lines:');
    for (const l of agentLogs.slice(-40)) out(`  ${l.slice(0, 400)}`);
  }
  return ok ? 0 : 1;
}

/** Drops leading/trailing near-silence (say pads both ends), keeping 50 ms margins. */
function trimSilence(pcm: Int16Array): Int16Array {
  const loud = (v: number | undefined) => Math.abs(v ?? 0) > 300;
  let start = 0;
  while (start < pcm.length && !loud(pcm[start])) start++;
  let end = pcm.length;
  while (end > start && !loud(pcm[end - 1])) end--;
  const margin = SAMPLE_RATE / 20;
  return pcm.slice(Math.max(0, start - margin), Math.min(pcm.length, end + margin));
}

async function waitHttp(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`${url} did not come up`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** Runs cleanups last-registered first (caller → agent → LiveKit → fakes → temp files). */
async function cleanup(): Promise<void> {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });

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
 *   --emotions "neutral|angry|happy"
 *                          with the fake ASR: SenseVoice emotion of each turn (default neutral).
 *                          With the fake LLM, checks that each LLM request carries the turn's
 *                          `[用户语气:X]` (none for neutral) and only on the message being answered;
 *                          with the fake TTS too, that every segment got its tag's emotion vector.
 *   --voice Ting-Ting      macOS `say` voice
 *   --barge-in 200         the caller starts the last turn 200 ms after the agent audio of the
 *                          turn before started (during its filler at 200, inside the reply at
 *                          larger values). Needs ≥3 turns: the agent's first 3 s of speech are not
 *                          interruptible (AEC warm-up). Checks (see checkBargeIn): the agent audio
 *                          stops within --max-stop-ms of the caller's speech onset, nothing leaks
 *                          while the caller talks, and the next LLM request's history holds only
 *                          the part of the interrupted reply that was played. If the last turn is a
 *                          backchannel ("嗯", "对"), checks the reverse: the reply is not cut.
 *   --max-stop-ms 300      barge-in: caller speech onset → agent audio stopped (received audio)
 *   --tts-ms 300           fake TTS: synthesis time per segment (raise it to barge in while the
 *                          reply is still pending after the filler)
 *   --pause-ms 400         "~" in a turn is a pause of this length inside the caller's speech
 * Env: SIM_LOG_LEVEL=debug sets the agent's log level, SIM_DUMP=1 prints every agent log line.
 * LIVEKIT_SERVER_BIN starts a throwaway livekit-server --dev on :7900; otherwise LIVEKIT_URL
 * (+ key/secret) must point at a running server. The rest comes from apps/agent/.env.
 * Exits non-zero if a turn got no agent audio (unless --fail is given).
 */
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import type { RemoteParticipant, RemoteTrack } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type AddressInfo, createServer } from 'node:net';
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
import { isBackchannel } from '../src/pipelines/backchannel.js';
import { decodeWav, encodeWav } from '../src/tts/wav.js';
import { ASR_EMOTION_TONE, withTone } from '../src/emotion/user-tone.js';
import type { AsrEmotion } from '../src/stt/sensevoice.js';
import { EMOTIONS, type Emotion } from '@ptoy/segmenter';

const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { values } = parseArgs({
  // `pnpm sim:call -- --turns ...` forwards the `--` itself.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    turns: { type: 'string', default: '你好，你是谁？|你平时喜欢做什么？|那我们周末一起去爬山好不好？' },
    fake: { type: 'string', default: '' },
    fail: { type: 'string' },
    emotions: { type: 'string', default: '' },
    voice: { type: 'string', default: 'Ting-Ting' },
    'turn-timeout': { type: 'string', default: '30000' },
    'barge-in': { type: 'string' },
    'max-stop-ms': { type: 'string', default: '300' },
    'tts-ms': { type: 'string', default: '300' },
    'pause-ms': { type: 'string', default: '400' },
  },
});
/** What the caller says per turn; "~" marks a pause inside the turn. */
const turns = values.turns.split('|').map((t) => t.trim()).filter(Boolean);
/** The turn's text as the ASR returns it. */
const spokenText = (turn: string) => turn.replaceAll('~', '');
const fakes = new Set(values.fake.split(',').map((s) => s.trim()).filter(Boolean));
const turnEmotions = values.emotions.split('|').map((e) => e.trim().toLowerCase());
const turnTimeoutMs = Number(values['turn-timeout']);
const bargeInMs = values['barge-in'] === undefined ? undefined : Number(values['barge-in']);
/** Index of the turn the caller interrupts. */
const bargedTurn = bargeInMs === undefined ? -1 : turns.length - 2;
/** The caller's interrupting turn (the last one). */
const bargingTurn = bargeInMs === undefined ? -1 : turns.length - 1;
const bargesWithBackchannel = bargingTurn >= 0 && isBackchannel(spokenText(turns[bargingTurn] ?? ''));
const maxStopMs = Number(values['max-stop-ms']);
if (bargeInMs !== undefined && turns.length < 3) throw new Error('--barge-in needs at least 3 turns');
const agentDir = fileURLToPath(new URL('..', import.meta.url));

const SAMPLE_RATE = 48000;
const FRAME = SAMPLE_RATE / 100; // 10 ms
const cleanups: (() => Promise<void> | void)[] = [];

async function main(): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_PIPELINE: 'conversation', LIVEKIT_AGENT_NAME: '' };
  // The barge-in check interrupts the filler of the turn before: that turn must not skip it.
  if (bargeInMs !== undefined) {
    env.FILLERS_ALWAYS = 'true';
    env.FILLER_DELAY_MS = '0';
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ptoy-sim-'));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));

  // ---- services ----
  const servers: FakeServer[] = [];
  if (fakes.has('asr')) {
    const asr = await startFakeAsr(turns.map(spokenText), 0, turnEmotions);
    servers.push(asr);
    env.ASR_URL = asr.url;
  }
  let llmRequests: Record<string, unknown>[] = [];
  let ttsCalls: Record<string, unknown>[] = [];
  if (fakes.has('llm')) {
    const llm = await startFakeOpenAI({
      fail: values.fail === 'llm' ? () => 'status' : undefined,
      reply: (body) => {
        const messages = body.messages as { role: string; content: string }[];
        const last = (messages.at(-1)?.content ?? '').replace(TONE_PREFIX, '');
        if (messages.some((m) => m.content.includes('\uFEFF'))) return ['历史里混进了字幕分隔符。'];
        // Per-sentence tags, one split across tokens, one invalid (→ 平静).
        return ['[喜]', '收到', '，你说的是', `“${last}”。`, '[哀', ']还想', '聊点', '什么？', '[开心]随便', '说说。'];
      },
      tokenDelayMs: 20,
    });
    servers.push(llm);
    llmRequests = llm.requests;
    env.LLM_BASE_URL = llm.baseUrl;
  }
  if (fakes.has('tts')) {
    const tts = await startFakeGradio({ synthMs: Number(values['tts-ms']), fail: values.fail === 'tts' ? () => 'error' : undefined });
    servers.push(tts);
    ttsCalls = tts.calls;
    env.TTS_GRADIO_URL = tts.url;
    env.TTS_EMOTION_CONTROL = 'vector';
    const ref = join(scratch, 'ref.wav');
    writeFileSync(ref, encodeWav({ samples: new Int16Array(22050), sampleRate: 22050, channels: 1 }));
    env.TTS_REF_AUDIO = ref;
  }
  cleanups.push(() => Promise.all(servers.map((s) => s.close())).then(() => undefined));

  // ---- LiveKit ----
  if (process.env.LIVEKIT_SERVER_BIN) {
    // Free ports, so several simulated calls (e.g. from two worktrees) can run at once.
    const [port, tcpPort, udpPort] = [await freePort(), await freePort(), await freePort()];
    const lk = spawn(process.env.LIVEKIT_SERVER_BIN, ['--dev', '--bind', '127.0.0.1'], {
      env: { ...process.env, LIVEKIT_CONFIG: `port: ${port}\nrtc:\n  tcp_port: ${tcpPort}\n  udp_port: ${udpPort}\n` },
      stdio: 'ignore',
    });
    cleanups.push(() => stopProcess(lk));
    env.LIVEKIT_URL = `ws://127.0.0.1:${port}`;
    env.LIVEKIT_API_KEY = 'devkey';
    env.LIVEKIT_API_SECRET = 'secret';
    await waitHttp(`http://127.0.0.1:${port}`);
  }
  const livekitUrl = env.LIVEKIT_URL ?? 'ws://localhost:7880';

  // ---- agent worker ----
  const timings: Record<string, unknown>[] = [];
  const agentLogs: string[] = [];
  const agent = spawn('pnpm', ['exec', 'tsx', 'src/agent.ts', 'start', '--log-level', process.env.SIM_LOG_LEVEL ?? 'info'], {
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
  await Promise.race([
    ready,
    sleep(60_000).then(() => Promise.reject(new Error(`agent worker did not register:\n${agentLogs.slice(-20).join('\n')}`))),
  ]);

  // ---- caller ----
  const roomName = `sim-${Date.now()}`;
  const at = new AccessToken(env.LIVEKIT_API_KEY ?? 'devkey', env.LIVEKIT_API_SECRET ?? 'secret', { identity: 'sim-caller' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  const room = new Room();
  cleanups.push(() => room.disconnect());
  await room.connect(livekitUrl, await at.toJwt(), { autoSubscribe: true, dynacast: false });

  // Small queue: the default 1 s lets the pump run ahead, so the agent would hear the caller late.
  const source = new AudioSource(SAMPLE_RATE, 1, 100);
  const track = LocalAudioTrack.createAudioTrack('mic', source);
  await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

  // Mic pump: speech when queued, otherwise silence, in real time.
  let speech: Int16Array[] = [];
  let speechDone: (() => void) | undefined;
  /** When the pump captured the first frame of the current turn. */
  let speechStartedAt = 0;
  let pumping = true;
  const pump = (async () => {
    const silence = new Int16Array(FRAME);
    let next = performance.now();
    while (pumping) {
      const chunk = speech.shift();
      // The frame goes out once the audio already queued in the source has played.
      if (chunk && !speechStartedAt) speechStartedAt = Date.now() + source.queuedDuration;
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
  /** Audible stretches of agent audio this turn ([start, end] ms epoch), split on ≥150 ms of silence. */
  let bursts: [number, number][] = [];
  /** Every audible stretch of the call (never reset). */
  const allBursts: [number, number][] = [];
  /** Agent subtitle streams (one per reply), absolute times. */
  const subtitleStreams: { openedAt: number; firstAt: number; text: string }[] = [];
  const agentText: string[] = [];
  let subtitleFirstAt = 0;
  let subtitleLastAt = 0;
  /** When the caller started speaking the current turn. */
  let turnStartedAt = 0;
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
          const now = Date.now();
          for (const list of [bursts, allBursts]) {
            const last = list.at(-1);
            if (last && now - last[1] < 150) last[1] = now;
            else list.push([now, now]);
          }
          lastAudioAt = now;
          if (!firstAudioAt) firstAudioAt = lastAudioAt;
        }
      }
    })();
  });
  room.registerTextStreamHandler('lk.transcription', async (reader, info) => {
    if (info.identity === room.localParticipant?.identity) return;
    let text = '';
    const stream = { openedAt: Date.now(), firstAt: 0, text: '' };
    subtitleStreams.push(stream);
    try {
      for await (const chunk of reader) {
        const now = Date.now();
        text += chunk;
        stream.text = text.replaceAll('\uFEFF', '');
        if (chunk.trim()) {
          if (!stream.firstAt) stream.firstAt = now;
          // Late chunks of a reply cut by this turn's barge-in are not this turn's subtitle, nor is
          // the single character a reply dropped before it played can flash (known, cosmetic).
          if (stream.openedAt >= turnStartedAt && [...stream.text.trim()].length > 1) {
            if (!subtitleFirstAt) subtitleFirstAt = now;
            subtitleLastAt = now;
          }
        }
      }
    } catch {
      // stream cut by an interruption or the disconnect at the end: keep what arrived
    }
    // A reply cut by this turn's barge-in belongs to the turn before.
    if (text.trim() && stream.openedAt >= turnStartedAt) agentText.push(text.replaceAll('\uFEFF', ''));
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
    /** Audible stretches relative to the end of the caller's speech: [startMs, durationMs]. */
    bursts: [number, number][];
    /** First / last subtitle text relative to first / last audible agent audio (sync check). */
    subtitleStartVsAudioMs?: number;
    subtitleEndVsAudioMs?: number;
    error: string;
  }[] = [];
  /** Absolute times per turn: caller speech start / end. */
  const spans: { startAt: number; endAt: number }[] = [];
  // Synthesized up front: `say` takes a few hundred ms, which would delay a barge-in.
  const pause = new Int16Array(Math.round((SAMPLE_RATE * Number(values['pause-ms'])) / 1000));
  const voices = turns.map((sentence, i) => {
    const parts = sentence.split('~').filter(Boolean).map((part, k) => {
      const file = join(scratch, `turn${i}-${k}.wav`);
      execFileSync('say', ['-v', values.voice, '-o', file, `--data-format=LEI16@${SAMPLE_RATE}`, part]);
      return trimSilence(decodeWav(new Uint8Array(readFileSync(file))).samples);
    });
    return concat(parts.flatMap((p, k) => (k === 0 ? [p] : [pause, p])));
  });
  for (const [i, sentence] of turns.entries()) {
    const pcm = voices[i] ?? new Int16Array(0);
    firstAudioAt = 0;
    bursts = [];
    subtitleFirstAt = 0;
    subtitleLastAt = 0;
    agentText.length = 0;
    agentError = '';
    const frames: Int16Array[] = [];
    for (let o = 0; o + FRAME <= pcm.length; o += FRAME) frames.push(pcm.slice(o, o + FRAME));
    const spoken = new Promise<void>((resolve) => {
      speechDone = resolve;
    });
    speechStartedAt = 0;
    turnStartedAt = Date.now();
    speech = frames;
    await spoken;
    const stoppedAt = Date.now();
    // trimSilence keeps a 50 ms margin before the first loud sample.
    spans.push({ startAt: speechStartedAt + 50, endAt: stoppedAt });
    // Agent audio heard while the caller was still talking (a barged-in filler) is not this turn's reply.
    firstAudioAt = 0;
    bursts = [];

    // Wait for the reply to finish: audio started and then 1.5s of silence, or an error, or timeout.
    const until = stoppedAt + turnTimeoutMs;
    const bargeIn = i === bargedTurn;
    while (Date.now() < until) {
      if (bargeIn && firstAudioAt && Date.now() - firstAudioAt >= (bargeInMs ?? 0)) break;
      // The reply has subtitles, the filler has none: a silence after the filler is not the end.
      if (firstAudioAt && subtitleFirstAt && state() !== 'speaking' && Date.now() - lastAudioAt > 1500) break;
      if (agentError && state() === 'listening') break;
      // A backchannel gets no reply of its own: done once the agent is quiet again.
      if (i === bargingTurn && bargesWithBackchannel && state() !== 'speaking' && Date.now() - Math.max(lastAudioAt, stoppedAt) > 2500) break;
      await sleep(50);
    }
    if (!bargeIn) await sleep(300);
    const heard = agentText.join(' / ');
    results.push({
      said: sentence,
      heard,
      clientLatencyMs: firstAudioAt ? firstAudioAt - stoppedAt : undefined,
      audioMs: firstAudioAt ? lastAudioAt - firstAudioAt : 0,
      bursts: bursts.map(([a, b]) => [a - stoppedAt, b - a]),
      subtitleStartVsAudioMs: firstAudioAt && subtitleFirstAt ? subtitleFirstAt - firstAudioAt : undefined,
      subtitleEndVsAudioMs: firstAudioAt && subtitleLastAt ? subtitleLastAt - lastAudioAt : undefined,
      error: agentError,
    });
    out(
      `turn ${i + 1}: said "${sentence}" → ${firstAudioAt ? `audio after ${firstAudioAt - stoppedAt}ms` : 'NO AUDIO'}` +
        ` (bursts ${JSON.stringify(results.at(-1)?.bursts)})` +
        `${heard ? `, subtitle "${heard}"` : ''}${agentError ? `, agent_error "${agentError}"` : ''}`,
    );
    if (!bargeIn) await sleep(800);
  }

  await sleep(1000);
  out('\nagent turn timing logs:');
  for (const t of timings) out(`  ${JSON.stringify(t)}`);
  out('\nsummary:');
  out(JSON.stringify({ results, timings }, null, 2));
  const answerless = (i: number) => i === bargedTurn || (i === bargingTurn && bargesWithBackchannel);
  const allAnswered = results.every((r, i) => answerless(i) || (r.clientLatencyMs !== undefined && r.heard));
  const expectFailure = Boolean(values.fail);
  let ok = expectFailure ? results.every((r) => r.error) : allAnswered;
  const problems = expectFailure ? [] : [...checkTurns(results, timings), ...checkEmotions(llmRequests, ttsCalls)];
  // One committed agent turn per caller turn: more means a pause inside a turn ended it early.
  const expectedTurns = turns.length - (bargesWithBackchannel ? 1 : 0);
  out(`\nendpoints: ${turns.length} caller turns → ${timings.length} committed: ${JSON.stringify(timings.map((t) => t.user))}`);
  if (!expectFailure && timings.length > expectedTurns) problems.push(`${timings.length - expectedTurns} caller turn(s) were split by a pause`);
  if (!expectFailure && bargingTurn >= 0) {
    problems.push(...checkBargeIn({ spans, allBursts, subtitleStreams, timings, llmRequests: fakes.has('llm') ? llmRequests : undefined }));
  }
  for (const p of problems) out(`CHECK FAILED: ${p}`);
  ok &&= problems.length === 0;
  if (!ok || process.env.SIM_DUMP) {
    out('\nFAILED — last agent log lines:');
    for (const l of agentLogs.slice(process.env.SIM_DUMP ? 0 : -40)) out(`  ${l.slice(0, 400)}`);
  }
  return ok ? 0 : 1;
}

/** The fake LLM's reply to `said` as the caller should see it (tags removed). */
const fakeReply = (said: string) => `收到，你说的是“${said}”。还想聊点什么？随便说说。`;

const TONE_PREFIX = /^\[用户语气:[^\]]*\] /u;

/** Emotion each segment of the fake reply must be synthesized with, by its text. */
const FAKE_SEGMENT_EMOTIONS: [RegExp, Emotion][] = [
  [/^收到，$/u, '喜'],
  [/^你说的是/u, '喜'],
  [/^还想聊点什么？$/u, '哀'],
  [/^随便说说。$/u, '平静'],
];

/**
 * Emotion chain checks (#13), with the fake LLM:
 * - every LLM request: the last (answered) user message is the turn's text with its tone prefix
 *   (none for neutral); earlier messages carry no prefix and no `[...]` tag
 * - with the fake TTS: each segment's request uses its tag's emotion (vector) or the reference (平静)
 */
function checkEmotions(requests: Record<string, unknown>[], ttsCalls: Record<string, unknown>[]): string[] {
  if (!fakes.has('llm')) return [];
  const problems: string[] = [];
  const expected = new Map(
    turns.map((t, i) => [t, withTone(t, fakes.has('asr') ? ASR_EMOTION_TONE[(turnEmotions[i] || 'neutral') as AsrEmotion] ?? '平静' : '平静')]),
  );
  for (const [r, body] of requests.entries()) {
    const messages = (body.messages as { role: string; content: string }[]).filter((m) => m.role !== 'system');
    const last = messages.at(-1);
    const said = last?.content.replace(TONE_PREFIX, '') ?? '';
    const want = expected.get(said);
    if (want !== undefined && last?.content !== want) {
      problems.push(`llm request ${r + 1}: user message "${last?.content}", expected "${want}"`);
    }
    for (const m of messages.slice(0, -1)) {
      if (/[[\]【】]/u.test(m.content)) problems.push(`llm request ${r + 1}: history ${m.role} message has a tag: "${m.content}"`);
    }
  }
  if (!fakes.has('tts')) return problems;
  for (const call of ttsCalls) {
    const text = String(call.text);
    const want = FAKE_SEGMENT_EMOTIONS.find(([re]) => re.test(text))?.[1];
    const vec = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => Number(call[`vec${i}`] ?? 0));
    const got: Emotion | undefined =
      call.emo_control_method === '使用情感向量控制' ? EMOTIONS[vec.indexOf(Math.max(...vec))] : '平静';
    if (want && got !== want) problems.push(`tts segment "${text}": emotion ${got}, expected ${want}`);
  }
  const vectorSegments = ttsCalls.filter((c) => c.emo_control_method === '使用情感向量控制').length;
  if (ttsCalls.length > 0 && vectorSegments === 0) problems.push('tts: no segment used the emotion vector');
  return problems;
}

/**
 * Per-turn checks on what the caller received:
 * - subtitles: only the reply text, no `[...]` tag, no filler text (exact text with the fake LLM)
 * - with a filler (not skipped): the reply audio never cuts into it — first to last audible frame spans at least
 *   filler + reply (one track, so an overlap would show up as a shortened filler or reply)
 * - fillers: never the same one two turns in a row
 */
function checkTurns(
  results: { said: string; heard: string; audioMs: number; bursts: [number, number][] }[],
  timings: Record<string, unknown>[],
): string[] {
  const problems: string[] = [];
  results.forEach((r, i) => {
    const t = timings[i];
    if (i === bargedTurn) {
      if (!t?.filler) problems.push(`turn ${i + 1}: no filler before the barge-in: ${JSON.stringify(t)}`);
      return;
    }
    if (i === bargingTurn && bargesWithBackchannel) return;
    if (/[[\]【】]/u.test(r.heard)) problems.push(`turn ${i + 1}: subtitle has a tag: "${r.heard}"`);
    // A reply dropped before it played can flash its first character as a subtitle (known, cosmetic).
    const heard = i === bargingTurn ? (r.heard.split(' / ').at(-1) ?? '') : r.heard;
    if (heard !== r.heard) out(`NOTE turn ${i + 1}: dropped reply flashed subtitle "${r.heard.split(' / ')[0]}"`);
    if (fakes.has('llm') && fakes.has('asr') && heard !== fakeReply(spokenText(r.said))) problems.push(`turn ${i + 1}: subtitle "${r.heard}" ≠ reply`);
    if (!t || typeof t.filler !== 'string') return;
    // A filler skipped by FILLER_DELAY_MS (reply ready first) made no sound.
    const fillerMs = t.fillerSkipped ? 0 : Number(t.fillerAudioMs ?? 0);
    const replyMs = Number(t.ttsAudioMs ?? 0);
    const first = r.bursts[0];
    const last = r.bursts.at(-1);
    const span = first && last ? last[0] + last[1] - first[0] : 0;
    // Quiet edges of the clips (fade in/out, below the detection threshold) are not counted.
    if (span < fillerMs + replyMs - 300) {
      problems.push(`turn ${i + 1}: agent audio spans ${span}ms, expected filler ${fillerMs}ms + reply ${replyMs}ms`);
    }
    if (i > 0 && timings[i - 1]?.filler === t.filler) problems.push(`turn ${i + 1}: filler ${t.filler} repeated`);
  });
  return problems;
}

interface BargeInFacts {
  readonly spans: readonly { startAt: number; endAt: number }[];
  readonly allBursts: readonly [number, number][];
  readonly subtitleStreams: readonly { openedAt: number; firstAt: number; text: string }[];
  readonly timings: readonly Record<string, unknown>[];
  readonly llmRequests?: readonly Record<string, unknown>[];
}

/**
 * The caller's last turn barges in on the turn before (`--barge-in`), measured on the audio the
 * caller received:
 * - stop: the last agent audio heard while the caller talks ends within --max-stop-ms of their
 *   speech onset (also catches a queued reply that leaks into a pause of the caller's speech)
 * - history (fake LLM): the interrupted reply in the next request is exactly the played prefix
 *   (≈ played ms / 100 ms per fake-TTS character, same text as the subtitle), absent if unplayed
 * A backchannel barge-in ("嗯") must not cut the reply: it is committed in full and never answered.
 */
function checkBargeIn(f: BargeInFacts): string[] {
  const problems: string[] = [];
  const barging = f.spans[bargingTurn];
  const barged = f.spans[bargedTurn];
  if (!barging || !barged) return ['barge-in: turn spans missing'];
  const onset = barging.startAt;
  // Everything the agent played after the onset while the caller talked (a reply that resumes
  // in a pause of the caller's speech counts too); the caller's own turn is answered later.
  const during = f.allBursts.filter(([a, b]) => b > onset && a < barging.endAt + 300);
  const stopAt = during.at(-1)?.[1];
  const stopMs = stopAt === undefined ? undefined : stopAt - onset;
  const said = spokenText(turns[bargedTurn] ?? '');
  const full = fakeReply(said);
  const stream = f.subtitleStreams.find((s) => s.openedAt >= barged.endAt && s.openedAt < onset && s.text);
  const history = historyReplyTo(said, f.llmRequests);
  out(
    `barge-in (onset ${onset}): ${stopMs === undefined ? 'no agent audio after the onset' : `agent audio stopped ${stopMs}ms after the onset`} ` +
      `(${during.length} bursts), subtitle "${stream?.text ?? ''}", history ${JSON.stringify(history ?? null)}`,
  );

  if (bargesWithBackchannel) {
    if (f.llmRequests?.some((r) => lastUser(r)?.endsWith(spokenText(turns[bargingTurn] ?? '')))) {
      problems.push('barge-in: the backchannel got its own reply');
    }
    const t = f.timings.find((x) => x.user === said);
    if (fakes.has('llm') && (t?.interrupted || t?.reply !== full)) {
      problems.push(`barge-in: backchannel cut the reply: ${JSON.stringify(t)}`);
    }
    return problems;
  }
  if (stopMs !== undefined && stopMs > maxStopMs) {
    problems.push(`barge-in: agent audio heard until ${stopMs}ms after the caller's onset (max ${maxStopMs}): ${JSON.stringify(during.map(([a, b]) => [a - onset, b - a]))}`);
  }
  if (!f.llmRequests) return problems;
  if (!stream) {
    if (history !== undefined) problems.push(`barge-in: unplayed reply "${history}" is in the history`);
    return problems;
  }
  if (history === undefined) return [...problems, 'barge-in: the played part of the reply is missing from the history'];
  if (!full.startsWith(history) || history === full) problems.push(`barge-in: history "${history}" is not a cut of "${full}"`);
  if (Math.abs([...history].length - [...stream.text].length) > 2) {
    problems.push(`barge-in: history "${history}" ≠ subtitle "${stream.text}"`);
  }
  const playedMs = (stopAt ?? onset) - (stream.firstAt || stream.openedAt);
  const expected = Math.round(playedMs / 100);
  if (Math.abs([...history].length - expected) > 3) {
    problems.push(`barge-in: history has ${[...history].length} chars, ~${expected} were played (${playedMs}ms)`);
  }
  return problems;
}

const lastUser = (request: Record<string, unknown>) =>
  (request.messages as { role: string; content: string }[]).filter((m) => m.role === 'user').at(-1)?.content;

/** The assistant message right after the user's `said` in the latest LLM request that contains both. */
function historyReplyTo(said: string, requests?: readonly Record<string, unknown>[]): string | undefined {
  const messages = (requests?.at(-1)?.messages ?? []) as { role: string; content: string }[];
  const at = messages.findIndex((m) => m.role === 'user' && m.content.endsWith(said));
  const next = at >= 0 ? messages[at + 1] : undefined;
  return next?.role === 'assistant' ? next.content : undefined;
}

function concat(parts: Int16Array[]): Int16Array {
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
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

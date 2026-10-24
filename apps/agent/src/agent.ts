import { type JobContext, ServerOptions, cli, defineAgent, log } from '@livekit/agents';
import { RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { conversationPipeline } from './pipelines/conversation.js';
import { echoPipeline } from './pipelines/echo.js';
import { transcribePipeline } from './pipelines/transcribe.js';
import type { CallPipeline } from './pipelines/types.js';
import { loadAccessConfig } from './access/config.js';
import { AgentAccessClient } from './access/agent-client.js';
import { ATTRIBUTE_CHARACTER } from './characters.js';
import { loadAgentHealthConfig } from './config.js';

/**
 * `AGENT_PIPELINE` selects what the agent does in a call:
 * `conversation` (default, M1 #10: VAD + STT → LLM → TTS, both subtitles),
 * `transcribe` (M1 #8: VAD + STT → user subtitles only) or
 * `echo` (M0 loopback, used by the smoke test and to check the WebRTC path without any model).
 */
const PIPELINES: Readonly<Record<string, CallPipeline>> = {
  conversation: conversationPipeline,
  echo: echoPipeline,
  transcribe: transcribePipeline,
};

function selectPipeline(name = process.env.AGENT_PIPELINE || 'conversation'): CallPipeline {
  const pipeline = PIPELINES[name];
  if (!pipeline) {
    throw new Error(`Unknown AGENT_PIPELINE "${name}" (expected: ${Object.keys(PIPELINES).join(' | ')})`);
  }
  return pipeline;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log().child({ room: ctx.job.room?.name });
    await ctx.connect();
    logger.info('agent joined room, waiting for caller');

    const accessConfig = loadAccessConfig();
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let caller: RemoteParticipant;
    try {
      caller = await Promise.race([
        ctx.waitForParticipant(),
        new Promise<never>((_, reject) => { waitTimer = setTimeout(() => reject(new Error('caller timeout')), accessConfig.pendingTimeoutMs); }),
      ]);
    } catch { ctx.shutdown('caller did not join'); return; }
    finally { clearTimeout(waitTimer); }
    logger.info({ caller: caller.identity }, 'caller present');

    // One call per room: when the caller hangs up, the agent leaves too.
    let stopped = false;
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (participant.identity === caller.identity) {
        stopped = true;
        logger.info({ caller: caller.identity }, 'caller left, ending job');
        ctx.shutdown('caller disconnected');
      }
    });

    const access = new AgentAccessClient(accessConfig, {
      room: ctx.room.name!, participant: caller.identity, agentId: ctx.room.localParticipant!.identity,
    });
    let admitted = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let checking = false;
    let cleaning = false;
    try {
      const admission = await access.admit(() => stopped);
      admitted = true;
      if (stopped || caller.attributes[ATTRIBUTE_CHARACTER] !== admission.character) throw new Error('call identity changed');
      heartbeat = setInterval(() => {
        if (checking) return;
        checking = true;
        void access.request('heartbeat').then(result => {
          if (result.ok && !result.active && !cleaning) { stopped = true; ctx.shutdown('call ended'); }
        }).catch(() => { /* Existing calls survive control-plane outages; no new admission occurs. */ })
          .finally(() => { checking = false; });
      }, 3000);
      await selectPipeline()(ctx, caller);
    } catch (error) {
      logger.warn({ error }, 'call rejected or pipeline failed');
      stopped = true;
      ctx.shutdown('call unavailable');
    } finally {
      // SDK disconnects the room before shutdown callbacks. Complete all pipeline cleanup before
      // releasing the slot; ordinary SDK callbacks otherwise run concurrently.
      const cleanup = ctx.shutdownCallbacks.splice(0);
      ctx.addShutdownCallback(async () => {
        cleaning = true;
        try {
          const results = await Promise.allSettled(cleanup.map(callback => callback()));
          const failed = results.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          if (admitted) await access.request('finish').catch(() => undefined);
        } finally { clearInterval(heartbeat); }
      });
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `dev` defaults to debug, which buries the call's own lines under LiveKit's; LOG_LEVEL=debug restores it.
  process.env.LOG_LEVEL ||= 'info';
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), ...loadAgentHealthConfig() }));
}

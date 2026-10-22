import { type JobContext, ServerOptions, cli, defineAgent, log } from '@livekit/agents';
import { RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { echoPipeline } from './pipelines/echo.js';
import { transcribePipeline } from './pipelines/transcribe.js';
import type { CallPipeline } from './pipelines/types.js';

/**
 * `AGENT_PIPELINE` selects what the agent does in a call:
 * `transcribe` (default, M1 #8: VAD + STT → user subtitles; #10 adds LLM/TTS) or
 * `echo` (M0 loopback, used by the smoke test and to check the WebRTC path without any model).
 */
const PIPELINES: Readonly<Record<string, CallPipeline>> = { echo: echoPipeline, transcribe: transcribePipeline };

function selectPipeline(name = process.env.AGENT_PIPELINE || 'transcribe'): CallPipeline {
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

    const caller = await ctx.waitForParticipant();
    logger.info({ caller: caller.identity }, 'caller present');

    // One call per room: when the caller hangs up, the agent leaves too.
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (participant.identity === caller.identity) {
        logger.info({ caller: caller.identity }, 'caller left, ending job');
        ctx.shutdown('caller disconnected');
      }
    });

    await selectPipeline()(ctx, caller);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}

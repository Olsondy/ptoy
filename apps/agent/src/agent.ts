import { type JobContext, ServerOptions, cli, defineAgent, log } from '@livekit/agents';
import { RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { transcribePipeline } from './pipelines/transcribe.js';
import type { CallPipeline } from './pipelines/types.js';

/** M1 #8: VAD + STT → user subtitles. #10 adds LLM/TTS. (`echoPipeline` in ./pipelines/echo.ts is the M0 loopback.) */
const pipeline: CallPipeline = transcribePipeline;

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

    await pipeline(ctx, caller);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}

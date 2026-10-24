import { type JobContext, ServerOptions, cli, defineAgent, log } from '@livekit/agents';
import { RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { conversationPipeline } from './pipelines/conversation.js';
import { echoPipeline } from './pipelines/echo.js';
import { transcribePipeline } from './pipelines/transcribe.js';
import type { CallPipeline } from './pipelines/types.js';

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
  // `dev` defaults to debug, which buries the call's own lines under LiveKit's; LOG_LEVEL=debug restores it.
  process.env.LOG_LEVEL ||= 'info';
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}

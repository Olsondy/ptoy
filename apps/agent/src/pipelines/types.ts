import type { JobContext } from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';

/**
 * What the agent does with a caller once both are in the room.
 *
 * M0 ships `echoPipeline`; M1 (#5) adds a VAD/STT/LLM/TTS pipeline built on
 * `voice.AgentSession` and swaps it in `agent.ts` without touching the job lifecycle.
 * A pipeline owns its own resources and must release them via `ctx.addShutdownCallback`.
 */
export type CallPipeline = (ctx: JobContext, caller: RemoteParticipant) => Promise<void>;

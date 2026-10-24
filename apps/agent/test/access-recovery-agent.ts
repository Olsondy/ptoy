/** Test-only wrapper: exercise production admission/cleanup ordering with an intentionally slow cleanup. */
import { cli, defineAgent, ServerOptions } from '@livekit/agents';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import productionAgent from '../src/agent.js';

export default defineAgent({
  entry: async ctx => {
    const delay = Number(process.env.RECOVERY_CLEANUP_MS ?? 0);
    const signals = process.env.RECOVERY_SIGNAL_DIR;
    if (signals && delay) ctx.addShutdownCallback(async () => {
      await writeFile(join(signals, `${ctx.job.room!.name}.cleanup-start`), String(Date.now()));
      await new Promise(resolve => setTimeout(resolve, delay));
      await writeFile(join(signals, `${ctx.job.room!.name}.cleanup-done`), String(Date.now()));
    });
    await productionAgent.entry(ctx);
  },
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.env.LOG_LEVEL ||= 'info';
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}

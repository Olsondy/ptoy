// Resolve the exact optional native dependency used by the installed Agent SDK.
// Importing the SDK alone is insufficient: it can catch native loading failures.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const timeout = setTimeout(() => {
  console.error('LiveKit native VAD preflight timed out.');
  process.exit(1);
}, 30000);
try {
  const fromAgent = createRequire(resolve(process.argv[2], 'apps/agent/package.json'));
  const fromSdk = createRequire(fromAgent.resolve('@livekit/agents'));
  const binding = fromSdk('@livekit/local-inference');
  if (typeof binding.createVad !== 'function' || binding.VAD_WINDOW_SAMPLES !== 512) {
    throw new Error('VAD exports are unavailable');
  }
  const vad = binding.createVad();
  const probability = await vad.predict(new Int16Array(binding.VAD_WINDOW_SAMPLES));
  vad.reset();
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('VAD inference returned an invalid probability');
  }
  console.log('LiveKit native VAD binding and silent-frame inference passed.');
} catch {
  console.error('LiveKit native VAD preflight failed; repair Linux optional dependencies before publishing.');
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

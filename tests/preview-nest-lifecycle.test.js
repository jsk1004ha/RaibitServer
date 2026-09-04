import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubIntegrationService } from '../apps/api/dist/modules/integrations/github.service.js';

test('Nest integration lifecycle drains without overlap and awaits shutdown', async () => {
  let calls = 0;
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const controlPlane = { applyNextPreviewObservation: async () => { calls += 1; if (calls === 1) await first; return { processed: calls < 3 }; } };
  const provider = new GitHubIntegrationService(controlPlane);
  provider.onModuleInit();
  const left = provider.drainPreviewObservations();
  const right = provider.drainPreviewObservations();
  assert.equal(left, right);
  const shutdown = provider.onModuleDestroy();
  release();
  assert.deepEqual(await left, { processed: 2 });
  await shutdown;
  const callsAtShutdown = calls;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(calls, callsAtShutdown);
});

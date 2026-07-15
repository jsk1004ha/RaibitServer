import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLegacyDevE2EDryRun, parseE2EOptions, resolveE2EPlan, hasLiveE2ETools, missingLiveE2EToolGroups, liveE2ESetupPlan } from '../scripts/e2e-mode.mjs';

test('e2e mode defaults to deterministic dry-run without execute side effects', () => {
  const options = parseE2EOptions([], {});
  assert.deepEqual(options, { requestedMode: 'dry', execute: false });

  const plan = resolveE2EPlan({ ...options, tools: { docker: false, kubectl: false, kind: false, k3d: false } });
  assert.equal(plan.mode, 'dry');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.label, 'deterministic-dry-run');
  assert.deepEqual(plan.missingTools, ['docker', 'kubectl', 'kind|k3d']);
  assert.equal(plan.setup.clusterEngine, 'dry-run');
});

test('live e2e requires explicit execute plus container and cluster tools', () => {
  assert.equal(hasLiveE2ETools({ docker: true, kubectl: true, kind: true }), true);
  assert.equal(hasLiveE2ETools({ docker: true, kubectl: true, kind: false, k3d: false }), false);
  assert.deepEqual(missingLiveE2EToolGroups({ docker: true, kubectl: false, kind: false, k3d: true }), ['kubectl']);

  assert.throws(() => resolveE2EPlan({ requestedMode: 'live', execute: false, tools: { docker: true, kubectl: true, kind: true } }), /requires --execute/);
  assert.throws(() => resolveE2EPlan({ requestedMode: 'live', execute: true, tools: { docker: true, kubectl: false, kind: true } }), /kubectl/);

  const plan = resolveE2EPlan({ requestedMode: 'live', execute: true, tools: { docker: true, kubectl: true, k3d: true } });
  assert.equal(plan.mode, 'live');
  assert.equal(plan.dryRun, false);
  assert.equal(plan.label, 'live-container-execute');
  assert.equal(plan.setup.clusterEngine, 'k3d');
  assert.equal(plan.setup.commands.some((command) => command.includes('registry:2')), true);
  assert.equal(plan.setup.commands.some((command) => command.includes('--registry-use')), true);
});

test('auto mode only escalates to live when execute is explicit and tools are ready', () => {
  const tools = { docker: true, kubectl: true, kind: true };
  assert.equal(resolveE2EPlan({ requestedMode: 'auto', execute: false, tools }).mode, 'dry');
  assert.equal(resolveE2EPlan({ requestedMode: 'auto', execute: true, tools }).mode, 'live');
});

test('live setup plan chooses kind or k3d and includes registry plus ingress steps', () => {
  const kindPlan = liveE2ESetupPlan({ docker: true, kubectl: true, kind: true });
  assert.equal(kindPlan.clusterEngine, 'kind');
  assert.equal(kindPlan.registryPort, 5000);
  assert.equal(kindPlan.registryReachableFromCluster, true);
  assert.equal(kindPlan.commands.some((command) => command.includes('containerdConfigPatches')), true);
  assert.equal(kindPlan.commands.some((command) => command.includes('docker network connect kind')), true);
  assert.equal(kindPlan.commands.some((command) => command.includes('local-registry-hosting')), true);
  assert.equal(kindPlan.commands.some((command) => command.includes('manageddatabase-crd.yaml')), true);
  assert.equal(kindPlan.commands.some((command) => command.includes('managedresources-crd.yaml')), true);
  assert.equal(kindPlan.commands.some((command) => command.includes('ingress-nginx')), true);
  assert.equal(kindPlan.commands.some((command) => command.includes('raibitserver.io/ingress-gateway')), false);
  assert.equal(kindPlan.commands.some((command) => command.includes('kubectl wait')), true);
});

test('legacy dev E2E refuses live TypeScript execution and directs operators to Go workers', () => {
  assert.doesNotThrow(() => assertLegacyDevE2EDryRun({ dryRun: true }));
  assert.throws(
    () => assertLegacyDevE2EDryRun({ dryRun: false }),
    /legacy TypeScript dev E2E.*dry-run only.*Go builder.*Go orchestrator/i,
  );
});

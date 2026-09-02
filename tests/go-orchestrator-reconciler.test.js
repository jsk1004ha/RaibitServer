import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function hasCommand(command) {
  return spawnSync(command, ['version'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

test('Go orchestrator reconciler contract is executable when Go exists or statically present otherwise', async () => {
  if (hasCommand('go')) {
    const result = spawnSync('go', ['test', './...'], { cwd: 'services/orchestrator', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return;
  }

  const [main, reconciler, kube, store, errorSpec] = await Promise.all([
    fs.readFile('services/orchestrator/cmd/orchestrator/main.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/reconciler/reconciler.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/kube/deployment.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/store/store.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/store/error_spec.go', 'utf8'),
  ]);
  assert.match(main, /NewServiceReconcilerWithStore/);
  assert.match(store, /ListDeploymentsForReconcile/);
  assert.match(reconciler, /orchestrator\.apply\.started/);
  assert.match(reconciler, /rollout.*status/s);
  assert.match(reconciler, /preview\.cleanup\.completed/);
  assert.match(reconciler, /ErrorCodeKubernetesReconcileFailed/);
  assert.match(reconciler, /ErrorSpecForFailure/);
  assert.match(errorSpec, /ErrorCodeImagePullBackoff/);
  assert.match(errorSpec, /ErrorCodeKubernetesReconcileFailed/);
  assert.match(errorSpec, /UserMessage/);
  assert.match(kube, /previewKey := "pr-"/);
  assert.match(kube, /serviceName = previewKey \+ "-" \+ baseServiceName/);
  assert.match(kube, /raibitserver\.io\/preview/);
  assert.match(kube, /NetworkPolicy/);
  assert.match(kube, /readOnlyRootFilesystem/);
});

test('Go hostname expectations stay on the flat single-label routing contract', async () => {
  const [kubeTest, reconcilerTest] = await Promise.all([
    fs.readFile('services/orchestrator/internal/kube/deployment_test.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/reconciler/reconciler_test.go', 'utf8'),
  ]);
  for (const hostname of [
    'apps--gdg-hongik--festival-2026.raibitserver.local',
    'apps--gdg-hongik--festival-2026--api.raibitserver.local',
    'preview--pr-32--gdg-hongik--festival-2026.raibitserver.local',
    'preview--pr-32--gdg-hongik--festival-2026--api.raibitserver.local',
    'apps--victim-team--api.example.test',
    'apps--victim--team-api.example.test',
  ]) assert.match(kubeTest, new RegExp(hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(reconcilerTest, /apps--org-1--demo\.test\.local/);
  assert.match(reconcilerTest, /preview--pr-42--org-1--demo\.test\.local/);
  assert.doesNotMatch(kubeTest, /gdg-hongik--festival-2026(?:--api)?\.apps\.raibitserver\.local/);
  assert.doesNotMatch(reconcilerTest, /org-1--demo\.apps\.test\.local|pr-42-org-1--demo\.preview\.test\.local/);
});

test('Go orchestrator network policy stays namespace-scoped instead of all-namespace wildcard', async () => {
  const [kube, kubeTest] = await Promise.all([
    fs.readFile('services/orchestrator/internal/kube/deployment.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/kube/deployment_test.go', 'utf8'),
  ]);
  assert.doesNotMatch(kube, /namespaceSelector": map\[string\]any\{\}/, 'NetworkPolicy must not allow every namespace with an empty namespaceSelector');
  assert.match(kube, /kubernetes\.io\/metadata\.name/);
  assert.match(kube, /spec\.Namespace/);
  assert.match(kube, /defaultIngressGatewayNamespace\s*=\s*"ingress-nginx"/);
  assert.doesNotMatch(kube, /raibitserver\.io\/ingress-gateway/);
  assert.doesNotMatch(kube, /raibitserver\.io\/ingress": "true"/);
  assert.match(kube, /k8s-app/);
  assert.match(kube, /kube-dns/);
  assert.match(kube, /servicePublicEgressPolicy/);
  assert.match(kube, /privateIPv4EgressExceptions/);
  assert.match(kube, /169\.254\.0\.0\/16/);
  assert.match(kubeTest, /TestNetworkPolicyUsesTrustedIngressGatewayNamespace/);
  assert.match(kubeTest, /TestNetworkPolicyUsesConfiguredGatewayAndIgnoresDesiredStateOverride/);
  assert.match(kubeTest, /TestPublicEgressIsServiceScopedAndOptIn/);
});

test('Go orchestrator statically preserves workload-kind parity and batch readiness contracts', async () => {
  const [kube, reconciler, kubeTest, reconcilerTest, rbac] = await Promise.all([
    fs.readFile('services/orchestrator/internal/kube/deployment.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/reconciler/reconciler.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/kube/deployment_test.go', 'utf8'),
    fs.readFile('services/orchestrator/internal/reconciler/reconciler_test.go', 'utf8'),
    fs.readFile('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8'),
  ]);

  for (const marker of ['Deployment', 'CronJob', 'Job', 'one-off', 'one_off', 'ReadinessStrategy', 'WorkloadName']) {
    assert.match(kube, new RegExp(marker.replace('-', '\\-')), `${marker} workload contract missing`);
  }
  for (const label of ['raibitserver.io/project-id', 'raibitserver.io/service-id', 'raibitserver.io/deployment-id', 'raibitserver.io/managed']) {
    assert.match(kube, new RegExp(label.replace(/[./-]/g, '\\$&')), `${label} stable identity label missing`);
  }
  assert.match(kube, /runtimeStringArray/);
  assert.match(kube, /validateCronSchedule/);
  assert.match(kube, /identityDNSName/);
  assert.match(reconciler, /job\.completed/);
  assert.match(reconciler, /cronjob\.accepted/);
  assert.match(reconciler, /condition=complete/);
  assert.match(reconciler, /jsonpath=\{\.metadata\.uid\}/);
  assert.doesNotMatch(reconciler, /rolloutArgs :=/);
  assert.match(rbac, /apiGroups: \["batch"\][\s\S]*resources: \["jobs", "cronjobs"\]/);
  assert.match(kubeTest, /TestWorkloadKindsCompileExactExposureSets/);
  assert.match(kubeTest, /TestPreviewObjectNamesAreDeploymentSpecificAndCleanupIsolated/);
  assert.match(reconcilerTest, /TestRunOnceUsesKindSpecificReadinessCommandsAndEvents/);
  assert.match(reconcilerTest, /TestOldPreviewCleanupCannotTargetNewerDeploymentForSamePR/);
});

test('orchestrator RBAC and cleanup stay within the exact workload reconciliation boundary', async () => {
  const rbac = await fs.readFile('infra/helm/raibitserver/templates/worker-security.yaml', 'utf8');
  const reconciler = await fs.readFile('services/orchestrator/internal/reconciler/reconciler.go', 'utf8');
  const normalized = rbac.replace(/\r/g, '');
  const orchestratorRole = normalized.match(
    /kind: ClusterRole\nmetadata:\n\s+name: .*?-orchestrator\nrules:[\s\S]*?(?=\n---\napiVersion: rbac\.authorization\.k8s\.io\/v1\nkind: ClusterRoleBinding)/,
  )?.[0];

  assert.ok(orchestratorRole, 'orchestrator ClusterRole must be rendered as a bounded block');
  assert.match(orchestratorRole, /resources: \["events"\]\n\s+verbs: \["get", "list", "watch"\]/);
  for (const resource of ['pods', 'pods/log', 'secrets', 'configmaps', 'horizontalpodautoscalers', 'poddisruptionbudgets']) {
    assert.doesNotMatch(orchestratorRole, new RegExp(`resources: \\[[^\\]]*"${resource.replace('/', '\\/')}"`), `${resource} must not be granted to the orchestrator`);
  }
  assert.match(
    reconciler,
    /const serviceDeletionResourceKinds = "deployments,cronjobs,jobs,services,ingresses,networkpolicies"/,
  );
  assert.doesNotMatch(reconciler, /runKubectl\([^\n]+\[\]string\{"logs"/);
  assert.doesNotMatch(reconciler, /"pod-logs"/);
});

test('deployment claim lease migration makes pre-upgrade DEPLOYING rows reclaimable', async () => {
  const migration = await fs.readFile('prisma/migrations/000005_deployment_claim_lease/migration.sql', 'utf8');

  assert.match(migration, /UPDATE\s+"Deployment"/i);
  assert.match(migration, /WHERE\s+status\s*=\s*'DEPLOYING'/i);
  assert.match(migration, /"reconcileAction"\s*=\s*'apply'/i);
  assert.match(migration, /"reconcileLockedAt"\s*=\s*COALESCE\s*\(\s*"updatedAt"\s*,\s*"createdAt"/i);
});

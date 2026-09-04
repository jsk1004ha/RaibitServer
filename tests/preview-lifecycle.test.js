import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyJobId, assertPreviewRetry, createPreviewRuntime, PREVIEW_APPLY_JOB, PREVIEW_RESOLVER_JOB, resolverJobId, resolverPayload, transitionPreviewLineage } from '../packages/core/src/preview-lineage.ts';
import { isWorkflowJobReady } from '../packages/core/src/workflows.ts';
import { servingDeploymentForHealth } from '../packages/core/src/deployment-health.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

const identity = { organizationId: 'org', projectId: 'project', serviceId: 'service', integrationId: 'integration', baseDomain: 'example.test' };
const event = (action, updatedAt, headSha = 'a'.repeat(40), beforeSha = null) => ({ deliveryId: crypto.randomUUID(), installationId: '1', repositoryId: '2', repository: 'club/repo', pullRequestNumber: 7, action, headSha, headRef: 'topic', baseRef: 'main', beforeSha, updatedAt });

function previewStore() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ id: 'org', name: 'Club', slug: 'club' });
  const user = store.createUser({ id: 'user', email: 'owner@example.test', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  store.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxDeploymentsPerDay: 20, maxPreviewDeployments: 20 });
  const project = store.createProject({ id: 'project', organizationId: organization.id, name: 'Project', slug: 'project' });
  const integration = store.createGitHubIntegration({ id: 'integration', organizationId: organization.id, userId: user.id });
  store.verifyGitHubIntegration({ integrationId: integration.id, installationId: '900', accountLogin: 'club' });
  store.registerGitHubRepository({ installationId: '900', githubRepoId: '101', fullName: 'club/repo' });
  const service = store.createService({ id: 'service', projectId: project.id, name: 'Web', slug: 'web', sourceType: 'image', imageUrl: `registry.test/web@sha256:${'d'.repeat(64)}` });
  store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: integration.id, repositoryId: '101', branch: 'main' });
  return store;
}

function signedWebhook(action, updatedAt, options = {}) {
  const secret = 'preview-lifecycle-secret';
  const headSha = options.headSha ?? 'a'.repeat(40);
  const payload = {
    action,
    ...(action === 'synchronize' ? { before: options.beforeSha ?? 'a'.repeat(40) } : {}),
    number: options.pullRequestNumber ?? 7,
    installation: { id: options.installationId ?? 900 },
    repository: { id: options.repositoryId ?? 101, full_name: options.repository ?? 'club/repo' },
    pull_request: {
      number: options.pullRequestNumber ?? 7,
      state: action === 'closed' ? 'closed' : 'open',
      head: { sha: headSha, ref: 'topic' },
      base: { ref: 'main' },
      updated_at: updatedAt,
    },
  };
  const body = JSON.stringify(payload);
  return { event: 'pull_request', deliveryId: options.deliveryId ?? randomUUID(), body, secret, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` };
}

test('preview open synchronize close', () => {
  // Given: a signed open event creates the first immutable generation.
  const store = previewStore();
  const opened = store.handleGitHubWebhook(signedWebhook('opened', '2026-09-03T00:00:00Z'));
  const firstId = opened.actions[0].deploymentId;
  const lineageId = opened.actions[0].lineageId;
  const first = store.deployments.get(firstId);
  store.deployments.set(firstId, { ...first, status: 'READY', publicHealthStatus: 'HEALTHY' });
  store.previewLineages.set(lineageId, { ...store.previewLineages.get(lineageId), currentDeploymentId: firstId, currentGeneration: 1, candidateDeploymentId: null, candidateGeneration: null });

  // When: synchronize creates generation two, which has not passed health yet.
  const synchronized = store.handleGitHubWebhook(signedWebhook('synchronize', '2026-09-03T00:00:01Z', { headSha: 'b'.repeat(40) }));
  const secondId = synchronized.actions[0].deploymentId;

  // Then: generation one remains current and cleanup waits for atomic promotion.
  let lineage = store.previewLineages.get(lineageId);
  assert.deepEqual([lineage.currentDeploymentId, lineage.currentGeneration, lineage.candidateDeploymentId, lineage.candidateGeneration], [firstId, 1, secondId, 2]);
  assert.deepEqual([...store.deployments.values()].filter((row) => row.previewLineageId === lineageId).map((row) => row.previewGeneration).sort(), [1, 2]);
  assert.deepEqual([store.deployments.get(firstId).status, store.deployments.get(secondId).status], ['READY', 'queued']);

  // Given: the orchestrator has health-gated and atomically promoted generation two.
  store.deployments.set(firstId, { ...store.deployments.get(firstId), status: 'PREVIEW_CLEANUP_REQUESTED' });
  store.deployments.set(secondId, { ...store.deployments.get(secondId), status: 'READY', publicHealthStatus: 'HEALTHY' });
  store.previewLineages.set(lineageId, { ...lineage, currentDeploymentId: secondId, currentGeneration: 2, candidateDeploymentId: null, candidateGeneration: null });

  // When: the PR closes.
  const closed = store.handleGitHubWebhook(signedWebhook('closed', '2026-09-03T00:00:02Z', { headSha: 'b'.repeat(40) }));

  // Then: every remaining generation and the owned route are scheduled for cleanup.
  lineage = store.previewLineages.get(lineageId);
  assert.equal(closed.actions[0].type, 'preview-cleanup-requested');
  assert.deepEqual(closed.actions[0].deploymentIds.sort(), [firstId, secondId].sort());
  assert.deepEqual([lineage.state, lineage.currentDeploymentId, lineage.candidateDeploymentId, lineage.routeIntent.operation], ['CLOSED', null, null, 'clear']);
  assert.deepEqual([store.deployments.get(firstId).status, store.deployments.get(secondId).status], ['PREVIEW_CLEANUP_REQUESTED', 'PREVIEW_CLEANUP_REQUESTED']);
});

test('preview adversarial webhook matrix', () => {
  // Given: a bound repository and no accepted preview events.
  const store = previewStore();
  const forged = signedWebhook('opened', '2026-09-03T00:00:00Z');

  // When / Then: forged HMAC and signed foreign binding cannot create state.
  assert.throws(() => store.handleGitHubWebhook({ ...forged, signature: 'sha256=' + '0'.repeat(64) }), /invalid GitHub webhook signature/);
  assert.deepEqual([store.previewLineages.size, store.deployments.size], [0, 0]);
  const foreignBinding = store.handleGitHubWebhook(signedWebhook('opened', '2026-09-03T00:00:00Z', { repositoryId: 999 }));
  assert.deepEqual([foreignBinding.matchedServiceCount, store.previewLineages.size, store.deployments.size], [0, 0, 0]);

  // Given: PR 7 and PR 8 each own an isolated lineage, plus a production resource.
  const opened = signedWebhook('opened', '2026-09-03T00:00:01Z');
  const accepted = store.handleGitHubWebhook(opened);
  const lineageId = accepted.actions[0].lineageId;
  const firstId = accepted.actions[0].deploymentId;
  const replay = store.handleGitHubWebhook(opened);
  const synchronized = store.handleGitHubWebhook(signedWebhook('synchronize', '2026-09-03T00:00:03Z', { headSha: 'b'.repeat(40) }));
  const secondId = synchronized.actions[0].deploymentId;
  const pr8 = store.createDeployment({ id: 'foreign-pr-8', serviceId: 'service', status: 'READY', deploymentType: 'preview', pullRequestNumber: 8, previewLineageId: 'foreign-pr-lineage', previewGeneration: 1 });
  const production = store.createDeployment({ id: 'production', serviceId: 'service', status: 'READY', deploymentType: 'production' });

  // When / Then: replay and reordered close cannot enqueue or delete anything.
  assert.deepEqual([replay.duplicate, replay.actions.length], [true, 0]);
  const stale = store.handleGitHubWebhook(signedWebhook('closed', '2026-09-03T00:00:02Z', { headSha: 'b'.repeat(40) }));
  assert.equal(stale.actions[0].type, 'preview-stale');
  assert.deepEqual([store.deployments.get(firstId).status, store.deployments.get(secondId).status], ['queued', 'queued']);

  // When: an authoritative close for PR 7 wins the ordering fence.
  store.handleGitHubWebhook(signedWebhook('closed', '2026-09-03T00:00:04Z', { headSha: 'b'.repeat(40) }));

  // Then: the other PR and production resource remain untouched.
  assert.deepEqual([store.previewLineages.get(lineageId).state, store.deployments.get(firstId).status, store.deployments.get(secondId).status], ['CLOSED', 'PREVIEW_CLEANUP_REQUESTED', 'PREVIEW_CLEANUP_REQUESTED']);
  assert.deepEqual([store.deployments.get(pr8.id).status, store.deployments.get(production.id).status], ['READY', 'READY']);

  // Given / When / Then: a same-timestamp close race becomes ambiguous and cannot clean up.
  const raced = previewStore();
  const raceOpen = raced.handleGitHubWebhook(signedWebhook('opened', '2026-09-03T01:00:00Z'));
  const raceDeploymentId = raceOpen.actions[0].deploymentId;
  const ambiguous = raced.handleGitHubWebhook(signedWebhook('closed', '2026-09-03T01:00:00Z'));
  assert.deepEqual([ambiguous.actions[0].type, raced.previewLineages.get(raceOpen.actions[0].lineageId).state, raced.deployments.get(raceDeploymentId).status], ['preview-resolution-enqueued', 'AMBIGUOUS', 'queued']);
});

test('orders close ambiguity and reopen without allowing old state to clear the new generation', () => {
  // Given: one open lineage and a healthy current generation.
  const opened = transitionPreviewLineage(null, event('opened', '2026-09-03T00:00:00Z'), identity, 'lineage').lineage;
  const serving = { ...opened, currentDeploymentId: 'deployment-1', currentGeneration: 1 };
  // When: a conflicting same-timestamp close, replay, then an authoritative later reopen arrive.
  const ambiguous = transitionPreviewLineage(serving, event('closed', '2026-09-03T00:00:00Z'), identity, 'lineage');
  const replay = transitionPreviewLineage(ambiguous.lineage, event('closed', '2026-09-03T00:00:00Z'), identity, 'lineage');
  const reopened = transitionPreviewLineage(ambiguous.lineage, event('reopened', '2026-09-03T00:00:01Z', 'b'.repeat(40)), identity, 'lineage');
  // Then: ambiguity enqueues once, and reopen creates a fenced new generation.
  assert.deepEqual([ambiguous.decision, ambiguous.enqueueResolver, replay.enqueueResolver], ['ambiguous', true, false]);
  assert.deepEqual([reopened.lineage.state, reopened.lineage.generation, reopened.lineage.version], ['OPEN', 2, 3]);
  assert.equal(transitionPreviewLineage(reopened.lineage, event('closed', '2026-09-02T23:59:59Z'), identity, 'lineage').decision, 'stale');
});

test('derives deployment-unique probe identity and rejects unsafe preview retry states', () => {
  const lineage = transitionPreviewLineage(null, event('opened', '2026-09-03T00:00:00Z'), identity, 'lineage').lineage;
  const runtime = createPreviewRuntime(lineage, 'deployment-1', 'example.test');
  const source = { id: 'deployment-1', serviceId: 'service', projectId: 'project', previewLineageId: 'lineage', previewRuntime: runtime, commitSha: lineage.headSha };
  assert.equal(assertPreviewRetry(lineage, source), lineage);
  assert.notEqual(runtime.probeHost, createPreviewRuntime({ ...lineage, generation: 2 }, 'deployment-2', 'example.test').probeHost);
  for (const unsafe of [null, { ...lineage, state: 'CLOSED' }, { ...lineage, state: 'AMBIGUOUS' }]) assert.throws(() => assertPreviewRetry(unsafe, source));
  assert.throws(() => assertPreviewRetry(lineage, { ...source, commitSha: 'f'.repeat(40) }));
  assert.throws(() => assertPreviewRetry(lineage, { ...source, previewRuntime: null }));
});

test('reserves resolver and apply jobs from generic workflow workers', () => {
  const lineage = transitionPreviewLineage(null, event('opened', '2026-09-03T00:00:00Z'), identity, 'lineage').lineage;
  const observation = { version: 1, lineageId: lineage.id, lineageVersion: lineage.version, installationId: '1', repositoryId: '2', pullRequestNumber: 7, state: 'open', headSha: lineage.headSha, headRef: 'topic', baseRef: 'main', updatedAt: lineage.eventUpdatedAt, observedAt: '2026-09-03T00:00:01Z' };
  assert.equal(resolverJobId(lineage), 'preview-resolve:lineage:1');
  assert.equal(applyJobId(observation), 'preview-apply:lineage:1');
  assert.deepEqual(resolverPayload(lineage), { version: 1, lineageId: 'lineage', lineageVersion: 1 });
  for (const type of [PREVIEW_RESOLVER_JOB, PREVIEW_APPLY_JOB]) assert.equal(isWorkflowJobReady({ type, status: 'queued', runAfter: 0, lockedAt: null }), false);
});

test('health keeps the lineage current while a newer candidate deploys', () => {
  const rows = [{ id: 'old', deploymentType: 'preview', previewLineageId: 'lineage', previewGeneration: 1, status: 'READY' }, { id: 'new', deploymentType: 'preview', previewLineageId: 'lineage', previewGeneration: 2, status: 'DEPLOYING' }];
  assert.equal(servingDeploymentForHealth(rows, { id: 'lineage', currentDeploymentId: 'old', currentGeneration: 1 }).id, 'old');
  assert.equal(servingDeploymentForHealth(rows, { id: 'foreign', currentDeploymentId: 'old', currentGeneration: 1 }), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyJobId, assertPreviewRetry, createPreviewRuntime, PREVIEW_APPLY_JOB, PREVIEW_RESOLVER_JOB, resolverJobId, resolverPayload, transitionPreviewLineage } from '../packages/core/src/preview-lineage.ts';
import { isWorkflowJobReady } from '../packages/core/src/workflows.ts';
import { servingDeploymentForHealth } from '../packages/core/src/deployment-health.ts';

const identity = { organizationId: 'org', projectId: 'project', serviceId: 'service', integrationId: 'integration', baseDomain: 'example.test' };
const event = (action, updatedAt, headSha = 'a'.repeat(40), beforeSha = null) => ({ deliveryId: crypto.randomUUID(), installationId: '1', repositoryId: '2', repository: 'club/repo', pullRequestNumber: 7, action, headSha, headRef: 'topic', baseRef: 'main', beforeSha, updatedAt });

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

import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { BindingObservationSchema, EvidenceBindingSchema } from '../packages/schemas/src/production-evidence.ts';

function fixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ id: 'org', name: 'Club', slug: 'club' });
  const user = store.createUser({ id: 'user', email: 'owner@example.test', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  store.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxDeploymentsPerDay: 10, maxPreviewDeployments: 10 });
  const project = store.createProject({ id: 'project', organizationId: organization.id, name: 'Project', slug: 'project' });
  const integration = store.createGitHubIntegration({ id: 'integration', organizationId: organization.id, userId: user.id });
  store.verifyGitHubIntegration({ integrationId: integration.id, installationId: '900', accountLogin: 'club' });
  store.registerGitHubRepository({ installationId: '900', githubRepoId: '101', fullName: 'club/repo' });
  const service = store.createService({ id: 'service', projectId: project.id, name: 'Web', slug: 'web', sourceType: 'image', imageUrl: `registry.test/web@sha256:${'d'.repeat(64)}` });
  store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: integration.id, repositoryId: '101', branch: 'main' });
  return store;
}
function signed(action, updatedAt, deliveryId = randomUUID()) {
  const payload = { action, number: 7, installation: { id: 900 }, repository: { id: 101, full_name: 'club/repo' }, pull_request: { number: 7, state: action === 'closed' ? 'closed' : 'open', head: { sha: 'a'.repeat(40), ref: 'topic' }, base: { ref: 'main' }, updated_at: updatedAt } };
  const body = JSON.stringify(payload); const secret = 'local-store-secret';
  return { event: 'pull_request', deliveryId, body, payload: { ignored: true }, secret, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` };
}

test('memory admission commits one immutable lineage and rolls back an enqueue failure', () => {
  const store = fixture();
  const input = signed('opened', '2026-09-03T00:00:00Z');
  const enqueue = store.enqueueWorkflowJob.bind(store);
  store.enqueueWorkflowJob = () => { throw new Error('injected persistence failure'); };
  assert.throws(() => store.handleGitHubWebhook(input), /injected persistence failure/);
  assert.deepEqual([store.previewLineages.size, store.deployments.size, store.webhookEvents.size], [0, 0, 0]);
  store.enqueueWorkflowJob = enqueue;
  const result = store.handleGitHubWebhook(input);
  assert.equal(result.actions[0].type, 'preview-deployment-enqueued');
  assert.deepEqual([store.previewLineages.size, store.deployments.size, store.workflowJobs.length], [1, 1, 1]);
  assert.equal(store.handleGitHubWebhook(input).duplicate, true);
  const lineage = [...store.previewLineages.values()][0];
  const project = store.projects.get(lineage.projectId);
  store.projects.set(project.id, { ...project, status: 'DELETING' });
  const inactive = store.handleGitHubWebhook(signed('closed', '2026-09-03T00:00:01Z'));
  assert.equal(inactive.matchedServiceCount, 0);
  assert.equal(store.previewLineages.get(lineage.id).state, 'OPEN');
});

test('memory preview webhook persists the signed canonical event before its preview deployment lineage', () => {
  // Given: an attached service and one valid GitHub pull-request delivery.
  const store = fixture();
  const input = signed('opened', '2026-09-03T00:00:00Z');
  const expectedEvent = {
    deliveryId: input.deliveryId,
    installationId: '900',
    repositoryId: '101',
    repository: 'club/repo',
    pullRequestNumber: 7,
    action: 'opened',
    headSha: 'a'.repeat(40),
    headRef: 'topic',
    baseRef: 'main',
    beforeSha: null,
    updatedAt: '2026-09-03T00:00:00Z',
  };

  // When: the signed handler accepts the delivery.
  const accepted = store.handleGitHubWebhook(input);

  // Then: the persisted delivery and the dependent deployment event retain only the canonical lineage.
  const delivery = store.webhookEvents.get(input.deliveryId);
  const deploymentEvent = store.deploymentEvents.find((row) => row.type === 'preview.workload.queued');
  assert.deepEqual(delivery.payload, expectedEvent);
  assert.equal(delivery.handled, true);
  assert.equal(accepted.webhookEvent.id, delivery.id);
  const deployment = store.deployments.get(deploymentEvent.deploymentId);
  assert.deepEqual(deploymentEvent.metadata, { source: 'github-webhook', webhookEventId: delivery.id, lineageId: deployment.previewLineageId, ...expectedEvent });
  assert.equal(JSON.stringify(delivery.payload).includes('signature'), false);
  assert.equal(JSON.stringify(delivery.payload).includes('secret'), false);
});

test('memory preview webhook accepts only exact canonical delivery retries', () => {
  // Given: one accepted delivery.
  const store = fixture();
  const input = signed('opened', '2026-09-03T00:00:00Z');
  store.handlePreviewWebhook(input);
  const before = {
    lineages: store.previewLineages.size,
    deployments: store.deployments.size,
    jobs: store.workflowJobs.length,
    events: store.deploymentEvents.length,
    audits: store.auditLogs.length,
    delivery: structuredClone(store.webhookEvents.get(input.deliveryId)),
  };

  // When / Then: the exact retry is idempotent, but a differently signed canonical payload conflicts without mutation.
  const duplicate = store.handlePreviewWebhook(input);
  assert.deepEqual(duplicate, { accepted: true, duplicate: true, deliveryId: input.deliveryId, actions: [] });
  const changed = signed('reopened', '2026-09-03T00:00:01Z', input.deliveryId);
  assert.throws(() => store.handlePreviewWebhook(changed), (error) => error?.code === 'preview_delivery_conflict' && error?.statusCode === 409);
  assert.deepEqual({ lineages: store.previewLineages.size, deployments: store.deployments.size, jobs: store.workflowJobs.length, events: store.deploymentEvents.length, audits: store.auditLogs.length, delivery: store.webhookEvents.get(input.deliveryId) }, before);
});

test('memory preview webhook rejects an invalid signature before transaction state changes', () => {
  // Given: an otherwise valid delivery with a forged signature.
  const store = fixture();
  const input = signed('opened', '2026-09-03T00:00:00Z');
  const forged = { ...input, signature: 'sha256=' + '0'.repeat(64) };
  const before = [store.previewLineages.size, store.deployments.size, store.workflowJobs.length, store.webhookEvents.size, store.deploymentEvents.length, store.auditLogs.length];

  // When / Then: HMAC parsing fails before a webhook marker or dependent work can be stored.
  assert.throws(() => store.handlePreviewWebhook(forged), (error) => error?.code === 'preview_invalid_signature' && error?.statusCode === 401);
  assert.deepEqual([store.previewLineages.size, store.deployments.size, store.workflowJobs.length, store.webhookEvents.size, store.deploymentEvents.length, store.auditLogs.length], before);
});

test('Given signed admission, When projecting persisted lineage, Then the evidence schema accepts actual server identities', () => {
  const store = fixture();
  const input = { ...signed('opened', '2026-09-03T00:00:00Z'), webhookEventId: 'caller-selected-id' };
  const accepted = store.handleGitHubWebhook(input);
  const delivery = store.webhookEvents.get(input.deliveryId);
  const queued = store.deploymentEvents.find(row => row.type === 'preview.workload.queued');
  const { source, webhookEventId, lineageId, ...event } = queued.metadata;
  const binding = EvidenceBindingSchema.parse({ kind: 'github-webhook-event', webhookEventId: delivery.id,
    provider: delivery.provider, eventType: delivery.eventType, deliveryId: delivery.deliveryId, handled: delivery.handled, event: delivery.payload });
  const observation = BindingObservationSchema.parse({ kind: 'github-pull-request-observation', observationId: 'observed-preview',
    receiptPath: 'lifecycle/preview.json', receiptSha256: '1'.repeat(64), artifactPath: 'lifecycle/preview-observation.json',
    artifactSha256: '2'.repeat(64), identityDigest: '3'.repeat(64), repositoryId: event.repositoryId,
    repository: event.repository, branch: event.headRef, tenantCommitSha: event.headSha,
    webhookEventId, deploymentId: queued.deploymentId, lineageId, event });
  assert.equal(source, 'github-webhook');
  assert.notEqual(binding.webhookEventId, input.webhookEventId);
  assert.equal(binding.webhookEventId, accepted.webhookEvent.id);
  assert.equal(observation.webhookEventId, binding.webhookEventId);
  assert.deepEqual(observation.event, binding.event);
  assert.equal(observation.deploymentId, accepted.actions[0].deploymentId);
  assert.equal(observation.lineageId, store.deployments.get(observation.deploymentId).previewLineageId);
  assert.equal(EvidenceBindingSchema.safeParse({ ...binding, deliveryId: randomUUID() }).success, false);
  assert.equal(EvidenceBindingSchema.safeParse({ ...binding, webhookEventId: 'caller-selected-id' }).success, false);
  assert.equal(BindingObservationSchema.safeParse({ ...observation, tenantCommitSha: 'b'.repeat(40) }).success, false);
  assert.equal(BindingObservationSchema.safeParse({ ...observation, lineageId: undefined }).success, false);
  assert.equal(BindingObservationSchema.safeParse({ ...observation, event: { ...event, signatureVerified: true } }).success, false);
});

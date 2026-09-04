import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

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
});

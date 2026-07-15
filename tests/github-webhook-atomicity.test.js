import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

const secret = 'github-webhook-atomicity-secret';

function signedInput(deliveryId, payload = {}) {
  const completePayload = {
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    installation: { id: 900 },
    repository: { id: 101, full_name: 'alice/web', default_branch: 'main' },
    ...payload,
  };
  const body = JSON.stringify(completePayload);
  return {
    event: 'push',
    deliveryId,
    payload: completePayload,
    body,
    signature: `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`,
    secret,
  };
}

function webhookStore(maxDeploymentsPerDay = 3) {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Alice', slug: 'alice' });
  const user = store.createUser({ email: 'alice@example.com', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  store.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxDeploymentsPerDay, maxPreviewDeployments: maxDeploymentsPerDay });
  const project = store.createProject({ organizationId: organization.id, name: 'Web', slug: 'web' });
  const integration = store.createGitHubIntegration({ organizationId: organization.id, userId: user.id, accountLogin: 'alice' });
  store.verifyGitHubIntegration({ integrationId: integration.id, installationId: '900', accountLogin: 'alice' });
  store.registerGitHubRepository({ installationId: '900', githubRepoId: '101', fullName: 'alice/web' });
  const service = store.createService({ projectId: project.id, name: 'web', sourceType: 'image', imageUrl: `registry.example/web@sha256:${'b'.repeat(64)}` });
  store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: integration.id, repositoryId: '101', branch: 'main' });
  return { store, service, integration, user };
}

test('in-memory GitHub delivery rolls back all actions and remains retryable after an enqueue failure', () => {
  const { store } = webhookStore();
  const baseline = {
    deployments: store.deployments.size,
    jobs: store.workflowJobs.length,
    events: store.deploymentEvents.length,
    audits: store.auditLogs.length,
  };
  const enqueue = store.enqueueWorkflowJob.bind(store);
  store.enqueueWorkflowJob = () => { throw new Error('simulated workflow persistence failure'); };

  assert.throws(() => store.handleGitHubWebhook(signedInput('retryable-delivery')), /simulated workflow persistence failure/);
  assert.equal(store.webhookEvents.has('retryable-delivery'), false);
  assert.equal(store.deployments.size, baseline.deployments);
  assert.equal(store.workflowJobs.length, baseline.jobs);
  assert.equal(store.deploymentEvents.length, baseline.events);
  assert.equal(store.auditLogs.length, baseline.audits);

  store.enqueueWorkflowJob = enqueue;
  const retried = store.handleGitHubWebhook(signedInput('retryable-delivery'));
  assert.equal(retried.duplicate, false);
  assert.equal(retried.actions.filter((action) => action.type === 'production-deployment-enqueued').length, 1);
});

test('GitHub delivery is accepted without enqueueing work when its integration owner has no deployment quota', () => {
  const { store } = webhookStore(0);
  const result = store.handleGitHubWebhook(signedInput('quota-blocked-delivery'));
  assert.equal(result.accepted, true);
  assert.equal(result.actions.some((action) => action.type === 'github-webhook-quota-blocked'), true);
  assert.equal(store.deployments.size, 0);
  assert.equal(store.workflowJobs.length, 0);
  assert.equal(store.webhookEvents.get('quota-blocked-delivery')?.handled, true);
});

test('Prisma GitHub delivery commits its marker, deployment, and job atomically and can replay after rollback', async () => {
  const project = { id: 'project-1', organizationId: 'organization-1', slug: 'web', status: 'ACTIVE' };
  const integration = { id: 'integration-1', organizationId: project.organizationId, userId: 'user-1', installationId: '900', verifiedAt: new Date(), accountLogin: 'alice' };
  const service = {
    id: 'service-1', projectId: project.id, project, branch: 'main', githubRepositoryId: '101', repoUrl: 'https://github.com/alice/web.git', status: 'CREATED',
    desiredState: { githubIntegrationId: integration.id, githubInstallationId: '900', githubRepositoryId: '101', githubRepository: 'alice/web', github: { integrationId: integration.id, installationId: '900', repositoryId: '101', repository: 'alice/web' } },
  };
  const state = { webhooks: new Map(), deployments: new Map(), jobs: new Map(), audits: new Map(), failWorkflow: true };
  const snapshot = () => ({
    webhooks: new Map(state.webhooks), deployments: new Map(state.deployments), jobs: new Map(state.jobs), audits: new Map(state.audits),
  });
  const restore = (saved) => {
    state.webhooks = saved.webhooks;
    state.deployments = saved.deployments;
    state.jobs = saved.jobs;
    state.audits = saved.audits;
  };
  const prisma = {
    $transaction: async (callback) => {
      const saved = snapshot();
      try { return await callback(prisma); } catch (error) { restore(saved); throw error; }
    },
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async () => [{ maxProjects: 1, maxServices: 1, maxDeploymentsPerDay: 0, maxPreviewDeployments: 0, services: [], resources: [], deployments: [], usageRecords: [] }],
    webhookEvent: {
      findUnique: async ({ where }) => state.webhooks.get(where.deliveryId) || null,
      create: async ({ data }) => { const row = { id: `webhook-${data.deliveryId}`, ...data }; state.webhooks.set(data.deliveryId, row); return row; },
      update: async ({ where, data }) => { const current = [...state.webhooks.values()].find((row) => row.id === where.id || row.deliveryId === where.deliveryId); const row = { ...current, ...data }; state.webhooks.set(row.deliveryId, row); return row; },
    },
    gitHubRepository: { findFirst: async () => ({ installationId: '900', githubRepoId: '101', fullName: 'alice/web' }) },
    gitHubIntegration: { findUnique: async ({ where }) => where.id === integration.id ? integration : null },
    user: { findUnique: async () => ({ id: 'user-1', role: 'USER', accountType: 'NON_CLUB', approvalStatus: 'APPROVED' }) },
    quota: { findFirst: async () => ({ userId: 'user-1', accountType: 'NON_CLUB', maxDeploymentsPerDay: 3, maxPreviewDeployments: 1 }) },
    service: {
      findMany: async () => [service],
      findUnique: async () => service,
    },
    project: { findUnique: async () => project },
    deployment: {
      create: async ({ data }) => { state.deployments.set(data.id, data); return data; },
      upsert: async ({ where, create }) => { const row = state.deployments.get(where.id) || create; state.deployments.set(where.id, row); return row; },
    },
    workflowJob: {
      create: async ({ data }) => {
        if (state.failWorkflow) { state.failWorkflow = false; throw new Error('simulated workflow persistence failure'); }
        const row = { id: data.id || `job-${state.jobs.size + 1}`, ...data }; state.jobs.set(row.id, row); return row;
      },
      upsert: async ({ where, create }) => {
        if (state.failWorkflow) { state.failWorkflow = false; throw new Error('simulated workflow persistence failure'); }
        const row = state.jobs.get(where.id) || create; state.jobs.set(where.id, row); return row;
      },
    },
    auditLog: {
      create: async ({ data }) => { const row = { id: data.id || `audit-${state.audits.size + 1}`, ...data }; state.audits.set(row.id, row); return row; },
      upsert: async ({ where, create }) => { const row = state.audits.get(where.id) || create; state.audits.set(where.id, row); return row; },
    },
  };
  const repository = new PrismaControlPlaneRepository(prisma);

  await assert.rejects(repository.handleGitHubWebhook(signedInput('prisma-retryable-delivery')), /simulated workflow persistence failure/);
  assert.equal(state.webhooks.size, 0);
  assert.equal(state.deployments.size, 0);
  assert.equal(state.jobs.size, 0);

  const retried = await repository.handleGitHubWebhook(signedInput('prisma-retryable-delivery'));
  assert.equal(retried.duplicate, false);
  assert.equal(state.webhooks.size, 1);
  assert.equal(state.deployments.size, 1);
  assert.equal(state.jobs.size, 1);
  assert.equal([...state.webhooks.values()][0].handled, true);
  assert.equal([...state.audits.values()][0].actorUserId, null, 'external webhook actors must not violate the AuditLog User foreign key');
  const duplicate = await repository.handleGitHubWebhook(signedInput('prisma-retryable-delivery'));
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.deployments.size, 1);
  assert.equal(state.jobs.size, 1);
});

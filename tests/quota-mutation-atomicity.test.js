import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

function approvedInMemoryRepository(limits = {}) {
  const repository = new InMemoryControlPlaneRepository();
  const organization = repository.store.createOrganization({ name: 'Quota Org', slug: 'quota-org' });
  const user = repository.store.createUser({
    email: 'quota-atomic@example.com',
    name: 'Quota User',
    approvalStatus: 'APPROVED',
    accountType: 'NON_CLUB',
  });
  repository.store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  repository.store.setQuota({ userId: user.id, accountType: 'NON_CLUB', ...limits });
  return { repository, organization, user };
}

test('in-memory project quota check and mutation are one critical section', async () => {
  const { repository, organization, user } = approvedInMemoryRepository({ maxProjects: 1 });

  const results = await Promise.allSettled([
    repository.createProject({ organizationId: organization.id, name: 'One', slug: 'one', actorUserId: user.id }),
    repository.createProject({ organizationId: organization.id, name: 'Two', slug: 'two', actorUserId: user.id }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(String(results.find((result) => result.status === 'rejected')?.reason?.message), /quota exceeded: maxProjects/);
  assert.equal(repository.store.projects.size, 1);
});

test('desired project quota failure rolls back the project and every embedded child', async () => {
  const { repository, organization, user } = approvedInMemoryRepository({
    maxProjects: 1,
    maxServices: 1,
    maxCpuMillicores: 500,
    maxMemoryMb: 512,
    maxDbStorageMb: 512,
  });

  await assert.rejects(
    repository.writeDesiredProject({
      organizationId: organization.id,
      actorUserId: user.id,
      project: { name: 'Injected', slug: 'injected', status: 'DELETING' },
      services: [
        { name: 'web', desiredSpec: { resources: { requests: { cpu: '300m', memory: '256Mi' } } } },
        { name: 'worker', desiredSpec: { resources: { requests: { cpu: '300m', memory: '256Mi' } } } },
      ],
      resources: [{ name: 'database', engine: 'postgresql', storageMb: 256 }],
    }),
    /quota exceeded: maxServices|quota exceeded: maxCpuMillicores/,
  );

  assert.equal(repository.store.projects.size, 0);
  assert.equal(repository.store.services.size, 0);
  assert.equal(repository.store.resources.size, 0);

  const written = await repository.writeDesiredProject({
    organizationId: organization.id,
    actorUserId: user.id,
    project: { name: 'Safe', slug: 'safe', status: 'DELETING' },
    services: [{ name: 'web', desiredSpec: { resources: { requests: { cpu: '250m', memory: '256Mi' } } } }],
    resources: [{ name: 'database', engine: 'postgresql', storageMb: 256 }],
  });
  assert.equal(String(written.project.status).toUpperCase(), 'ACTIVE');
});

test('deployment and rollback mutations consume deployment quotas atomically', async () => {
  const { repository, organization, user } = approvedInMemoryRepository({ maxDeploymentsPerDay: 1, maxPreviewDeployments: 1 });
  const project = repository.store.createProject({ organizationId: organization.id, name: 'Deploy', slug: 'deploy' });
  const service = repository.store.createService({ projectId: project.id, name: 'web', sourceType: 'image', imageUrl: `registry.example/web@sha256:${'a'.repeat(64)}` });

  const results = await Promise.allSettled([
    repository.createDeploymentWorkflow({ actorUserId: user.id, deployment: { projectId: project.id, serviceId: service.id, deploymentType: 'production' } }),
    repository.createDeploymentWorkflow({ actorUserId: user.id, deployment: { projectId: project.id, serviceId: service.id, deploymentType: 'production' } }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(repository.store.deployments.size, 1);

  const current = [...repository.store.deployments.values()][0];
  repository.store.updateDeployment(current.id, { status: 'READY', imageUrl: `registry.example/web@sha256:${'b'.repeat(64)}` });
  const newer = repository.store.createDeployment({ serviceId: service.id, projectId: project.id, status: 'READY', imageUrl: `registry.example/web@sha256:${'c'.repeat(64)}` });
  repository.store.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxDeploymentsPerDay: 2, maxPreviewDeployments: 1 });

  await assert.rejects(
    repository.rollbackDeployment(newer.id, { actorUserId: user.id, previousDeploymentId: current.id }),
    /quota exceeded: maxDeploymentsPerDay/,
  );
  assert.equal(repository.store.deployments.size, 2);
});

test('Prisma project mutations serialize quota reads with the write', async () => {
  const prisma = projectQuotaPrismaHarness();
  const repository = new PrismaControlPlaneRepository(prisma);

  const results = await Promise.allSettled([
    repository.createProject({ organizationId: 'org-1', name: 'One', slug: 'one', actorUserId: 'user-1' }),
    repository.createProject({ organizationId: 'org-1', name: 'Two', slug: 'two', actorUserId: 'user-1' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(String(results.find((result) => result.status === 'rejected')?.reason?.message), /quota exceeded: maxProjects/);
  assert.equal(prisma.rows.projects.length, 1);
  assert.ok(prisma.transactionOptions.every((options) => options?.isolationLevel === 'Serializable'));
  assert.ok(prisma.rows.rawQueries.some((query) => /SELECT 1::int AS "locked"\s+FROM pg_advisory_xact_lock/i.test(query)));
  assert.equal(prisma.rows.auditLogs.filter((entry) => entry.action === 'quota:block' && entry.targetId === 'maxProjects').length, 1);
});

test('quota denial remains authoritative when the audit sink is unavailable', async () => {
  const prisma = projectQuotaPrismaHarness();
  prisma.rows.projects.push({ id: 'project-existing', organizationId: 'org-1', name: 'Existing', slug: 'existing' });
  prisma.auditLog.create = async () => { throw new Error('audit unavailable'); };
  const repository = new PrismaControlPlaneRepository(prisma);

  await assert.rejects(
    repository.createProject({ organizationId: 'org-1', name: 'Blocked', slug: 'blocked', actorUserId: 'user-1' }),
    /quota exceeded: maxProjects/,
  );
  assert.equal(prisma.rows.projects.length, 1);
});

test('Nest write paths delegate quota enforcement to the atomic repository mutation', async () => {
  const source = await readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /repository\.enforceUserCan/);
  assert.match(source, /const desiredProject = \{[\s\S]*?actorUserId:\s*subject\.id[\s\S]*?writeDesiredProject\(desiredProject\)/);
  assert.match(source, /createService\(\{[\s\S]*?actorUserId:\s*subject\.id/);
  assert.match(source, /createResource\(\{[\s\S]*?actorUserId:\s*subject\.id/);
  assert.match(source, /createDeploymentWorkflow\(\{[\s\S]*?actorUserId:\s*subject\.id/);
  assert.match(source, /importGitHubRepository\(\{[\s\S]*?actorUserId:\s*subject\.id/);
});

test('in-memory cancellation atomically fences active build work and reaches a terminal state', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const organization = repository.store.createOrganization({ name: 'Cancel Org', slug: 'cancel-org' });
  const project = repository.store.createProject({ organizationId: organization.id, name: 'Cancel', slug: 'cancel' });
  const service = repository.store.createService({ projectId: project.id, name: 'web' });
  const deployment = repository.store.createDeployment({ projectId: project.id, serviceId: service.id, status: 'BUILDING' });
  const buildJob = repository.store.enqueueWorkflowJob({
    type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id,
    payload: { deploymentId: deployment.id, serviceId: service.id, projectId: project.id },
  });
  Object.assign(repository.store.workflowJobs.find((job) => job.id === buildJob.id), {
    status: 'running', lockedBy: 'builder-a', lockedAt: new Date().toISOString(), attempts: 1,
  });
  const originalRunAfter = repository.store.workflowJobs.find((job) => job.id === buildJob.id).runAfter;

  const result = await repository.cancelDeployment(deployment.id, { reason: 'operator request' });
  const fencedJob = repository.store.workflowJobs.find((job) => job.id === buildJob.id);
  assert.equal(result.deployment.status, 'CANCELLED');
  assert.ok(result.deployment.finishedAt);
  assert.equal(fencedJob.status, 'cancelled');
  assert.equal(fencedJob.lockedBy, null);
  assert.equal(fencedJob.lockedAt, null);
  assert.equal(fencedJob.runAfter, originalRunAfter);
  assert.equal(repository.store.workflowJobs.some((job) => job.type === 'deployment-cancel'), false);
  assert.equal(repository.store.deploymentEvents.some((event) => event.type === 'deployment.cancelled'), true);
});

test('Prisma cancellation locks active build work before terminal cancellation and creates no orphan workflow', async () => {
  const state = {
    deployment: { id: 'deployment-1', serviceId: 'service-1', projectId: 'project-1', status: 'BUILDING', imageUrl: null },
    workflowJobs: [{ id: 'build-job-1', type: 'build-and-deploy', targetType: 'deployment', targetId: 'deployment-1', status: 'running', lockedBy: 'builder-a', lockedAt: new Date(), runAfter: new Date() }],
    events: [],
    operations: [],
    transactionOptions: [],
  };
  const prisma = {
    async $transaction(work, options) {
      state.transactionOptions.push(options);
      return work(this);
    },
    deployment: {
      findUnique: async ({ where }) => where.id === state.deployment.id ? { ...state.deployment } : null,
      update: async ({ data }) => (state.operations.push('deployment:update'), state.deployment = { ...state.deployment, ...data }),
    },
    deploymentEvent: { create: async ({ data }) => (state.events.push(data), data) },
    workflowJob: {
      updateMany: async ({ data }) => {
        state.operations.push('workflow:update');
        state.workflowJobs = state.workflowJobs.map((job) => ({ ...job, ...data }));
        return { count: state.workflowJobs.length };
      },
      create: async () => { throw new Error('deployment cancellation must not enqueue an unhandled workflow'); },
    },
    auditLog: { create: async () => null },
  };
  const repository = new PrismaControlPlaneRepository(prisma);

  const result = await repository.cancelDeployment('deployment-1', { reason: 'operator request' });
  assert.equal(result.deployment.status, 'CANCELLED');
  assert.deepEqual(state.operations, ['workflow:update', 'deployment:update']);
  assert.equal(state.workflowJobs[0].status, 'cancelled');
  assert.equal(state.workflowJobs[0].lockedBy, null);
  assert.equal(state.events[0].type, 'deployment.cancelled');
  assert.equal(state.transactionOptions.at(-1)?.isolationLevel, 'Serializable');
});

test('cancellation rejects deployments once runtime reconciliation has started', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const organization = repository.store.createOrganization({ name: 'Late Cancel Org', slug: 'late-cancel-org' });
  const project = repository.store.createProject({ organizationId: organization.id, name: 'Late Cancel', slug: 'late-cancel' });
  const service = repository.store.createService({ projectId: project.id, name: 'web' });
  for (const status of ['DEPLOYING', 'READY', 'FAILED', 'BUILD_FAILED']) {
    const deployment = repository.store.createDeployment({ projectId: project.id, serviceId: service.id, status });
    await assert.rejects(
      repository.cancelDeployment(deployment.id, { reason: 'too late' }),
      (error) => error?.statusCode === 409 && /cannot be cancelled/i.test(error.message),
    );
    assert.equal(repository.store.getDeployment(deployment.id).status, status);
  }
});

function projectQuotaPrismaHarness() {
  const rows = { projects: [], auditLogs: [], rawQueries: [] };
  let transactionTail = Promise.resolve();
  const prisma = {
    rows,
    transactionOptions: [],
    async $transaction(work, options) {
      this.transactionOptions.push(options);
      const result = transactionTail.then(() => work(this));
      transactionTail = result.catch(() => undefined);
      return result;
    },
    async $queryRawUnsafe(query) {
      rows.rawQueries.push(query);
      if (/^\s*SELECT\s+pg_advisory_xact_lock/i.test(query)) {
        const error = new Error("Failed to deserialize column of type 'void'");
        error.code = 'P2010';
        throw error;
      }
      if (/pg_advisory_xact_lock/i.test(query)) return [{ locked: 1 }];
      return [{
        maxProjects: rows.projects.length,
        maxServices: 0,
        maxDeploymentsPerDay: 0,
        maxPreviewDeployments: 0,
        services: [],
        resources: [],
        deployments: [],
        usageRecords: [],
      }];
    },
    user: {
      findUnique: async ({ where }) => where.id === 'user-1'
        ? { id: 'user-1', approvalStatus: 'APPROVED', accountType: 'NON_CLUB', role: 'MEMBER' }
        : null,
    },
    quota: {
      findFirst: async () => ({ id: 'quota-user-1', userId: 'user-1', accountType: 'NON_CLUB', maxProjects: 1 }),
      upsert: async () => ({ id: 'quota-user-1', userId: 'user-1', accountType: 'NON_CLUB', maxProjects: 1 }),
    },
    membership: {
      findMany: async () => [{ organizationId: 'org-1' }],
    },
    project: {
      findMany: async () => rows.projects.map(({ id }) => ({ id })),
      findUnique: async ({ where }) => rows.projects.find((project) => project.organizationId === where.organizationId_slug.organizationId && project.slug === where.organizationId_slug.slug) || null,
      upsert: async ({ where, update, create }) => {
        const existing = rows.projects.find((project) => project.organizationId === where.organizationId_slug.organizationId && project.slug === where.organizationId_slug.slug);
        if (existing) return Object.assign(existing, update);
        const row = { id: `project-${rows.projects.length + 1}`, ...create, createdAt: new Date(), updatedAt: new Date() };
        rows.projects.push(row);
        return row;
      },
    },
    service: { findMany: async () => [] },
    resource: { findMany: async () => [] },
    deployment: { findMany: async () => [] },
    usageRecord: { findMany: async () => [] },
    auditLog: { create: async ({ data }) => (rows.auditLogs.push(data), data) },
  };
  return prisma;
}

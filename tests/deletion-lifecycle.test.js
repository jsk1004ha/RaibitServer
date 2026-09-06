import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

test('Prisma project deletion creates idempotent child tombstones without hard deletes', async () => {
  const fake = deletionPrisma();
  const repository = new PrismaControlPlaneRepository(fake.prisma);

  const first = await repository.deleteProject('project-1');
  const requestedAt = first.deletionRequestedAt;
  const second = await repository.deleteProject('project-1');

  assert.equal(first.status, 'DELETE_REQUESTED');
  assert.equal(second.status, 'DELETE_REQUESTED');
  assert.equal(second.deletionRequestedAt, requestedAt, 'a repeated request must not reset the lease clock');
  assert.deepEqual(fake.state.services.map((row) => row.status), ['DELETE_REQUESTED', 'DELETE_REQUESTED']);
  assert.deepEqual(fake.state.resources.map((row) => row.status), ['DELETE_REQUESTED']);
  assert.equal(fake.state.deployments[0].status, 'CANCELLED');
  assert.equal(fake.state.deployments[0].reconcileAction, null);
  assert.equal(fake.state.deployments[0].reconcileLockedBy, null);
  assert.equal(fake.state.deployments[0].reconcileLockedAt, null);
  assert.equal(fake.state.workflowJobs[0].status, 'cancelled');
  assert.equal(fake.hardDeletes.length, 0);
  assert.equal(fake.state.services.length, 2, 'children must remain until reconcilers finalize them');
  assert.equal(fake.state.resources.length, 1, 'resources must remain until provider cleanup succeeds');
  assert.equal(fake.state.attachments.length, 0, 'resource injections must be revoked when a project requests child deletion');
  assert.deepEqual(fake.state.secretValues.map((row) => row.id), ['provider-secret-1'], 'provider cleanup metadata must survive the project request');
  assert.equal(fake.state.auditLogs.filter((row) => row.action === 'project:delete-requested').length, 2);
});

test('Prisma service deletion is a tombstone and cancels active deployment work', async () => {
  const fake = deletionPrisma();
  const repository = new PrismaControlPlaneRepository(fake.prisma);

  const service = await repository.deleteService('service-1');

  assert.equal(service.status, 'DELETE_REQUESTED');
  assert.equal(fake.state.services.length, 2);
  assert.equal(fake.state.deployments[0].status, 'CANCELLED');
  assert.equal(fake.state.workflowJobs[0].status, 'cancelled');
  assert.equal(fake.hardDeletes.length, 0);
});

test('Prisma resource deletion revokes attachments but retains provider cleanup secrets', async () => {
  const fake = deletionPrisma();
  const repository = new PrismaControlPlaneRepository(fake.prisma);

  const resource = await repository.deleteResource('resource-1');

  assert.equal(resource.status, 'DELETE_REQUESTED');
  assert.equal(resource.connectionSecretName, 'provider-secret-1');
  assert.equal(fake.state.attachments.length, 0);
  assert.equal(fake.state.environmentVariables.length, 0);
  assert.deepEqual(fake.state.secretValues.map((row) => row.id), ['provider-secret-1']);
  assert.equal(fake.hardDeletes.length, 0);
});

test('the in-memory repository keeps synchronous local hard-delete compatibility', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Local', slug: 'local' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'Demo', slug: 'demo' });
  const service = await repository.createService({ projectId: project.id, name: 'web', slug: 'web', type: 'web' });

  const deleted = await repository.deleteService(service.id);

  assert.equal(deleted.id, service.id);
  assert.equal(await repository.getService(service.id), null);
});

test('schema and migration expose indexed deletion leases for all external objects', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  for (const model of ['Project', 'Service', 'Resource']) {
    const start = schema.indexOf(`model ${model} {`);
    const block = schema.slice(start, schema.indexOf('\n}', start));
    assert.match(block, /deletionRequestedAt\s+DateTime\?/);
    assert.match(block, /@@index\(\[status, updatedAt, createdAt\]\)/);
  }
  const migration = await readFile(new URL('../prisma/migrations/000004_deletion_lifecycle/migration.sql', import.meta.url), 'utf8');
  assert.match(migration, /WHERE UPPER\(status\) IN \('DELETE_REQUESTED', 'DELETING'\)/);
  assert.match(migration, /Project_deletion_claim_idx/);
  assert.match(migration, /Service_deletion_claim_idx/);
  assert.match(migration, /Resource_deletion_claim_idx/);
});

test('Prisma rejects new or mutating work beneath deletion tombstones', async () => {
  const fake = deletionPrisma();
  const repository = new PrismaControlPlaneRepository(fake.prisma);
  const conflict = (error) => error?.statusCode === 409 && /delet/i.test(error.message);
  fake.state.projects[0].status = 'DELETE_REQUESTED';

  await assert.rejects(() => repository.createService({ projectId: 'project-1', name: 'late', slug: 'late' }), conflict);
  await assert.rejects(() => repository.createResource({ projectId: 'project-1', name: 'late-db', engine: 'postgresql' }), conflict);
  await assert.rejects(() => repository.updateProject('project-1', { name: 'resurrected' }), conflict);

  fake.state.projects[0].status = 'ACTIVE';
  fake.state.services[0].status = 'DELETING';
  await assert.rejects(() => repository.updateService('service-1', { name: 'changed' }), conflict);
  await assert.rejects(() => repository.createDeployment({ serviceId: 'service-1', projectId: 'project-1' }), conflict);

  fake.state.services[0].status = 'READY';
  fake.state.resources[0].status = 'DELETE_REQUESTED';
  await assert.rejects(() => repository.updateResource('resource-1', { plan: 'larger' }), conflict);
  await assert.rejects(() => repository.attachResource({ resourceId: 'resource-1', serviceId: 'service-1' }), conflict);
  await assert.rejects(() => repository.provisionResourceProvider({ resourceId: 'resource-1', intent: 'live-provision' }), conflict);
});

test('desired-project upserts cannot resurrect a deleting project', async () => {
  const fake = deletionPrisma();
  const repository = new PrismaControlPlaneRepository(fake.prisma);
  fake.state.projects[0].status = 'DELETING';

  await assert.rejects(
    () => repository.writeDesiredProject({ organizationId: 'org-1', name: 'Demo', slug: 'demo', services: [{ name: 'late' }] }),
    (error) => error?.statusCode === 409 && /project is being deleted/i.test(error.message),
  );
});

test('desired-project upserts cannot resurrect deleting child services or resources', async () => {
  const fake = deletionPrisma();
  const repository = new PrismaControlPlaneRepository(fake.prisma);
  fake.state.services[0].status = 'DELETE_REQUESTED';
  await assert.rejects(
    () => repository.writeDesiredProject({ organizationId: 'org-1', name: 'Demo', slug: 'demo', services: [{ name: 'service-1', slug: 'service-1' }] }),
    (error) => error?.statusCode === 409 && /service is being deleted/i.test(error.message),
  );

  fake.state.services[0].status = 'READY';
  fake.state.resources[0].status = 'DELETING';
  await assert.rejects(
    () => repository.writeDesiredProject({ organizationId: 'org-1', name: 'Demo', slug: 'demo', resources: [{ name: 'resource-1', engine: 'postgresql' }] }),
    (error) => error?.statusCode === 409 && /resource is being deleted/i.test(error.message),
  );

  const source = await readFile(new URL('../packages/core/src/persistence.ts', import.meta.url), 'utf8');
  const prismaRepositoryStart = source.indexOf('export class PrismaControlPlaneRepository');
  const writerStart = source.indexOf('async writeDesiredProject', prismaRepositoryStart);
  const writer = source.slice(writerStart, source.indexOf('async snapshot', writerStart));
  assert.match(writer, /select:\s*\{[^}]*connectionSecretName:\s*true[^}]*status:\s*true[^}]*deletionRequestedAt:\s*true[^}]*\}/);
});

test('Nest delete responses distinguish durable tombstones from local hard deletes', async () => {
  const source = await readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  for (const method of ['deleteProject', 'deleteService', 'deleteResource']) {
    const start = source.indexOf(`async ${method}(`);
    const block = source.slice(start, source.indexOf('\n  }', start) + 4);
    assert.match(block, /deletionRequested:\s*true/);
    assert.match(block, /status:/);
    assert.match(block, /deleted:\s*true/);
  }
});

test('Nest mutation endpoints translate repository tombstone conflicts to HTTP conflicts', async () => {
  const source = await readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  for (const method of ['updateProject', 'addService', 'updateService', 'addResource', 'updateResource', 'attachResource', 'provisionResource', 'createDeployment']) {
    const start = source.indexOf(`async ${method}`);
    const block = source.slice(start, source.indexOf('\n  }', start) + 4);
    assert.match(block, /repositoryMutation\(/, `${method} must map repository statusCode=409 to ConflictException`);
  }
});

test('Prisma race-prone mutations share the serializable tombstone boundary', async () => {
  const source = await readFile(new URL('../packages/core/src/persistence.ts', import.meta.url), 'utf8');
  const prismaStart = source.indexOf('export class PrismaControlPlaneRepository');
  const retryHelperStart = source.indexOf('async function serializableTransactionWithRetry');
  const retryHelper = source.slice(retryHelperStart, source.indexOf('\nasync function ', retryHelperStart + 20));
  assert.match(retryHelper, /isolationLevel:\s*'Serializable'/, 'retrying transactions must preserve Serializable isolation');
  for (const method of ['updateProject', 'updateResource', 'attachProviderConnectionSecrets', 'createDeployment', 'updateService', 'createDeploymentWorkflow', 'upsertServiceEnvironment', 'attachResource']) {
    const start = source.indexOf(`  async ${method}`, prismaStart);
    const end = source.indexOf('\n  async ', start + 8);
    const block = source.slice(start, end < 0 ? source.length : end);
    const directTransaction = /this\.prisma\.\$transaction\(/.test(block);
    const retryingTransaction = /serializableTransactionWithRetry\(this\.prisma/.test(block);
    assert.equal(directTransaction || retryingTransaction, true, `${method} must make the mutable check and write atomic`);
    if (directTransaction) assert.match(block, /isolationLevel:\s*'Serializable'/, `${method} must serialize against deletion requests`);
  }
});

function deletionPrisma() {
  const hardDeletes = [];
  const state = {
    projects: [{ id: 'project-1', organizationId: 'org-1', name: 'Demo', slug: 'demo', status: 'ACTIVE', deletionRequestedAt: null }],
    services: [
      { id: 'service-1', projectId: 'project-1', status: 'READY', deletionRequestedAt: null },
      { id: 'service-2', projectId: 'project-1', status: 'CREATED', deletionRequestedAt: null },
    ],
    resources: [{ id: 'resource-1', projectId: 'project-1', name: 'resource-1', engine: 'postgresql', status: 'READY', deletionRequestedAt: null, connectionSecretName: 'provider-secret-1' }],
    deployments: [{ id: 'deployment-1', projectId: 'project-1', serviceId: 'service-1', status: 'QUEUED', finishedAt: null, reconcileAction: 'apply', reconcileLockedBy: 'worker-a', reconcileLockedAt: new Date('2026-01-01T00:00:00Z') }],
    workflowJobs: [{ id: 'workflow-1', targetType: 'deployment', targetId: 'deployment-1', status: 'queued' }],
    attachments: [{ id: 'attachment-1', resourceId: 'resource-1', serviceId: 'service-1', injectedEnv: { DATABASE_URL: '****' } }],
    environmentVariables: [{ id: 'env-1', serviceId: 'service-1', key: 'DATABASE_URL', source: 'resource:resource-1', secretRef: 'injected-secret-1' }],
    secretValues: [
      { id: 'provider-secret-1', scopeType: 'resource-provider-connection', scopeId: 'resource-1' },
      { id: 'injected-secret-1', scopeType: 'environment', scopeId: 'service-1' },
    ],
    auditLogs: [],
  };
  const find = (rows, id) => rows.find((row) => row.id === id) || null;
  const matchesWhere = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((candidate) => matchesWhere(row, candidate));
    if (key === 'AND') return value.every((candidate) => matchesWhere(row, candidate));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('notIn' in value) return !value.notIn.includes(row[key]);
    }
    return row[key] === value;
  });
  const updateMany = (rows) => async ({ where, data }) => {
    let count = 0;
    for (const row of rows) {
      if (!matchesWhere(row, where)) continue;
      Object.assign(row, data);
      count += 1;
    }
    return { count };
  };
  const deleteMany = (rows) => async ({ where }) => {
    let count = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!matchesWhere(rows[index], where)) continue;
      rows.splice(index, 1);
      count += 1;
    }
    return { count };
  };
  const hardDelete = (model) => async () => {
    hardDeletes.push(model);
    throw new Error(`${model}.delete must not be called by a deletion request`);
  };
  const prisma = {
    project: {
      findUnique: async ({ where }) => where.id
        ? find(state.projects, where.id)
        : state.projects.find((row) => row.organizationId === where.organizationId_slug?.organizationId && row.slug === where.organizationId_slug?.slug) || null,
      updateMany: updateMany(state.projects),
      update: async () => { throw new Error('project mutation reached'); },
      upsert: async () => state.projects[0],
      delete: hardDelete('project'),
    },
    service: {
      findUnique: async ({ where }) => where.id
        ? find(state.services, where.id)
        : state.services.find((row) => row.projectId === where.projectId_slug?.projectId && row.id === where.projectId_slug?.slug) || null,
      findMany: async ({ where = {} } = {}) => state.services.filter((row) => matchesWhere(row, where)),
      updateMany: updateMany(state.services),
      update: async () => { throw new Error('service mutation reached'); },
      upsert: async () => { throw new Error('service mutation reached'); },
      delete: hardDelete('service'),
    },
    resource: {
      findUnique: async ({ where }) => where.id
        ? find(state.resources, where.id)
        : state.resources.find((row) => row.projectId === where.projectId_name?.projectId && row.name === where.projectId_name?.name) || null,
      findMany: async ({ where = {} } = {}) => state.resources.filter((row) => matchesWhere(row, where)),
      updateMany: updateMany(state.resources),
      update: async () => { throw new Error('resource mutation reached'); },
      upsert: async () => { throw new Error('resource mutation reached'); },
      delete: hardDelete('resource'),
    },
    deployment: {
      create: async () => { throw new Error('deployment mutation reached'); },
      findMany: async ({ where = {} } = {}) => state.deployments.filter((row) => matchesWhere(row, where)),
      updateMany: updateMany(state.deployments),
    },
    workflowJob: { updateMany: updateMany(state.workflowJobs) },
    resourceAttachment: {
      findMany: async ({ where = {} } = {}) => state.attachments.filter((row) => matchesWhere(row, where)),
      deleteMany: deleteMany(state.attachments),
    },
    environmentVariable: {
      findMany: async ({ where = {} } = {}) => state.environmentVariables.filter((row) => matchesWhere(row, where)),
      deleteMany: deleteMany(state.environmentVariables),
    },
    secretValue: {
      findMany: async ({ where = {} } = {}) => state.secretValues.filter((row) => matchesWhere(row, where)),
      deleteMany: deleteMany(state.secretValues),
    },
    auditLog: { create: async ({ data }) => (state.auditLogs.push(data), data) },
    organization: {
      findUnique: async ({ where }) => where.id === 'org-1' ? { id: 'org-1', slug: 'org-1', name: 'Org' } : null,
    },
  };
  prisma.$queryRawUnsafe = async (query, ...values) => {
    if (query.includes('FROM "ResourceRecoveryPin"')) return [];
    if (query.includes('SELECT p."organizationId"')) {
      const [projectId, resourceId] = values;
      const project = projectId
        ? find(state.projects, projectId)
        : state.projects.find((row) => row.id === find(state.resources, resourceId)?.projectId);
      return project ? [{ organizationId: project.organizationId, projectId: project.id }] : [];
    }
    if (query.includes('FROM "Resource" WHERE "projectId"')) {
      const [projectId, resourceId] = values;
      return state.resources.filter((row) => row.projectId === projectId && (!resourceId || row.id === resourceId)).map(({ id }) => ({ id }));
    }
    return [];
  };
  prisma.$transaction = async (operation) => operation(prisma);
  return { prisma, state, hardDeletes };
}

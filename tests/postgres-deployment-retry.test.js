import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const require = createRequire(import.meta.url);

test('Prisma deployment retry sends SQL NULL preview identity for a production successor', async () => {
  // Given: a production source whose immutable successor has no preview lineage.
  const source = {
    id: 'production-source', serviceId: 'service', projectId: 'project', status: 'BUILD_FAILED',
    deploymentType: 'production', branch: 'main', commitSha: 'a'.repeat(40), commitHash: 'a'.repeat(40),
    snapshotVersion: 1, desiredSpecSnapshot: { port: 3000 }, previewLineageId: null, previewGeneration: null, previewRuntime: null,
  };
  const deploymentWrites = [];
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    service: { findUnique: async () => ({ id: 'service', projectId: 'project', status: 'ACTIVE' }) },
    project: { findUnique: async () => ({ id: 'project', status: 'ACTIVE' }) },
    deployment: {
      findUnique: async ({ where }) => where.serviceId_requestIdempotencyKey ? null : (where.id === source.id ? source : null),
      findFirst: async () => null,
      create: async ({ data }) => { deploymentWrites.push(data); return data; },
    },
    workflowJob: { create: async ({ data }) => data },
    deploymentEvent: { create: async ({ data }) => data },
  };
  const repository = new PrismaControlPlaneRepository({ ...tx, $transaction: async callback => callback(tx) });

  // When: the durable retry path constructs its Prisma create input.
  await repository.createDeploymentOperation({ operation: 'retry', sourceDeploymentId: source.id, serviceId: source.serviceId, requestIdempotencyKey: 'production-retry', snapshotVersion: 1, requestedByUserId: 'system' });

  // Then: absence remains SQL NULL (omitted JSON field), never Prisma JsonNull.
  assert.equal(deploymentWrites.length, 1);
  assert.equal(deploymentWrites[0].deploymentType, 'production');
  assert.equal(deploymentWrites[0].previewLineageId, null);
  assert.equal(deploymentWrites[0].previewGeneration, null);
  assert.equal(Object.hasOwn(deploymentWrites[0], 'previewRuntime'), false);
});

test('retry and redeploy immutable lineage / deployment retry adversarial matrix on real PostgreSQL with 20 connections', async t => {
  // Given: a UUID-owned migrated schema and twenty independent database clients.
  assert.equal(typeof PrismaControlPlaneRepository.prototype.createDeploymentOperation, 'function');
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'real disposable PostgreSQL URL required');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL });
  const schema = `lineage_t15_${randomUUID().replaceAll('-', '')}`;
  const repositories = [];
  t.after(async () => {
    await Promise.all(repositories.map(repository => repository.disconnect()));
    try { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
    t.diagnostic(JSON.stringify({ cleanup: 'PASS', schema }));
  });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.RAIBITSERVER_TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  const migrate = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 120000 });
  assert.equal(migrate.status, 0, 'isolated schema migration succeeds');
  for (let index = 0; index < 20; index++) repositories.push(await PrismaControlPlaneRepository.connect({ env: { ...process.env, RAIBITSERVER_DB_POOL_SIZE: '1' }, prismaOptions: { datasourceUrl: url.href, transactionOptions: { maxWait: 30000, timeout: 30000 } } }));
  const repository = repositories[0];
  const organization = await repository.createOrganization({ name: 'Lineage', slug: 'lineage' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', type: 'web', image: 'example/app:v1', desiredSpec: { port: 3000 } });
  const source = await repository.createDeployment({ serviceId: service.id, projectId: project.id, status: 'BUILD_FAILED', commitSha: 'a'.repeat(40) });
  await repository.prisma.deploymentEvent.create({ data: { deploymentId: source.id, type: 'build.failed', message: 'Original failure event', metadata: { exitCode: 1 } } });
  const before = JSON.stringify(await repository.getDeployment(source.id));
  const eventsBefore = JSON.stringify(await repository.prisma.deploymentEvent.findMany({ where: { deploymentId: source.id } }));
  // When: twenty identical operations enter through independent real connections.
  const input = { operation: 'retry', sourceDeploymentId: source.id, serviceId: service.id, requestIdempotencyKey: 'pg-same-key', snapshotVersion: 1, requestedByUserId: 'system' };
  const results = await Promise.all(repositories.map(candidate => candidate.createDeploymentOperation(input)));
  // Then: one deployment/job is durable and the failed source is unchanged.
  assert.equal(new Set(results.map(result => result.deployment.id)).size, 1);
  assert.equal(new Set(results.map(result => result.workflowJob.id)).size, 1);
  assert.equal(await repository.prisma.deployment.count({ where: { sourceDeploymentId: source.id } }), 1);
  assert.equal(await repository.prisma.workflowJob.count({ where: { targetId: results[0].deployment.id } }), 1);
  assert.equal(JSON.stringify(await repository.getDeployment(source.id)), before);
  assert.equal(JSON.stringify(await repository.prisma.deploymentEvent.findMany({ where: { deploymentId: source.id } })), eventsBefore);
  t.diagnostic(JSON.stringify({ consumers: 20, successors: 1, durableJobs: 1, originalBytesUnchanged: true }));
  await t.test('deployment retry adversarial matrix durable rollback and key conflict', async () => {
    // Given: a durable winner and a key reused with a different request payload.
    // When / Then: key conflict and active, foreign, stale sources leave counts unchanged.
    await assert.rejects(repository.createDeploymentOperation({ ...input, snapshotVersion: 2 }), error => error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409);
    await assert.rejects(repository.createDeploymentOperation({ ...input, requestIdempotencyKey: 'distinct-active' }), error => error.code === 'ACTIVE_DEPLOYMENT');
    await assert.rejects(repository.createDeploymentOperation({ ...input, serviceId: 'foreign' }), error => error.statusCode === 404);
    await repository.prisma.deployment.update({ where: { id: results[0].deployment.id }, data: { status: 'FAILED' } });
    await assert.rejects(repository.createDeploymentOperation({ ...input, requestIdempotencyKey: 'stale', snapshotVersion: 2 }), error => error.code === 'STALE_SNAPSHOT');
    for (const status of ['BUILDING', 'CANCELLED', 'CLEANED_UP']) {
      await repository.prisma.deployment.update({ where: { id: source.id }, data: { status } });
      await assert.rejects(repository.createDeploymentOperation({ ...input, requestIdempotencyKey: 'invalid-state' }), error => error.code === 'SOURCE_INELIGIBLE');
    }
    await repository.prisma.deployment.update({ where: { id: source.id }, data: { status: 'BUILD_FAILED' } });
    const counts = [await repository.prisma.deployment.count(), await repository.prisma.workflowJob.count(), await repository.prisma.deploymentEvent.count()];
    // A real database CHECK failure occurs after deployment INSERT, before job commit.
    await repository.prisma.$executeRawUnsafe('ALTER TABLE "WorkflowJob" ADD CONSTRAINT "t15_job_failure" CHECK ("type" <> \'build-and-deploy\') NOT VALID');
    await assert.rejects(repository.createDeploymentOperation({ ...input, requestIdempotencyKey: 'crash' }));
    await repository.prisma.$executeRawUnsafe('ALTER TABLE "WorkflowJob" DROP CONSTRAINT "t15_job_failure"');
    assert.deepEqual([await repository.prisma.deployment.count(), await repository.prisma.workflowJob.count(), await repository.prisma.deploymentEvent.count()], counts);
    const recovered = await repository.createDeploymentOperation({ ...input, requestIdempotencyKey: 'crash' });
    assert.equal(recovered.deployment.status, 'queued');
    assert.equal(await repository.prisma.workflowJob.count({ where: { targetId: recovered.deployment.id } }), 1);
    t.diagnostic(JSON.stringify({ databaseCheckFailureInjected: true, orphanDeployments: 0, orphanJobs: 0, sameKeyRecovery: true }));
  });
});

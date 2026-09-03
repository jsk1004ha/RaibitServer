import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaControlPlaneRepository } from '../../packages/core/src/persistence.ts';

assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'owned real PostgreSQL database required');
const client = new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL });
const repository = new PrismaControlPlaneRepository(client);
try {
  // Given: the runner has applied migrations 1-12 in a UUID-owned empty database.
  await client.$executeRawUnsafe(`INSERT INTO "Organization" ("id", "name", "slug", "updatedAt") VALUES ('o', 'Health', 'health', NOW())`);
  await client.$executeRawUnsafe(`INSERT INTO "Project" ("id", "organizationId", "name", "slug", "updatedAt") VALUES ('p', 'o', 'Health', 'health', NOW())`);
  await client.$executeRawUnsafe(`INSERT INTO "Service" ("id", "projectId", "name", "slug", "type", "sourceType", "updatedAt") VALUES ('s', 'p', 'Legacy', 'legacy', 'web', 'image', NOW())`);
  await client.$executeRawUnsafe(`INSERT INTO "Deployment" ("id", "projectId", "serviceId", "status", "updatedAt") VALUES ('d', 'p', 's', 'FAILED', NOW())`);
  const oldQuery = 'SELECT "id", "projectId", "serviceId", "status", "createdAt", "updatedAt" FROM "Deployment" WHERE "id" = \'d\'';
  const before = await client.$queryRawUnsafe(oldQuery);
  // When: additive 13 is applied to existing rows, with no historical migration rewrite.
  const sql = readFileSync(new URL('../../prisma/migrations/000013_deployment_health/migration.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await client.$executeRawUnsafe(statement);
  // Then: old named-column reader/writer stays valid and inherited fields receive safe defaults.
  assert.deepEqual(await client.$queryRawUnsafe(oldQuery), before);
  await client.$executeRawUnsafe(`UPDATE "Deployment" SET "status" = 'BUILD_FAILED' WHERE "id" = 'd'`);
  assert.equal((await repository.getDeployment('d')).publicHealthStatus, 'UNKNOWN');
  assert.equal((await repository.getDeployment('d')).observedGeneration, null);
  console.log(JSON.stringify({ scenario: 'additive13', previousRowsPreserved: true, nMinusOneNamedColumnWriter: true, defaultStatus: 'UNKNOWN', migration13: 'PASS' }));

  // Given / When: repository create and explicit clear cross the real generated Prisma adapter.
  const service = await repository.createService({ projectId: 'p', name: 'Web', type: 'web', sourceType: 'image', image: 'example/app:v1', healthCheck: { path: '/common' }, readinessPath: '/ready', publicHealthPath: '/public' });
  assert.equal(service.healthCheckPath, '/common');
  assert.equal(service.desiredSpec.healthCheckPath, '/common');
  const source = await repository.createDeployment({ serviceId: service.id, status: 'FAILED', imageUrl: `example/app@sha256:${'a'.repeat(64)}` });
  await repository.updateService(service.id, { healthCheckPath: null, livenessPath: '/alive' });
  const read = await repository.getService(service.id);
  for (const row of [read, read.desiredSpec, read.desiredState]) {
    assert.equal(row.healthCheckPath, null);
    assert.equal(row.livenessPath, '/alive');
  }
  assert.equal(read.desiredSpec.healthCheck, null);
  assert.equal(read.desiredState.healthCheck, null);
  assert.equal((await repository.getDeployment(source.id)).desiredSpecSnapshot.healthCheckPath, '/common');
  await client.deployment.update({ where: { id: source.id }, data: { publicHealthStatus: 'DEGRADED', healthFailureCode: 'PUBLIC_HEALTH_TIMEOUT', observedGeneration: 7, healthCheckedAt: new Date('2026-01-01T00:00:00Z') } });
  const retry = await repository.createDeploymentOperation({ operation: 'retry', serviceId: service.id, sourceDeploymentId: source.id, requestIdempotencyKey: 'health-successor', snapshotVersion: 1, requestedByUserId: 'system' });
  assert.equal(retry.deployment.publicHealthStatus, 'UNKNOWN');
  assert.equal(retry.deployment.observedGeneration, null);
  assert.equal(retry.deployment.healthFailureCode, null);
  assert.equal(retry.deployment.healthCheckedAt, null);
  assert.equal(retry.deployment.desiredSpecSnapshot.healthCheckPath, '/common');
  await repository.updateDeployment(source.id, { publicHealthStatus: 'HEALTHY', observedGeneration: 999 });
  assert.equal((await repository.getDeployment(source.id)).observedGeneration, 7);
  await client.deployment.update({ where: { id: source.id }, data: { publicHealthStatus: null } });
  assert.equal((await repository.getDeployment(source.id)).publicHealthStatus, 'UNKNOWN');
  assert.equal((await repository.listDeploymentsForService(service.id)).find(row => row.id === source.id).publicHealthStatus, 'UNKNOWN');
  const privateService = await repository.createService({ projectId: 'p', name: 'Private', type: 'private', sourceType: 'image' });
  await assert.rejects(repository.updateService(privateService.id, { publicHealthPath: '/health' }), { statusCode: 400 });
  console.log(JSON.stringify({ scenario: 'Prisma-fields', scalarDesiredStateParity: true, immutableSnapshot: true, successorUnknown: true, unforgeableGeneration: true, nullReadUnknown: true, nonWebRejected: true }));

  // Given: health jobs sort before ordinary work; existing retry job is already completed.
  await client.workflowJob.updateMany({ data: { status: 'succeeded' } });
  const health = await repository.enqueueWorkflowJob({ type: 'public-health-observe', targetType: 'deployment', targetId: source.id, runAfter: '2020-01-01' });
  const build = await repository.enqueueWorkflowJob({ type: 'build-and-deploy', targetId: source.id, runAfter: '2020-01-02' });
  // When / Then: generic Prisma claims skip the reserved type and leave its bytes untouched.
  assert.equal((await repository.claimNextWorkflowJob()).id, build.id);
  assert.equal(await repository.claimNextWorkflowJob(), null);
  assert.deepEqual(await client.workflowJob.findUnique({ where: { id: health.id } }), health);

  // Given: real DB type changes after SELECT but before the compare-and-set UPDATE.
  await client.workflowJob.update({ where: { id: build.id }, data: { type: 'build-and-deploy', status: 'queued', lockedAt: null } });
  const racing = client.$extends({ query: { workflowJob: { async findFirst({ args, query }) {
    const selected = await query(args);
    if (selected) await client.workflowJob.update({ where: { id: selected.id }, data: { type: 'public-health-observe' } });
    return selected;
  } } } });
  // When: an actual SQL update races the generic claim CAS.
  const claimed = await new PrismaControlPlaneRepository(racing).claimNextWorkflowJob();
  // Then: UPDATE's type predicate also fences ownership; neither health row gets consumed.
  assert.equal(claimed, null);
  assert.equal((await client.workflowJob.findUnique({ where: { id: build.id } })).status, 'queued');
  console.log(JSON.stringify({ scenario: 'Prisma-claim-boundary', findFirstSkip: true, updateManyRaceFence: true, healthUntouched: true }));
} finally {
  await client.$disconnect();
  console.log(JSON.stringify({ clientDisconnected: true, databaseCleanup: 'runner EXIT trap' }));
}

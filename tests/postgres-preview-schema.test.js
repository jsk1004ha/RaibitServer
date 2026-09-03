import test from 'node:test';
import assert from 'node:assert/strict';

test('schema15 permits exact preview ownership and rejects foreign pointers and mutation', async t => {
  // Given: an exclusively owned database migrated through schema15.
  const { PrismaClient } = await import(process.env.RAIBITSERVER_TEST_PRISMA_MODULE);
  const db = new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL });
  t.after(() => db.$disconnect());
  await db.organization.create({ data: { id: 'schema-org', name: 'schema', slug: 'schema' } });
  await db.project.create({ data: { id: 'schema-project', organizationId: 'schema-org', name: 'schema', slug: 'schema' } });
  await db.service.create({ data: { id: 'schema-service', projectId: 'schema-project', name: 'web', slug: 'web', type: 'web', sourceType: 'github' } });
  await db.gitHubIntegration.create({ data: { id: 'schema-integration', organizationId: 'schema-org', installationId: '1', verifiedAt: new Date() } });
  const lineage = { id: 'schema-lineage', organizationId: 'schema-org', projectId: 'schema-project', serviceId: 'schema-service', integrationId: 'schema-integration', installationId: '1', repositoryId: '2', repository: 'a/b', pullRequestNumber: 1, stableHost: 'preview--pr-1--schema--schema.example.test', namespace: 'schema', routeName: 'route', state: 'OPEN', generation: 1, eventUpdatedAt: new Date('2026-09-01T00:00:00Z'), eventAction: 'opened', headSha: 'a'.repeat(40), headRef: 'pr', baseRef: 'main' };
  await db.previewLineage.create({ data: lineage });
  const attempt = { id: 'schema-attempt', serviceId: lineage.serviceId, projectId: lineage.projectId, deploymentType: 'preview', previewLineageId: lineage.id, previewGeneration: 1, previewRuntime: { version: 1, lineageId: lineage.id, deploymentId: 'schema-attempt', generation: 1 } };
  await db.deployment.create({ data: attempt });
  // When: exact pointer and invalid foreign, immutable, monotonic updates reach SQL.
  await db.previewLineage.update({ where: { id: lineage.id }, data: { candidateDeploymentId: attempt.id, candidateGeneration: 1 } });
  await assert.rejects(db.previewLineage.update({ where: { id: lineage.id }, data: { stableHost: 'foreign.example.test' } }), /PREVIEW_IDENTITY_IMMUTABLE/);
  await assert.rejects(db.previewLineage.update({ where: { id: lineage.id }, data: { candidateGeneration: 2 } }));
  await assert.rejects(db.deployment.update({ where: { id: attempt.id }, data: { previewRuntime: {} } }), /PREVIEW_ATTEMPT_IMMUTABLE/);
  await assert.rejects(db.deployment.create({ data: { ...attempt, id: 'null-fields', previewGeneration: 2, previewRuntime: {} } }));
  await assert.rejects(db.deployment.create({ data: { ...attempt, id: 'overflow', previewGeneration: 2, previewRuntime: { version: 1, lineageId: lineage.id, deploymentId: 'overflow', generation: 2 }, previewOwnedObjects: Array(33).fill({}) } }));
  await assert.rejects(db.previewLineage.update({ where: { id: lineage.id }, data: { generation: 0 } }), /PREVIEW_IDENTITY_IMMUTABLE/);
  // Then: durable exact pointer survives and no failed insert becomes durable.
  assert.equal((await db.previewLineage.findUnique({ where: { id: lineage.id } })).candidateDeploymentId, attempt.id);
  assert.equal(await db.deployment.count(), 1);
  t.diagnostic(JSON.stringify({ exactPointer: true, immutableIdentity: true, foreignGenerationRejected: true, malformedRuntimeRejected: true, inventoryBound: 32 }));
});

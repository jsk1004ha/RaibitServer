import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function domainRow(overrides = {}) {
  const now = new Date('2026-09-06T00:00:00.000Z');
  return {
    id: 'managed-domain',
    organizationId: 'organization-1',
    projectId: 'project-1',
    serviceId: 'service-1',
    domain: 'managed.example',
    type: 'CUSTOM',
    verified: false,
    tlsStatus: 'PENDING',
    status: 'PENDING_VERIFICATION',
    verificationTokenHash: 'a'.repeat(64),
    verificationVersion: 1,
    issuedAt: now,
    expiresAt: new Date('2026-09-06T00:30:00.000Z'),
    verificationRequestedAt: null,
    verifiedAt: null,
    consecutiveFailures: 0,
    nextCheckAt: null,
    lastCheckedAt: null,
    lastFailureCode: null,
    tlsFailureCount: 0,
    tlsNextCheckAt: null,
    deletionRequestedAt: null,
    deletionStartedAt: null,
    cleanupVersion: 0,
    cleanupAcknowledgedVersion: 0,
    actorUserId: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function prismaFixture(rows) {
  const mutations = [];
  const prisma = {
    domain: {
      findMany: async () => rows,
      findUnique: async ({ where }) => rows.find((row) => row.id === where.id) ?? null,
      updateMany: async (input) => {
        mutations.push(input);
        return { count: 1 };
      },
    },
    auditLog: { create: async (input) => mutations.push(input) },
  };
  prisma.$transaction = async (operation) => operation(prisma);
  return { prisma, mutations };
}

test('N-1 Domain columns remain nullable through the additive lifecycle migration', async () => {
  // Given
  const [schema, migration] = await Promise.all([
    readFile(`${repositoryRoot}prisma/schema.prisma`, 'utf8'),
    readFile(`${repositoryRoot}prisma/migrations/202609060001_custom_domain_lifecycle/migration.sql`, 'utf8'),
  ]);

  // Then
  for (const field of ['organizationId', 'projectId', 'serviceId', 'actorUserId']) {
    assert.match(schema, new RegExp(`\\n\\s*${field}\\s+String\\?`));
    assert.doesNotMatch(migration, new RegExp(`ALTER COLUMN "${field}" SET NOT NULL`));
  }
  assert.doesNotMatch(migration, /RAISE EXCEPTION/);
  assert.doesNotMatch(migration, /"actorUserId" = 'system'/);
  assert.doesNotMatch(migration, /WHEN domain\."verified" THEN 'READY'/);
  assert.match(migration, /SET "organizationId" = project\."organizationId"/);
});

test('Prisma repository excludes legacy rows from managed lifecycle reads and mutations', async () => {
  // Given: both shapes can coexist after an N-1 writer runs against the upgraded database.
  const managed = domainRow();
  const legacyBound = domainRow({
    id: 'legacy-bound-domain',
    actorUserId: null,
    verificationTokenHash: null,
    issuedAt: null,
    expiresAt: null,
    verified: true,
  });
  const legacyUnbound = domainRow({
    id: 'legacy-unbound-domain',
    organizationId: null,
    projectId: null,
    serviceId: null,
    actorUserId: null,
    verificationTokenHash: null,
    issuedAt: null,
    expiresAt: null,
    verified: true,
  });
  const { prisma, mutations } = prismaFixture([legacyBound, legacyUnbound, managed]);
  const repository = new PrismaControlPlaneRepository(prisma);

  // When
  const listed = await repository.listCustomDomainsForProject('project-1');

  // Then: legacy verified data is retained but never exposed or promoted as managed READY state.
  assert.deepEqual(listed.map((domain) => domain.id), ['managed-domain']);
  assert.equal(await repository.getCustomDomain('legacy-bound-domain'), null);
  assert.equal(await repository.getCustomDomain('legacy-unbound-domain'), null);
  assert.equal((await repository.getCustomDomain('managed-domain')).status, 'PENDING_VERIFICATION');

  for (const id of ['legacy-bound-domain', 'legacy-unbound-domain']) {
    const operations = [
      () => repository.rotateCustomDomainChallenge(id, { expectedVersion: 1, actorUserId: 'user-1' }),
      () => repository.requestCustomDomainVerification(id, { expectedVersion: 1, actorUserId: 'user-1' }),
      () => repository.requestCustomDomainDeletion(id, { expectedVersion: 1, actorUserId: 'user-1' }),
    ];
    for (const operation of operations) await assert.rejects(operation, /DOMAIN_NOT_FOUND/);
  }
  assert.deepEqual(mutations, []);
});

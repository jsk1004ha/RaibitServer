import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const databaseUrl = process.env.RAIBITSERVER_TEST_DATABASE_URL;

test('custom domain API happy path persists the lifecycle contract in PostgreSQL', { skip: databaseUrl ? false : 'RAIBITSERVER_TEST_DATABASE_URL is not configured' }, async () => {
  // Given
  const repository = await PrismaControlPlaneRepository.connect({ env: { ...process.env, DATABASE_URL: databaseUrl } });
  const suffix = `${process.pid}-${Date.now()}`;
  let organization;

  try {
    organization = await repository.createOrganization({ name: `Domain ${suffix}`, slug: `domain-${suffix}` });
    const project = await repository.createProject({ organizationId: organization.id, name: 'Site', slug: 'site' });
    const service = await repository.createService({ projectId: project.id, name: 'Web', slug: 'web', type: 'web', sourceType: 'image' });

    // When
    const created = await repository.createCustomDomain({ organizationId: organization.id, projectId: project.id, serviceId: service.id, hostname: `${suffix}.example.test`, actorUserId: 'system' });
    const status = await repository.getCustomDomain(created.domain.id);

    // Then
    assert.equal(status.hostname, `${suffix}.example.test`);
    assert.equal(status.verificationVersion, 1);
    assert.equal('verificationTokenHash' in status, false);
    assert.equal(JSON.stringify(await repository.snapshot()).includes(created.challengeToken), false);
  } finally {
    if (organization) await repository.prisma.organization.delete({ where: { id: organization.id } });
    await repository.disconnect();
  }
});

test('custom domain API adversarial matrix fences duplicate and stale PostgreSQL mutations', { skip: databaseUrl ? false : 'RAIBITSERVER_TEST_DATABASE_URL is not configured' }, async () => {
  // Given
  const repository = await PrismaControlPlaneRepository.connect({ env: { ...process.env, DATABASE_URL: databaseUrl } });
  const suffix = `${process.pid}-${Date.now()}`;
  let organization;

  try {
    organization = await repository.createOrganization({ name: `Domain Adversarial ${suffix}`, slug: `domain-adversarial-${suffix}` });
    const project = await repository.createProject({ organizationId: organization.id, name: 'Site', slug: 'site' });
    const service = await repository.createService({ projectId: project.id, name: 'Web', slug: 'web', type: 'web', sourceType: 'image' });
    const input = { organizationId: organization.id, projectId: project.id, serviceId: service.id, hostname: `${suffix}.example.test`, actorUserId: 'system' };
    const created = await repository.createCustomDomain(input);

    // When
    const duplicate = repository.createCustomDomain(input);
    const stale = repository.rotateCustomDomainChallenge(created.domain.id, { expectedVersion: 2, actorUserId: 'system' });

    // Then
    await assert.rejects(duplicate, /DOMAIN_HOSTNAME_CONFLICT/);
    await assert.rejects(stale, /DOMAIN_VERSION_CONFLICT/);
  } finally {
    if (organization) await repository.prisma.organization.delete({ where: { id: organization.id } });
    await repository.disconnect();
  }
});

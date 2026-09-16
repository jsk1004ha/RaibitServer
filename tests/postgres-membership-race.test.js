import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { changeOrganizationMembershipRole, leaveOrganization, listOrganizationMembers, removeOrganizationMember, revokeOrganizationInvite } from '../packages/core/src/membership-transition.ts';
import { acceptOrganizationInvite, issueOrganizationInvite } from '../packages/core/src/organization-invite.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const require = createRequire(import.meta.url);
const postgresOptions = { skip: !process.env.RAIBITSERVER_TEST_DATABASE_URL ? 'NOT_RUN: deferred disposable PostgreSQL URL not configured' : false };

test('membership transition happy path uses serialized PostgreSQL writes', postgresOptions, async t => {
  // Given: an isolated migrated schema with OWNER, ADMIN, target, and leaving memberships.
  const repositories = await postgresFixture(t, 1);
  const fixture = await seedMembershipFixture(repositories[0]);
  const listed = await listOrganizationMembers(repositories[0], { organizationId: fixture.organization.id, actorUserId: fixture.owner.id });
  const target = listed.members.find(member => member.userId === fixture.target.id);
  const leaving = listed.members.find(member => member.userId === fixture.leaving.id);
  const invite = await issueOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, email: 'pg-future@example.test', role: 'VIEWER', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async () => {} });

  // When: OWNER changes and removes a member while another member leaves.
  const changed = await changeOrganizationMembershipRole(repositories[0], { organizationId: fixture.organization.id, membershipId: target.id, actorUserId: fixture.owner.id, role: 'DB_ADMIN', expectedVersion: target.version });
  await removeOrganizationMember(repositories[0], { organizationId: fixture.organization.id, membershipId: target.id, actorUserId: fixture.owner.id, expectedVersion: changed.membership.version });
  await leaveOrganization(repositories[0], { organizationId: fixture.organization.id, actorUserId: fixture.leaving.id, expectedVersion: leaving.version });
  await revokeOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, inviteId: invite.invite.id, actorUserId: fixture.admin.id });

  // Then: durable rows, versions, and affected session epochs reflect exactly the successful changes.
  assert.equal(changed.membership.version, 2);
  assert.equal(await repositories[0].prisma.membership.count({ where: { id: target.id } }), 0);
  assert.equal(await repositories[0].prisma.membership.count({ where: { userId: fixture.leaving.id, organizationId: fixture.organization.id } }), 0);
  assert.equal((await repositories[0].prisma.user.findUniqueOrThrow({ where: { id: fixture.target.id } })).sessionVersion, 2);
  assert.equal((await repositories[0].prisma.user.findUniqueOrThrow({ where: { id: fixture.leaving.id } })).sessionVersion, 1);
  assert.equal((await repositories[0].prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.invite.id } })).revokedAt !== null, true);
  t.diagnostic(JSON.stringify({ changedVersion: 2, removed: true, left: true, inviteRevoked: true, targetSessionVersion: 2, leavingSessionVersion: 1 }));
});

test('membership transition adversarial matrix proves PostgreSQL owner-row locking and invite interleaving', postgresOptions, async t => {
  // Given: twenty independent clients, one last OWNER, an ADMIN, and a verified invite recipient.
  const repositories = await postgresFixture(t, 20);
  const fixture = await seedMembershipFixture(repositories[0]);
  const listed = await listOrganizationMembers(repositories[0], { organizationId: fixture.organization.id, actorUserId: fixture.owner.id });
  const owner = listed.members.find(member => member.userId === fixture.owner.id);

  // When: demote/remove/leave race the last OWNER, then an OWNER invite acceptance races another demotion wave.
  const lastOwnerAttempts = await Promise.allSettled(repositories.map((repository, index) => {
    if (index % 3 === 0) return changeOrganizationMembershipRole(repository, { organizationId: fixture.organization.id, membershipId: owner.id, actorUserId: fixture.owner.id, role: 'ADMIN', expectedVersion: owner.version });
    if (index % 3 === 1) return removeOrganizationMember(repository, { organizationId: fixture.organization.id, membershipId: owner.id, actorUserId: fixture.owner.id, expectedVersion: owner.version });
    return leaveOrganization(repository, { organizationId: fixture.organization.id, actorUserId: fixture.owner.id, expectedVersion: owner.version });
  }));
  let token = '';
  await issueOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'OWNER', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async message => { token = new URL(message.acceptanceUrl).searchParams.get('token'); } });
  const interleaved = await Promise.allSettled([
    acceptOrganizationInvite(repositories[0], { token, userId: fixture.recipient.id }),
    ...repositories.slice(1).map(repository => changeOrganizationMembershipRole(repository, { organizationId: fixture.organization.id, membershipId: owner.id, actorUserId: fixture.owner.id, role: 'ADMIN', expectedVersion: owner.version })),
  ]);

  // Then: the first wave has no writes, invite consumption succeeds once, and the organization retains at least one OWNER under every ordering.
  assert.equal(lastOwnerAttempts.every(result => result.status === 'rejected' && result.reason.code === 'LAST_OWNER'), true);
  assert.equal(interleaved[0].status, 'fulfilled');
  const ownerCount = await repositories[0].prisma.membership.count({ where: { organizationId: fixture.organization.id, role: { in: ['OWNER', 'owner'] } } });
  assert.equal(ownerCount >= 1, true);
  assert.equal(await repositories[0].prisma.membership.count({ where: { organizationId: fixture.organization.id, userId: fixture.recipient.id } }), 1);
  t.diagnostic(JSON.stringify({ clients: 20, lastOwnerWrites: 0, inviteMemberships: 1, ownerCount }));
});

async function postgresFixture(t, count) {
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'real disposable PostgreSQL URL required; this suite must not skip');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL });
  const schema = `membership_t32_${randomUUID().replaceAll('-', '')}`;
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
  const migrate = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 120_000 });
  assert.equal(migrate.status, 0, `isolated schema migration failed: ${migrate.stderr}`);
  for (let index = 0; index < count; index += 1) repositories.push(await PrismaControlPlaneRepository.connect({ env: process.env, prismaOptions: { datasourceUrl: url.href, transactionOptions: { maxWait: 30_000, timeout: 30_000 } } }));
  return repositories;
}

async function seedMembershipFixture(repository) {
  const owner = await repository.prisma.user.create({ data: { email: `owner-${randomUUID()}@example.test`, name: 'Owner', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 0 } });
  const admin = await repository.prisma.user.create({ data: { email: `admin-${randomUUID()}@example.test`, name: 'Admin', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 0 } });
  const target = await repository.prisma.user.create({ data: { email: `target-${randomUUID()}@example.test`, name: 'Target', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 0 } });
  const leaving = await repository.prisma.user.create({ data: { email: `leaving-${randomUUID()}@example.test`, name: 'Leaving', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 0 } });
  const recipient = await repository.prisma.user.create({ data: { email: `recipient-${randomUUID()}@example.test`, name: 'Recipient', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 0 } });
  const organization = await repository.prisma.organization.create({ data: { name: 'Membership PostgreSQL', slug: `membership-${randomUUID()}` } });
  await repository.prisma.membership.createMany({ data: [
    { organizationId: organization.id, userId: owner.id, role: 'OWNER' },
    { organizationId: organization.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: organization.id, userId: target.id, role: 'DEVELOPER' },
    { organizationId: organization.id, userId: leaving.id, role: 'VIEWER' },
  ] });
  return { owner, admin, target, leaving, recipient, organization };
}

function testEnv() {
  return { NODE_ENV: 'test', RAIBITSERVER_APP_URL: 'https://dashboard.raibitserver.test', RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console', RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.test' };
}

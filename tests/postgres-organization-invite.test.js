import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { acceptOrganizationInvite, issueOrganizationInvite } from '../packages/core/src/organization-invite.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const require = createRequire(import.meta.url);
const postgresOptions = { skip: !process.env.RAIBITSERVER_TEST_DATABASE_URL ? 'NOT_RUN: deferred disposable PostgreSQL URL not configured' : false };

test('organization invitation happy path uses one PostgreSQL transaction', postgresOptions, async t => {
  // Given: an isolated migrated PostgreSQL schema with an OWNER and verified recipient.
  const repositories = await postgresFixture(t, 1);
  const fixture = await seedInviteFixture(repositories[0]);
  let token = '';

  // When: the OWNER delivers and the recipient accepts a DB_ADMIN invitation.
  const issued = await issueOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'DB_ADMIN', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async message => { token = new URL(message.acceptanceUrl).searchParams.get('token'); } });
  const accepted = await acceptOrganizationInvite(repositories[0], { token, userId: fixture.recipient.id });

  // Then: one create-only membership and sanitized audit are durable while the raw token is absent.
  assert.deepEqual(accepted, { status: 'accepted', membership: { organizationId: fixture.organization.id, role: 'DB_ADMIN' } });
  assert.equal(await repositories[0].prisma.membership.count({ where: { organizationId: fixture.organization.id, userId: fixture.recipient.id } }), 1);
  assert.equal((await repositories[0].prisma.user.findUniqueOrThrow({ where: { id: fixture.recipient.id } })).sessionVersion, 1);
  const stored = await repositories[0].prisma.organizationInvite.findUniqueOrThrow({ where: { id: issued.invite.id } });
  assert.notEqual(stored.tokenHash, token);
  assert.equal(JSON.stringify(await repositories[0].prisma.auditLog.findMany({ where: { targetType: 'organization-invite' } })).includes(token), false);
  t.diagnostic(JSON.stringify({ membershipCount: 1, role: 'DB_ADMIN', rawTokenMatches: 0 }));
});

test('organization invitation adversarial matrix proves PostgreSQL race semantics', postgresOptions, async t => {
  // Given: twenty independent clients plus an OWNER, ADMIN, new recipient, and the existing last OWNER.
  const repositories = await postgresFixture(t, 20);
  const fixture = await seedInviteFixture(repositories[0]);
  const admin = await repositories[0].prisma.user.create({ data: { email: 'pg-admin@example.test', name: 'Admin', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 3 } });
  await repositories[0].prisma.membership.create({ data: { organizationId: fixture.organization.id, userId: admin.id, role: 'ADMIN' } });
  await assert.rejects(issueOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'OWNER', actorUserId: admin.id }, { env: testEnv(), deliver: async () => {} }), error => error.code === 'organization_invite_forbidden');
  const tokens = [];
  const deliver = async message => { tokens.push(new URL(message.acceptanceUrl).searchParams.get('token')); };
  await issueOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'MAINTAINER', actorUserId: fixture.owner.id }, { env: testEnv(), deliver });

  // When: twenty clients race on a new membership and then on a redundant ADMIN invite for the last OWNER.
  const newMemberOutcomes = await Promise.allSettled(repositories.map(repository => acceptOrganizationInvite(repository, { token: tokens[0], userId: fixture.recipient.id })));
  const ownerBefore = await repositories[0].prisma.user.findUniqueOrThrow({ where: { id: fixture.owner.id } });
  await issueOrganizationInvite(repositories[0], { organizationId: fixture.organization.id, email: fixture.owner.email, role: 'ADMIN', actorUserId: fixture.owner.id }, { env: testEnv(), deliver });
  const ownerOutcomes = await Promise.allSettled(repositories.map(repository => acceptOrganizationInvite(repository, { token: tokens[1], userId: fixture.owner.id })));

  // Then: each token has one winner, the new membership is unique, and the existing OWNER is never demoted or session-revoked.
  assert.equal(newMemberOutcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(ownerOutcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(ownerOutcomes.find(result => result.status === 'fulfilled').value, { status: 'already_member' });
  assert.equal(await repositories[0].prisma.membership.count({ where: { organizationId: fixture.organization.id, userId: fixture.recipient.id, role: 'MAINTAINER' } }), 1);
  const ownerMembership = await repositories[0].prisma.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: fixture.organization.id, userId: fixture.owner.id } } });
  const ownerAfter = await repositories[0].prisma.user.findUniqueOrThrow({ where: { id: fixture.owner.id } });
  assert.equal(ownerMembership.role, 'OWNER');
  assert.equal(await repositories[0].prisma.membership.count({ where: { organizationId: fixture.organization.id, role: 'OWNER' } }), 1);
  assert.equal(ownerAfter.sessionVersion, ownerBefore.sessionVersion);
  t.diagnostic(JSON.stringify({ acceptors: 20, newMemberWinners: 1, existingOwnerWinners: 1, ownerCount: 1, ownerSessionVersionUnchanged: true }));
});

async function postgresFixture(t, count) {
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'real disposable PostgreSQL URL required; this suite must not skip');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL });
  const schema = `invite_t31_${randomUUID().replaceAll('-', '')}`;
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

async function seedInviteFixture(repository) {
  const owner = await repository.prisma.user.create({ data: { email: `pg-owner-${randomUUID()}@example.test`, name: 'Owner', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 7 } });
  const recipient = await repository.prisma.user.create({ data: { email: `pg-recipient-${randomUUID()}@example.test`, name: 'Recipient', approvalStatus: 'APPROVED', emailVerifiedAt: new Date(), sessionVersion: 0 } });
  const organization = await repository.prisma.organization.create({ data: { name: 'Invite PostgreSQL', slug: `invite-${randomUUID()}` } });
  await repository.prisma.membership.create({ data: { organizationId: organization.id, userId: owner.id, role: 'OWNER' } });
  return { owner, recipient, organization };
}

function testEnv() {
  return { NODE_ENV: 'test', RAIBITSERVER_APP_URL: 'https://dashboard.raibitserver.test', RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console', RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.test' };
}

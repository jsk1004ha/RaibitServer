import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { createSessionToken, signJwtHs256 } from '../packages/core/src/index.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { OrganizationCreateRequestSchema, OrganizationCreatedSchema } from '../packages/schemas/src/organization-create.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

const jwtSecret = 'organization-create-local-test-secret';

test('organization creation accepts only bounded name and canonical slug input', () => {
  assert.deepEqual(OrganizationCreateRequestSchema.parse({ name: ' Viewer Org ', slug: 'viewer-org' }), { name: 'Viewer Org', slug: 'viewer-org' });
  for (const input of [
    { name: 'Viewer Org', slug: 'viewer-org', ownerId: 'forged' },
    { name: ' ', slug: 'viewer-org' },
    { name: 'x'.repeat(129), slug: 'viewer-org' },
    { name: '가'.repeat(86), slug: 'viewer-org' },
    { name: 'Viewer Org', slug: 'api' },
    { name: 'Viewer Org', slug: 'viewer--org' },
  ]) assert.equal(OrganizationCreateRequestSchema.safeParse(input).success, false);
});

test('approved VIEWER atomically becomes OWNER only in the new organization', async () => {
  const store = new ControlPlaneStore();
  const foreign = store.createOrganization({ name: 'Foreign', slug: 'foreign' });
  const viewer = store.createUser({ email: 'viewer@example.test', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: foreign.id, userId: viewer.id, role: 'VIEWER' });
  const previousVersion = store.users.get(viewer.id).sessionVersion;

  const result = store.createOrganizationForUser({ actorUserId: viewer.id, name: 'Viewer Org', slug: 'viewer-org' });
  assert.equal(OrganizationCreatedSchema.safeParse(result).success, true);
  assert.equal(result.membership.role, 'OWNER');
  assert.equal(result.reauthenticationRequired, true);
  assert.equal(store.users.get(viewer.id).sessionVersion, previousVersion + 1);
  assert.equal(store.members.find((member) => member.organizationId === foreign.id && member.userId === viewer.id).role, 'VIEWER');
  assert.deepEqual(store.auditLogs.at(-1).metadata, { slug: 'viewer-org' });

  const beforeDuplicate = store.snapshot();
  assert.throws(
    () => store.createOrganizationForUser({ actorUserId: viewer.id, name: 'Duplicate', slug: 'viewer-org' }),
    (error) => error.statusCode === 409 && error.code === 'organization_slug_already_exists',
  );
  assert.deepEqual(store.snapshot(), beforeDuplicate);

  const rollback = new ControlPlaneStore();
  const rollbackUser = rollback.createUser({ email: 'rollback@example.test', approvalStatus: 'APPROVED' });
  const rollbackVersion = rollback.users.get(rollbackUser.id).sessionVersion;
  rollback.audit = () => { throw new Error('fixture_audit_failure'); };
  assert.throws(() => rollback.createOrganizationForUser({ actorUserId: rollbackUser.id, name: 'Rollback', slug: 'rollback' }), /fixture_audit_failure/);
  assert.equal(rollback.organizations.size, 0);
  assert.equal(rollback.members.length, 0);
  assert.equal(rollback.users.get(rollbackUser.id).sessionVersion, rollbackVersion);

  for (const [label, userInput, code] of [
    ['pending', { email: 'pending@example.test', approvalStatus: 'PENDING' }, 'account_not_approved'],
    ['unverified', { email: 'unverified@example.test', approvalStatus: 'APPROVED', emailVerifiedAt: null }, 'email_not_verified'],
    ['banned', { email: 'banned@example.test', approvalStatus: 'APPROVED', bannedAt: new Date().toISOString() }, 'account_banned'],
  ]) {
    const denied = store.createUser(userInput);
    assert.throws(
      () => store.createOrganizationForUser({ actorUserId: denied.id, name: label, slug: `denied-${label}` }),
      (error) => error.statusCode === 403 && error.code === code,
    );
  }

  const repository = new InMemoryControlPlaneRepository();
  const concurrent = repository.store.createUser({ email: 'concurrent@example.test', approvalStatus: 'APPROVED' });
  const outcomes = await Promise.allSettled([
    repository.createOrganizationForUser({ actorUserId: concurrent.id, name: 'Concurrent', slug: 'concurrent' }),
    repository.createOrganizationForUser({ actorUserId: concurrent.id, name: 'Concurrent', slug: 'concurrent' }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'organization_slug_already_exists').length, 1);
  assert.equal(repository.store.members.length, 1);
});

test('Prisma creation keeps organization, OWNER membership, session revocation, and audit in one transaction', async () => {
  const committed = { organizations: [], memberships: [], sessionVersion: 4, audits: [] };
  let isolationLevel = null;
  const repository = new PrismaControlPlaneRepository({
    $transaction: async (operation, options) => {
      isolationLevel = options.isolationLevel;
      const candidate = structuredClone(committed);
      const transaction = {
        user: {
          findUnique: async () => ({ id: 'user-prisma', emailVerifiedAt: new Date(), approvalStatus: 'APPROVED', bannedAt: null }),
          update: async () => { candidate.sessionVersion += 1; return {}; },
        },
        organization: {
          findUnique: async ({ where }) => candidate.organizations.find((row) => row.slug === where.slug) || null,
          create: async ({ data }) => { const row = { id: 'org-prisma', ...data, createdAt: new Date() }; candidate.organizations.push(row); return row; },
        },
        membership: {
          create: async ({ data }) => { const row = { id: 'membership-prisma', ...data, createdAt: new Date() }; candidate.memberships.push(row); return row; },
        },
        auditLog: { create: async ({ data }) => { candidate.audits.push(data); return data; } },
      };
      const result = await operation(transaction);
      Object.assign(committed, candidate);
      return result;
    },
  });

  const result = await repository.createOrganizationForUser({ actorUserId: 'user-prisma', name: 'Prisma Org', slug: 'prisma-org' });
  assert.equal(isolationLevel, 'Serializable');
  assert.equal(result.membership.role, 'OWNER');
  assert.equal(committed.organizations.length, 1);
  assert.equal(committed.memberships.length, 1);
  assert.equal(committed.sessionVersion, 5);
  assert.deepEqual(committed.audits[0].metadata, { slug: 'prisma-org' });
});

test('prototype and Nest HTTP routes create for approved VIEWER, reject forgery, and revoke the old JWT', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const foreign = controlPlane.store.createOrganization({ name: 'Prototype Foreign', slug: 'prototype-foreign' });
  const viewer = controlPlane.store.createUser({ email: 'prototype-viewer@example.test', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: foreign.id, userId: viewer.id, role: 'VIEWER' });
  const token = createSessionToken(controlPlane.store.findUserById(viewer.id), controlPlane.store.listMembershipsForUser(viewer.id), jwtSecret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    for (const [label, userInput, expectedMessage] of [
      ['pending', { email: 'http-pending@example.test', approvalStatus: 'PENDING' }, 'account is not approved'],
      ['banned', { email: 'http-banned@example.test', approvalStatus: 'APPROVED', bannedAt: new Date().toISOString() }, 'account is banned'],
    ]) {
      const denied = controlPlane.store.createUser(userInput);
      const deniedToken = createSessionToken(controlPlane.store.findUserById(denied.id), [], jwtSecret);
      const response = await request(`http://127.0.0.1:${port}/organizations`, deniedToken, { name: label, slug: `http-${label}` });
      assert.equal(response.status, 401);
      assert.equal(response.body.message, expectedMessage);
      assert.equal(controlPlane.store.findOrganizationBySlug(`http-${label}`), null);
    }

    const platformAdmin = controlPlane.store.createUser({ email: 'platform-admin@example.test', approvalStatus: 'APPROVED', role: 'ADMIN' });
    const globalHumanToken = signJwtHs256({ sub: platformAdmin.id, role: 'OWNER', userRole: 'ADMIN', global: true, sessionVersion: 0 }, jwtSecret);
    const globalCreated = await request(`http://127.0.0.1:${port}/organizations`, globalHumanToken, { name: 'Global Human', slug: 'global-human' });
    assert.equal(globalCreated.status, 201);
    assert.equal(globalCreated.body.membership.userId, platformAdmin.id);
    assert.equal(globalCreated.body.membership.role, 'OWNER');

    const forged = await request(`http://127.0.0.1:${port}/organizations`, token, { name: 'Forged', slug: 'forged', ownerId: 'attacker' });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.code, 'organization_creation_input_invalid');
    assert.equal(controlPlane.store.findOrganizationBySlug('forged'), null);

    const created = await request(`http://127.0.0.1:${port}/organizations`, token, { name: 'Prototype Created', slug: 'prototype-created' });
    assert.equal(created.status, 201);
    assert.equal(created.body.membership.userId, viewer.id);
    assert.equal(created.body.membership.role, 'OWNER');
    assert.equal(created.body.reauthenticationRequired, true);
    assert.equal(controlPlane.store.members.find((member) => member.organizationId === foreign.id && member.userId === viewer.id).role, 'VIEWER');
    assert.equal((await request(`http://127.0.0.1:${port}/auth/me`, token)).status, 401);

    const refreshed = createSessionToken(controlPlane.store.findUserById(viewer.id), controlPlane.store.listMembershipsForUser(viewer.id), jwtSecret);
    const duplicate = await request(`http://127.0.0.1:${port}/organizations`, refreshed, { name: 'Duplicate', slug: 'prototype-created' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'organization_slug_already_exists');

    const serviceToken = signJwtHs256({ sub: 'service-agent', role: 'OWNER', global: true, system: true, sessionVersion: 0 }, jwtSecret);
    const serviceDenied = await request(`http://127.0.0.1:${port}/organizations`, serviceToken, { name: 'Service', slug: 'service-agent' });
    assert.equal(serviceDenied.status, 401);
    assert.equal(serviceDenied.body.code, 'organization_creation_auth_required');
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }

  const runtime = await bootParityApi();
  try {
    const nestForeign = runtime.repository.store.createOrganization({ name: 'Nest Foreign', slug: 'nest-foreign' });
    const nestViewer = runtime.repository.store.createUser({ email: 'nest-viewer@example.test', approvalStatus: 'APPROVED' });
    runtime.repository.store.addMember({ organizationId: nestForeign.id, userId: nestViewer.id, role: 'VIEWER' });
    const nestToken = createSessionToken(runtime.repository.store.findUserById(nestViewer.id), runtime.repository.store.listMembershipsForUser(nestViewer.id), process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const created = await request(`${runtime.baseUrl}/organizations`, nestToken, { name: 'Nest Created', slug: 'nest-created' });
    assert.equal(created.status, 201);
    assert.equal(created.body.membership.role, 'OWNER');
    assert.equal(runtime.repository.store.members.find((member) => member.organizationId === nestForeign.id && member.userId === nestViewer.id).role, 'VIEWER');
    assert.equal((await request(`${runtime.baseUrl}/auth/me`, nestToken)).status, 401);
  } finally {
    await runtime.app.close();
  }
});

async function request(url, token, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

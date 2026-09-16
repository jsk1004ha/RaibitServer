import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import YAML from 'yaml';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { changeOrganizationMembershipRole, leaveOrganization, listOrganizationMembers, removeOrganizationMember, revokeOrganizationInvite } from '../packages/core/src/membership-transition.ts';
import { acceptOrganizationInvite, issueOrganizationInvite } from '../packages/core/src/organization-invite.ts';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { apiOperations, createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';
import roleContract from '../test-fixtures/contracts/organization-roles-v1.json' with { type: 'json' };
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

test('membership transition happy path is exposed by the core contract', async () => {
  // Given: the public core module.
  const core = await import('../packages/core/src/index.ts');

  // When: membership transition behavior is inspected.
  const behavior = core.changeOrganizationMembershipRole;

  // Then: callers can invoke the serialized membership workflow.
  assert.equal(typeof behavior, 'function');
});

test('membership transition happy path applies legal roles, removal, leave, and invite revocation', async () => {
  // Given: an OWNER, ADMIN, two ordinary members, and a live invitation.
  const fixture = membershipFixture();
  const admin = addFixtureMember(fixture, 'admin@example.test', 'ADMIN');
  const target = addFixtureMember(fixture, 'target@example.test', 'DEVELOPER');
  const leaving = addFixtureMember(fixture, 'leaving@example.test', 'VIEWER');
  let deliveredToken = '';
  const issued = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: 'invited@example.test', role: 'DB_ADMIN', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async message => { deliveredToken = new URL(message.acceptanceUrl).searchParams.get('token'); } });
  const listed = await listOrganizationMembers(fixture.repository, { organizationId: fixture.organization.id, actorUserId: fixture.owner.id });
  const targetView = listed.members.find(member => member.userId === target.id);
  const leavingView = listed.members.find(member => member.userId === leaving.id);

  // When: the OWNER changes role, repeats the same role, removes it, the VIEWER leaves, and ADMIN revokes a non-owner invite.
  const changed = await changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: targetView.id, actorUserId: fixture.owner.id, role: 'DB_ADMIN', expectedVersion: targetView.version });
  const unchanged = await changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: targetView.id, actorUserId: fixture.owner.id, role: 'DB_ADMIN', expectedVersion: changed.membership.version });
  await removeOrganizationMember(fixture.repository, { organizationId: fixture.organization.id, membershipId: targetView.id, actorUserId: fixture.owner.id, expectedVersion: changed.membership.version });
  await leaveOrganization(fixture.repository, { organizationId: fixture.organization.id, actorUserId: leaving.id, expectedVersion: leavingView.version });
  await revokeOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, inviteId: issued.invite.id, actorUserId: admin.id });

  // Then: versions and sessions change exactly once per privilege/scope change while the no-op and invite revoke do not affect user sessions.
  assert.equal(changed.membership.role, 'DB_ADMIN');
  assert.equal(changed.membership.version, 2);
  assert.equal(unchanged.membership.version, 2);
  assert.equal(fixture.store.users.get(target.id).sessionVersion, 2);
  assert.equal(fixture.store.users.get(leaving.id).sessionVersion, 1);
  assert.equal(fixture.store.users.get(admin.id).sessionVersion, 0);
  assert.equal(fixture.store.organizationInvites.find(invite => invite.id === issued.invite.id).revokedAt !== null, true);
  assert.equal(JSON.stringify(fixture.store.auditLogs).includes(deliveredToken), false);
});

test('membership transition happy path matches every grantable role authority fixture', async () => {
  // Given: a fresh organization for every actor and target-role pair in the canonical Task3 fixture.
  const outcomes = [];

  // When: each actor attempts every canonical target role against a non-owner member.
  for (const actorRole of roleContract.grantableRoles) {
    for (const targetRole of roleContract.grantableRoles) {
      const fixture = membershipFixture();
      const actor = actorRole === 'OWNER' ? fixture.owner : addFixtureMember(fixture, `${actorRole.toLowerCase()}@example.test`, actorRole);
      const target = addFixtureMember(fixture, `${actorRole.toLowerCase()}-${targetRole.toLowerCase()}@example.test`, 'VIEWER');
      const view = (await listOrganizationMembers(fixture.repository, { organizationId: fixture.organization.id, actorUserId: fixture.owner.id })).members.find(member => member.userId === target.id);
      const result = await Promise.allSettled([changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: view.id, actorUserId: actor.id, role: targetRole, expectedVersion: 1 })]);
      outcomes.push({ actorRole, targetRole, status: result[0].status });
    }
  }

  // Then: allowed transitions agree exactly with transitionAuthority and no other role gains authority.
  for (const outcome of outcomes) {
    const expected = roleContract.transitionAuthority[outcome.actorRole].includes(outcome.targetRole) ? 'fulfilled' : 'rejected';
    assert.equal(outcome.status, expected, `${outcome.actorRole} -> ${outcome.targetRole}`);
  }
});

test('membership transition adversarial matrix preserves owner, version, tenant, and global-role boundaries', async () => {
  // Given: the last OWNER, a tenant ADMIN, a platform-global ADMIN with VIEWER membership, and a foreign organization.
  const fixture = membershipFixture();
  const admin = addFixtureMember(fixture, 'tenant-admin@example.test', 'ADMIN');
  const globalAdmin = fixture.store.createUser({ email: 'global-admin@example.test', name: 'Global', role: 'ADMIN', sessionVersion: 0 });
  fixture.store.addMember({ organizationId: fixture.organization.id, userId: globalAdmin.id, role: 'VIEWER' });
  const ownerView = (await listOrganizationMembers(fixture.repository, { organizationId: fixture.organization.id, actorUserId: fixture.owner.id })).members.find(member => member.userId === fixture.owner.id);
  const foreign = fixture.store.createOrganization({ name: 'Foreign', slug: 'foreign-transition' });
  let ownerInviteToken = '';
  await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: fixture.owner.email, role: 'ADMIN', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async message => { ownerInviteToken = new URL(message.acceptanceUrl).searchParams.get('token'); } });
  const ownerRoleInvite = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: 'future-owner@example.test', role: 'OWNER', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async () => {} });

  // When: callers attempt last-owner changes, stale writes, legacy assignment, tenant escalation, foreign reads, and redundant invite acceptance.
  const attempts = await Promise.allSettled([
    changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: ownerView.id, actorUserId: fixture.owner.id, role: 'ADMIN', expectedVersion: 1 }),
    removeOrganizationMember(fixture.repository, { organizationId: fixture.organization.id, membershipId: ownerView.id, actorUserId: fixture.owner.id, expectedVersion: 1 }),
    leaveOrganization(fixture.repository, { organizationId: fixture.organization.id, actorUserId: fixture.owner.id, expectedVersion: 1 }),
    changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: ownerView.id, actorUserId: admin.id, role: 'VIEWER', expectedVersion: 1 }),
    changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: ownerView.id, actorUserId: globalAdmin.id, role: 'VIEWER', expectedVersion: 1 }),
    changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: ownerView.id, actorUserId: fixture.owner.id, role: 'billing-manager', expectedVersion: 1 }),
    listOrganizationMembers(fixture.repository, { organizationId: foreign.id, actorUserId: fixture.owner.id }),
    changeOrganizationMembershipRole(fixture.repository, { organizationId: foreign.id, membershipId: ownerView.id, actorUserId: fixture.owner.id, role: 'OWNER', expectedVersion: 1 }),
    changeOrganizationMembershipRole(fixture.repository, { organizationId: fixture.organization.id, membershipId: ownerView.id, actorUserId: fixture.owner.id, role: 'OWNER', expectedVersion: 99 }),
    revokeOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, inviteId: ownerRoleInvite.invite.id, actorUserId: admin.id }),
  ]);
  const accepted = await acceptOrganizationInvite(fixture.repository, { token: ownerInviteToken, userId: fixture.owner.id });
  const revoked = await revokeOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, inviteId: ownerRoleInvite.invite.id, actorUserId: fixture.owner.id });

  // Then: every attempt is typed and atomic, and the existing OWNER invitation remains a create-only no-op.
  assert.deepEqual(attempts.map(rejectionCode), ['LAST_OWNER', 'LAST_OWNER', 'LAST_OWNER', 'MEMBERSHIP_FORBIDDEN', 'MEMBERSHIP_FORBIDDEN', 'MEMBERSHIP_INPUT_INVALID', 'MEMBERSHIP_NOT_FOUND', 'MEMBERSHIP_NOT_FOUND', 'STALE_MEMBERSHIP', 'MEMBERSHIP_FORBIDDEN']);
  assert.deepEqual(accepted, { status: 'already_member' });
  assert.deepEqual(revoked, { revoked: true });
  assert.equal(fixture.store.members.find(member => member.userId === fixture.owner.id).role, 'OWNER');
  assert.equal(fixture.store.users.get(fixture.owner.id).sessionVersion, 0);
});

test('membership transition happy path works through actual local HTTP and invalidates stale JWTs', async () => {
  // Given: the real in-memory control plane behind an actual loopback HTTP server.
  const controlPlane = new RAIBITSERVERControlPlane();
  const owner = controlPlane.store.createUser({ email: 'http-transition-owner@example.test', name: 'Owner', approvalStatus: 'APPROVED', sessionVersion: 0 });
  const member = controlPlane.store.createUser({ email: 'http-transition-member@example.test', name: 'Member', approvalStatus: 'APPROVED', sessionVersion: 0 });
  const organization = controlPlane.store.createOrganization({ name: 'HTTP Transition', slug: 'http-transition' });
  const foreign = controlPlane.store.createOrganization({ name: 'HTTP Foreign', slug: 'http-transition-foreign' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: member.id, role: 'DEVELOPER' });
  const secret = 'membership-transition-http-secret';
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // When: OWNER lists and changes the member, then the member reuses its stale JWT and OWNER probes a foreign tenant.
    const ownerToken = signJwtHs256({ sub: owner.id, role: 'OWNER', organizationId: organization.id, sessionVersion: 0 }, secret);
    const memberToken = signJwtHs256({ sub: member.id, role: 'DEVELOPER', organizationId: organization.id, sessionVersion: 0 }, secret);
    const listed = await request(server, 'GET', `/organizations/${organization.id}/members`, undefined, ownerToken);
    const memberView = listed.body.members.find(candidate => candidate.userId === member.id);
    const changed = await request(server, 'PATCH', `/organizations/${organization.id}/members/${memberView.id}`, { role: 'MAINTAINER', expectedVersion: memberView.version }, ownerToken);
    const stale = await request(server, 'GET', `/organizations/${organization.id}/members`, undefined, memberToken);
    const foreignRead = await request(server, 'GET', `/organizations/${foreign.id}/members`, undefined, ownerToken);

    // Then: wire schemas are stable, the privilege change is visible, stale auth is denied, and foreign metadata is opaque.
    assert.equal(listed.statusCode, 200);
    assert.equal(changed.body.membership.role, 'MAINTAINER');
    assert.equal(stale.statusCode, 401);
    assert.equal(foreignRead.statusCode, 404);
    assert.equal(JSON.stringify(foreignRead.body).includes(foreign.name), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('membership transition happy path keeps Nest, OpenAPI, and typed client contracts aligned', async () => {
  // Given: committed OpenAPI, generated Zod contract, real Nest graph, and typed client operations.
  const document = YAML.parse(await fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  const expected = createOpenApiDocument();
  const runtime = await bootParityApi();
  const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: 'contract-token' });
  const ids = ['organizations-members', 'organizations-members-patch', 'organizations-members-delete', 'organizations-leave-post', 'organizations-invites-delete'];

  try {
    // When: every Task32 operation is compared across public backend surfaces.
    for (const id of ids) {
      const contract = apiOperations[id];
      const route = runtime.routes.find(candidate => candidate.path === contract.path && candidate.method === contract.method);

      // Then: path, method, status, permission, schema, and client operation agree exactly.
      assert.ok(route, `${id}: Nest route missing`);
      assert.equal(route.status, contract.status);
      assert.equal(route.permission, contract.permission);
      assert.deepEqual(document.paths[contract.path][contract.method], JSON.parse(JSON.stringify(expected.paths[contract.path][contract.method])));
      assert.equal(typeof client.operations[id], 'function');
    }
  } finally {
    await runtime.app.close();
  }
});

test('membership transition happy path emits exact typed SDK requests', async () => {
  // Given: the public SDK pointed at a real capture HTTP listener.
  const observed = [];
  const wire = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observed.push({ method: request.method, url: request.url, body });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ statusCode: 400, message: 'wire_probe', error: 'wire_probe' }));
  });
  wire.listen(0, '127.0.0.1');
  await once(wire, 'listening');
  const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${wire.address().port}`, token: 'wire-token' });

  try {
    // When: each Task32 convenience method emits its request.
    await assert.rejects(client.listOrganizationMembers('org /?'));
    await assert.rejects(client.changeOrganizationMembershipRole('org /?', 'mem /?', { role: 'DB_ADMIN', expectedVersion: 2 }));
    await assert.rejects(client.removeOrganizationMember('org /?', 'mem /?', { expectedVersion: 3 }));
    await assert.rejects(client.leaveOrganization('org /?', { expectedVersion: 4 }));
    await assert.rejects(client.revokeOrganizationInvite('org /?', 'inv /?'));

    // Then: methods, encoded paths, and optimistic-snapshot bodies are exact.
    assert.deepEqual(observed, [
      { method: 'GET', url: '/organizations/org%20%2F%3F/members', body: '' },
      { method: 'PATCH', url: '/organizations/org%20%2F%3F/members/mem%20%2F%3F', body: '{"role":"DB_ADMIN","expectedVersion":2}' },
      { method: 'DELETE', url: '/organizations/org%20%2F%3F/members/mem%20%2F%3F', body: '{"expectedVersion":3}' },
      { method: 'POST', url: '/organizations/org%20%2F%3F/leave', body: '{"expectedVersion":4}' },
      { method: 'DELETE', url: '/organizations/org%20%2F%3F/invites/inv%20%2F%3F', body: '' },
    ]);
  } finally {
    wire.close();
    await once(wire, 'close');
  }
});

function membershipFixture() {
  const repository = new InMemoryControlPlaneRepository();
  const store = repository.store;
  const owner = store.createUser({ email: 'transition-owner@example.test', name: 'Owner', sessionVersion: 0 });
  const organization = store.createOrganization({ name: 'Transition Org', slug: 'transition-org' });
  store.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });
  return { repository, store, owner, organization };
}

function addFixtureMember(fixture, email, role) {
  const user = fixture.store.createUser({ email, name: role, sessionVersion: 0 });
  fixture.store.addMember({ organizationId: fixture.organization.id, userId: user.id, role });
  return user;
}

function rejectionCode(result) {
  assert.equal(result.status, 'rejected');
  return result.reason.code;
}

function testEnv() {
  return { NODE_ENV: 'test', RAIBITSERVER_APP_URL: 'https://dashboard.raibitserver.test', RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console', RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.test' };
}

async function request(server, method, path, body, token) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { statusCode: response.status, body: await response.json() };
}

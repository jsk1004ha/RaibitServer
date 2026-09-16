import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import YAML from 'yaml';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { acceptOrganizationInvite, issueOrganizationInvite, listOrganizationInvites } from '../packages/core/src/organization-invite.ts';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { apiOperations, createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

test('organization invitation happy path is exposed by the core contract', async () => {
  // Given: the public core module.
  const core = await import('../packages/core/src/index.ts');

  // When: invitation behavior is inspected.
  const behavior = core.issueOrganizationInvite;

  // Then: callers can invoke the secure invitation workflow.
  assert.equal(typeof behavior, 'function');
});

test('organization invitation happy path creates one membership without exposing its token', async () => {
  // Given: an OWNER, a verified recipient, and the real in-memory repository.
  const fixture = invitationFixture();
  let delivered;

  // When: the owner issues and the recipient accepts the delivered token.
  const issued = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: '  NEW@Example.Test ', role: 'DB_ADMIN', actorUserId: fixture.owner.id }, { now: new Date('2026-09-06T00:00:00.000Z'), env: testEnv(), deliver: async message => { delivered = message; } });
  const token = new URL(delivered.acceptanceUrl).searchParams.get('token');
  const accepted = await acceptOrganizationInvite(fixture.repository, { token, userId: fixture.recipient.id, now: new Date('2026-09-06T00:01:00.000Z') });

  // Then: one DB_ADMIN membership exists, session scope changed, and only the delivery held the raw token.
  assert.deepEqual(accepted, { status: 'accepted', membership: { organizationId: fixture.organization.id, role: 'DB_ADMIN' } });
  assert.equal(fixture.store.members.filter(row => row.organizationId === fixture.organization.id && row.userId === fixture.recipient.id).length, 1);
  assert.equal(fixture.store.users.get(fixture.recipient.id).sessionVersion, 1);
  assert.equal(issued.invite.email, 'new@example.test');
  assert.equal('tokenHash' in issued.invite, false);
  assert.equal(JSON.stringify(fixture.store.auditLogs).includes(token), false);
  assert.equal(JSON.stringify(fixture.store.snapshot()).includes(token), false);
  assert.equal(JSON.stringify(await listOrganizationInvites(fixture.repository, { organizationId: fixture.organization.id, actorUserId: fixture.owner.id })).includes(token), false);
});

test('organization invitation adversarial matrix preserves authorization, identity, and replay boundaries', async () => {
  // Given: OWNER and ADMIN actors plus verified, foreign-email, and unverified users.
  const fixture = invitationFixture();
  const admin = fixture.store.createUser({ email: 'admin@example.test', name: 'Admin', sessionVersion: 2 });
  fixture.store.addMember({ organizationId: fixture.organization.id, userId: admin.id, role: 'ADMIN' });
  const foreign = fixture.store.createUser({ email: 'foreign@example.test', name: 'Foreign' });
  const unverified = fixture.store.createUser({ email: 'pending@example.test', name: 'Pending', emailVerifiedAt: null });
  const deliveries = [];
  const deliver = async message => { deliveries.push(message); };

  // When: forbidden roles, wrong identities, resend, expiry, replay, failure, and a 20-way race are exercised.
  await assert.rejects(issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'OWNER', actorUserId: admin.id }, { env: testEnv(), deliver }), error => error.code === 'organization_invite_forbidden');
  const first = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'DEVELOPER', actorUserId: fixture.owner.id }, { now: new Date('2026-09-06T00:00:00Z'), env: testEnv(), deliver });
  const firstToken = new URL(deliveries.at(-1).acceptanceUrl).searchParams.get('token');
  const second = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: fixture.recipient.email, role: 'MAINTAINER', actorUserId: fixture.owner.id }, { now: new Date('2026-09-06T00:01:00Z'), env: testEnv(), deliver });
  const secondToken = new URL(deliveries.at(-1).acceptanceUrl).searchParams.get('token');
  await assert.rejects(acceptOrganizationInvite(fixture.repository, { token: firstToken, userId: fixture.recipient.id }), invalidInvite);
  await assert.rejects(acceptOrganizationInvite(fixture.repository, { token: secondToken, userId: foreign.id }), invalidInvite);
  const pending = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: unverified.email, role: 'VIEWER', actorUserId: fixture.owner.id }, { now: new Date('2026-09-06T00:00:00Z'), env: testEnv(), deliver });
  const pendingToken = new URL(deliveries.at(-1).acceptanceUrl).searchParams.get('token');
  await assert.rejects(acceptOrganizationInvite(fixture.repository, { token: pendingToken, userId: unverified.id }), invalidInvite);
  const expired = await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: foreign.email, role: 'VIEWER', actorUserId: fixture.owner.id }, { now: new Date('2026-08-01T00:00:00Z'), env: testEnv(), deliver });
  const expiredToken = new URL(deliveries.at(-1).acceptanceUrl).searchParams.get('token');
  await assert.rejects(acceptOrganizationInvite(fixture.repository, { token: expiredToken, userId: foreign.id, now: new Date('2026-09-06T00:00:00Z') }), invalidInvite);
  await assert.rejects(issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: 'failed@example.test', role: 'VIEWER', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async () => { throw new Error('mail unavailable'); } }), error => error.code === 'organization_invite_delivery_failed');
  await assert.rejects(issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: 'unsafe-url@example.test', role: 'VIEWER', actorUserId: fixture.owner.id }, { env: { NODE_ENV: 'production', RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.test' }, deliver }), error => error.code === 'organization_invite_url_invalid');
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => acceptOrganizationInvite(fixture.repository, { token: secondToken, userId: fixture.recipient.id, now: new Date('2026-09-06T00:02:00Z') })));

  // Then: exactly one acceptance wins and every denied row leaves no unsafe membership write.
  assert.equal(first.invite.tokenVersion, 1);
  assert.equal(second.invite.tokenVersion, 2);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(fixture.store.members.filter(row => row.organizationId === fixture.organization.id && row.userId === fixture.recipient.id).length, 1);
  assert.equal(fixture.store.members.find(row => row.organizationId === fixture.organization.id && row.userId === fixture.recipient.id).role, 'MAINTAINER');
  assert.equal(fixture.store.organizationInvites.find(row => row.email === 'failed@example.test').revokedAt !== null, true);
  assert.equal(fixture.store.organizationInvites.find(row => row.email === 'unsafe-url@example.test').revokedAt !== null, true);
  await assert.rejects(listOrganizationInvites(fixture.repository, { organizationId: fixture.organization.id, actorUserId: foreign.id }), error => error.code === 'organization_invite_forbidden');
});

test('organization invitation adversarial matrix never changes an existing OWNER', async () => {
  // Given: the last OWNER has an ADMIN invitation for the organization they already own.
  const fixture = invitationFixture();
  const initialVersion = fixture.store.users.get(fixture.owner.id).sessionVersion;
  let token = '';
  await issueOrganizationInvite(fixture.repository, { organizationId: fixture.organization.id, email: fixture.owner.email, role: 'ADMIN', actorUserId: fixture.owner.id }, { env: testEnv(), deliver: async message => { token = new URL(message.acceptanceUrl).searchParams.get('token'); } });

  // When: the existing owner accepts the redundant invitation.
  const accepted = await acceptOrganizationInvite(fixture.repository, { token, userId: fixture.owner.id });

  // Then: the response is opaque and role, owner count, and sessionVersion stay unchanged.
  assert.deepEqual(accepted, { status: 'already_member' });
  assert.equal(fixture.store.members.find(row => row.organizationId === fixture.organization.id && row.userId === fixture.owner.id).role, 'OWNER');
  assert.equal(fixture.store.members.filter(row => row.organizationId === fixture.organization.id && row.role === 'OWNER').length, 1);
  assert.equal(fixture.store.users.get(fixture.owner.id).sessionVersion, initialVersion);
});

test('organization invitation happy path works through actual local HTTP and capture mail', async () => {
  // Given: a JWT HTTP API backed by the real in-memory repository and capture-mail delivery.
  const controlPlane = new RAIBITSERVERControlPlane();
  const owner = controlPlane.store.createUser({ email: 'http-owner@example.test', name: 'Owner', approvalStatus: 'APPROVED' });
  const recipient = controlPlane.store.createUser({ email: 'http-recipient@example.test', name: 'Recipient', approvalStatus: 'APPROVED' });
  const organization = controlPlane.store.createOrganization({ name: 'HTTP Org', slug: 'http-org' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });
  const captured = [];
  const secret = 'organization-invite-http-secret';
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret }, organizationInvites: { env: testEnv(), deliver: async message => { captured.push(message); } } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // When: OWNER issues via HTTP and the exact verified recipient accepts via HTTP.
    const ownerToken = signJwtHs256({ sub: owner.id, role: 'OWNER', organizationId: organization.id, sessionVersion: 0 }, secret);
    const issued = await request(server, 'POST', `/organizations/${organization.id}/invites`, { email: recipient.email, role: 'DB_ADMIN' }, ownerToken);
    assert.equal(issued.statusCode, 201, JSON.stringify(issued.body));
    const rawToken = new URL(captured[0].acceptanceUrl).searchParams.get('token');
    const recipientToken = signJwtHs256({ sub: recipient.id, role: 'VIEWER', organizationId: 'personal-scope', sessionVersion: 0 }, secret);
    const accepted = await request(server, 'POST', '/organization-invites/accept', { token: rawToken }, recipientToken);

    // Then: both wire responses are typed and the captured mail is the only raw-token surface.
    assert.equal(issued.body.invite.role, 'DB_ADMIN');
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body.status, 'accepted');
    assert.equal(JSON.stringify(issued.body).includes(rawToken), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('organization invitation happy path keeps Nest, OpenAPI, and typed client contracts aligned', async () => {
  // Given: the generated schema contract, committed OpenAPI artifact, Nest graph, and typed client.
  const document = YAML.parse(await fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  const expected = createOpenApiDocument();
  const runtime = await bootParityApi();
  const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: 'contract-only-token' });
  const operationIds = ['organizations-invites', 'organizations-invites-post', 'organization-invites-accept-post'];

  try {
    // When: each invitation operation is compared across all public backend surfaces.
    for (const operationId of operationIds) {
      const contract = apiOperations[operationId];
      const route = runtime.routes.find(candidate => candidate.path === contract.path && candidate.method === contract.method);

      // Then: path, status, permission, schema, and client binding agree exactly.
      assert.ok(route, `${operationId}: Nest route missing`);
      assert.equal(route.status, contract.status);
      assert.equal(route.permission, contract.permission);
      assert.deepEqual(document.paths[contract.path][contract.method], JSON.parse(JSON.stringify(expected.paths[contract.path][contract.method])));
      assert.equal(typeof client.operations[operationId], 'function');
    }
  } finally {
    await runtime.app.close();
  }
});

function invitationFixture() {
  const repository = new InMemoryControlPlaneRepository();
  const store = repository.store;
  const owner = store.createUser({ email: 'owner@example.test', name: 'Owner', sessionVersion: 0 });
  const recipient = store.createUser({ email: 'new@example.test', name: 'Recipient', sessionVersion: 0 });
  const organization = store.createOrganization({ name: 'Invite Org', slug: 'invite-org' });
  store.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });
  return { repository, store, owner, recipient, organization };
}

function testEnv() {
  return { NODE_ENV: 'test', RAIBITSERVER_APP_URL: 'https://dashboard.raibitserver.test', RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console', RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.test' };
}

function invalidInvite(error) {
  return error.code === 'organization_invite_invalid' && error.statusCode === 403;
}

async function request(server, method, path, body, token) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { statusCode: response.status, body: await response.json() };
}

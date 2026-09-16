import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import { IDENTITY_ORGANIZATION_ACCESSIBILITY, IDENTITY_ORGANIZATION_EXECUTION, IDENTITY_ORGANIZATION_MATRIX, IDENTITY_ORGANIZATION_VIEWPORTS, ORGANIZATION_ROLES } from '../apps/dashboard/tests/e2e/identity-organization-matrix.ts';

const jwtSecret = 'identity-organization-matrix-secret';

test('identity organization matrix maps every required identity, role, tenant, and outcome surface', () => {
  // Given: the reusable identity and organization journey matrix.
  const identities = new Set(IDENTITY_ORGANIZATION_MATRIX.map((row) => row.identity));
  const roles = new Set(IDENTITY_ORGANIZATION_MATRIX.flatMap((row) => [row.organizationA, row.organizationB]));

  // When: its executable and deferred coverage is inspected.
  const rowsAreMapped = IDENTITY_ORGANIZATION_MATRIX.every((row) => row.apiAssertion && row.browserOutcome && row.redactionAssertion);

  // Then: every required cohort has a mapped outcome without claiming deferred execution.
  assert.deepEqual([...identities].sort(), ['anonymous', 'expired-session', 'pending', 'revoked-session', 'unverified', 'verified-oauth-only', 'verified-password']);
  assert.equal(ORGANIZATION_ROLES.every((role) => roles.has(role)), true);
  assert.equal(roles.has('GLOBAL_ADMIN'), true);
  assert.deepEqual(IDENTITY_ORGANIZATION_VIEWPORTS.map(({ width }) => width), [320, 375, 390, 768, 1280]);
  assert.deepEqual(IDENTITY_ORGANIZATION_ACCESSIBILITY, ['keyboard', 'screen-reader-announcement', 'reduced-motion', 'zoom-200']);
  assert.equal(rowsAreMapped, true);
  assert.equal(IDENTITY_ORGANIZATION_EXECUTION.postgres.status, 'NOT_RUN');
  assert.equal(IDENTITY_ORGANIZATION_EXECUTION.browser.status, 'NOT_RUN');
});

test('identity organization happy journey crosses create, invite, role, leave, and logout over actual HTTP SDK calls', async (t) => {
  // Given: approved password/OAuth identities, two organizations, real memory persistence, and capture-mail delivery.
  const runtime = await startRuntime();
  const store = runtime.controlPlane.store;
  const owner = user(store, 'owner@matrix.test', { passwordHash: hashPassword('old-password') });
  const oauthOnly = user(store, 'oauth@matrix.test', { passwordHash: null });
  const oauthCreator = user(store, 'oauth-creator@matrix.test', { passwordHash: null });
  const globalAdmin = user(store, 'global@matrix.test', { passwordHash: 'password-hash', role: 'ADMIN' });
  const organizationA = store.createOrganization({ name: 'Matrix A', slug: 'matrix-a' });
  const organizationB = store.createOrganization({ name: 'Matrix B', slug: 'matrix-b' });
  store.addMember({ organizationId: organizationA.id, userId: owner.id, role: 'OWNER' });
  store.addMember({ organizationId: organizationB.id, userId: owner.id, role: 'OWNER' });
  store.addMember({ organizationId: organizationA.id, userId: oauthOnly.id, role: 'VIEWER' });
  store.addMember({ organizationId: organizationA.id, userId: oauthCreator.id, role: 'VIEWER' });
  const ownerClient = client(runtime.baseUrl, token(owner, { [organizationA.id]: 'OWNER', [organizationB.id]: 'OWNER' }));
  const oauthClient = client(runtime.baseUrl, token(oauthOnly, { [organizationA.id]: 'VIEWER' }));

  try {
    // When: users create tenants, accept a trusted invite, change role, leave, and logout in sequence.
    const oauthCreated = await client(runtime.baseUrl, token(oauthCreator, { [organizationA.id]: 'VIEWER' })).createOrganization({ name: 'OAuth Created', slug: 'oauth-created' });
    const globalCreated = await client(runtime.baseUrl, token(globalAdmin, {}, true)).createOrganization({ name: 'Global Created', slug: 'global-created' });
    const issued = await ownerClient.issueOrganizationInvite(organizationB.id, { email: oauthOnly.email, role: 'DEVELOPER' });
    const rawToken = new URL(runtime.deliveries.at(-1).acceptanceUrl).searchParams.get('token');
    const accepted = await oauthClient.acceptOrganizationInvite({ token: rawToken });
    await assert.rejects(oauthClient.listOrganizationMembers(organizationB.id), status(401));
    const acceptedClient = client(runtime.baseUrl, token(store.users.get(oauthOnly.id), { [organizationA.id]: 'VIEWER', [organizationB.id]: 'DEVELOPER' }));
    const member = (await ownerClient.listOrganizationMembers(organizationB.id)).members.find((row) => row.userId === oauthOnly.id);
    const changed = await ownerClient.changeOrganizationMembershipRole(organizationB.id, member.id, { role: 'VIEWER', expectedVersion: member.version });
    await assert.rejects(acceptedClient.listOrganizationMembers(organizationB.id), status(401));
    const currentClient = client(runtime.baseUrl, token(store.users.get(oauthOnly.id), { [organizationA.id]: 'VIEWER', [organizationB.id]: 'VIEWER' }));
    await currentClient.leaveOrganization(organizationB.id, { expectedVersion: changed.membership.version });
    await assert.rejects(currentClient.listOrganizationMembers(organizationB.id), status(401));
    await assert.rejects(client(runtime.baseUrl, token(store.users.get(oauthOnly.id), { [organizationA.id]: 'VIEWER' })).listOrganizationMembers(organizationB.id), status(404));
    const anonymous = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl });
    assert.deepEqual(await anonymous.requestPasswordReset({ email: owner.email }), { accepted: true });
    for (let attempt = 0; attempt < 100 && !store.emailDeliveries.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const code = store.emailDeliveries[0].text.match(/\b\d{6}\b/)?.[0];
    assert.deepEqual(await anonymous.completePasswordReset({ email: owner.email, code, newPassword: 'new-password' }), { reset: true });
    await assert.rejects(ownerClient.me(), status(401));
    const login = await anonymous.login({ email: owner.email, password: 'new-password' });
    const logoutClient = client(runtime.baseUrl, login.token);
    assert.deepEqual(await logoutClient.logout(), { ok: true });
    await assert.rejects(logoutClient.me(), status(401));

    // Then: creation grants only new-tenant OWNER, membership changes revoke old JWTs, and no raw token leaks.
    assert.equal(oauthCreated.membership.role, 'OWNER');
    assert.equal(globalCreated.membership.role, 'OWNER');
    assert.equal(store.listMembershipsForUser(oauthOnly.id).find((row) => row.organizationId === organizationA.id).role, 'VIEWER');
    assert.deepEqual(accepted, { status: 'accepted', membership: { organizationId: organizationB.id, role: 'DEVELOPER' } });
    assert.equal(issued.invite.email, oauthOnly.email);
    assert.equal(JSON.stringify(store.snapshot()).includes(rawToken), false);
    assert.equal(JSON.stringify(store.auditLogs).includes(rawToken), false);
    t.diagnostic(JSON.stringify({ surface: 'actual local HTTP + typed SDK + memory repository + capture mail', create: 2, accept: 1, roleChange: 1, leave: 1, passwordReset: 1, relogin: 1, logout: 1, oldJwtDenials: 5, foreignScopeDenials: 1, tokenLeaks: 0 }));
  } finally {
    await runtime.close();
  }
});

test('identity organization adversarial matrix denies role, scope, email, replay, owner-race, and revoked-session attacks', async (t) => {
  // Given: every grantable role in organization A, a foreign organization B, and exact/foreign/unverified recipients.
  const runtime = await startRuntime();
  const store = runtime.controlPlane.store;
  const organizationA = store.createOrganization({ name: 'Adversarial A', slug: 'adversarial-a' });
  const organizationB = store.createOrganization({ name: 'Adversarial B', slug: 'adversarial-b' });
  const actors = Object.fromEntries(ORGANIZATION_ROLES.map((role) => {
    const actor = user(store, `${role.toLowerCase()}@matrix.test`, { passwordHash: 'password-hash' });
    store.addMember({ organizationId: organizationA.id, userId: actor.id, role });
    return [role, actor];
  }));
  const ownerB = user(store, 'owner-b@matrix.test', { passwordHash: 'password-hash' });
  store.addMember({ organizationId: organizationB.id, userId: ownerB.id, role: 'OWNER' });
  const target = user(store, 'target@matrix.test', { passwordHash: 'password-hash' });
  store.addMember({ organizationId: organizationA.id, userId: target.id, role: 'VIEWER' });
  const pending = user(store, 'pending@matrix.test', { approvalStatus: 'PENDING', passwordHash: 'password-hash' });
  const unverified = user(store, 'unverified@matrix.test', { emailVerifiedAt: null, passwordHash: 'password-hash' });
  const ownerClient = client(runtime.baseUrl, token(actors.OWNER, { [organizationA.id]: 'OWNER' }));

  try {
    // When: legal and illegal role changes, foreign scope, email mismatch, replay, and 20 last-owner writes are attempted.
    const organizationsBefore = store.organizations.size;
    await assert.rejects(new RAIBITSERVERClient({ baseUrl: runtime.baseUrl }).createOrganization({ name: 'Anonymous', slug: 'anonymous-claim' }), statusWithout(401, ['anonymous-claim']));
    await assert.rejects(client(runtime.baseUrl, token(pending, {})).createOrganization({ name: 'Pending', slug: 'pending-claim' }), statusWithout(401, ['pending-claim', pending.email]));
    await assert.rejects(client(runtime.baseUrl, token(unverified, {})).createOrganization({ name: 'Unverified', slug: 'unverified-claim' }), statusWithout(403, ['unverified-claim']));
    await assert.rejects(client(runtime.baseUrl, expiredToken(actors.VIEWER)).listOrganizationMembers(organizationA.id), statusWithout(401, [organizationA.id]));
    assert.equal(store.organizations.size, organizationsBefore);
    let targetView = (await ownerClient.listOrganizationMembers(organizationA.id)).members.find((row) => row.userId === target.id);
    const ownerChanged = await ownerClient.changeOrganizationMembershipRole(organizationA.id, targetView.id, { role: 'DB_ADMIN', expectedVersion: targetView.version });
    targetView = ownerChanged.membership;
    const adminClient = client(runtime.baseUrl, token(actors.ADMIN, { [organizationA.id]: 'ADMIN' }));
    const adminChanged = await adminClient.changeOrganizationMembershipRole(organizationA.id, targetView.id, { role: 'VIEWER', expectedVersion: targetView.version });
    targetView = adminChanged.membership;
    await assert.rejects(adminClient.changeOrganizationMembershipRole(organizationA.id, targetView.id, { role: 'OWNER', expectedVersion: targetView.version }), statusWithout(403, [target.email]));
    for (const role of ['MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER']) {
      await assert.rejects(client(runtime.baseUrl, token(actors[role], { [organizationA.id]: role })).changeOrganizationMembershipRole(organizationA.id, targetView.id, { role: 'DEVELOPER', expectedVersion: targetView.version }), status(403));
    }
    assert.equal(store.members.find((row) => row.organizationId === organizationA.id && row.userId === target.id).role, 'VIEWER');
    await assert.rejects(ownerClient.listOrganizationMembers(organizationB.id), statusWithout(404, [organizationB.name, ownerB.email]));
    const foreign = user(store, 'foreign@matrix.test', { passwordHash: 'password-hash' });
    const issued = await ownerClient.issueOrganizationInvite(organizationA.id, { email: target.email, role: 'DEVELOPER' });
    const rawToken = new URL(runtime.deliveries.at(-1).acceptanceUrl).searchParams.get('token');
    await assert.rejects(client(runtime.baseUrl, token(foreign, {})).acceptOrganizationInvite({ token: rawToken }), statusWithout(403, [organizationA.id, target.email]));
    const targetClient = client(runtime.baseUrl, token(store.users.get(target.id), { [organizationA.id]: 'VIEWER' }));
    assert.deepEqual(await targetClient.acceptOrganizationInvite({ token: rawToken }), { status: 'already_member' });
    await assert.rejects(targetClient.acceptOrganizationInvite({ token: rawToken }), statusWithout(403, [organizationA.id, target.email]));
    const claimed = await client(runtime.baseUrl, token(foreign, {})).createOrganization({ name: 'Claimed', slug: 'safe-claim' });
    await assert.rejects(client(runtime.baseUrl, token(unverified, {})).createOrganization({ name: 'Foreign Claim', slug: 'safe-claim' }), status(403));
    await assert.rejects(client(runtime.baseUrl, token(store.users.get(target.id), { [organizationA.id]: 'VIEWER' })).createOrganization({ name: 'Duplicate Claim', slug: 'safe-claim' }), statusWithout(409, [claimed.organization.id, foreign.email]));
    const soleOwnerView = (await client(runtime.baseUrl, token(ownerB, { [organizationB.id]: 'OWNER' })).listOrganizationMembers(organizationB.id)).members[0];
    const ownerBClient = client(runtime.baseUrl, token(ownerB, { [organizationB.id]: 'OWNER' }));
    const race = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => index % 2
      ? ownerBClient.leaveOrganization(organizationB.id, { expectedVersion: soleOwnerView.version })
      : ownerBClient.changeOrganizationMembershipRole(organizationB.id, soleOwnerView.id, { role: 'ADMIN', expectedVersion: soleOwnerView.version })));

    // Then: only legal authority succeeds, all races preserve one owner, and denials remain opaque and token-free.
    assert.equal(race.every((result) => result.status === 'rejected' && result.reason.status === 409), true);
    assert.equal(store.members.filter((row) => row.organizationId === organizationB.id && row.role === 'OWNER').length, 1);
    assert.equal(JSON.stringify(issued).includes(rawToken), false);
    assert.equal(JSON.stringify(store.snapshot()).includes(rawToken), false);
    assert.equal(claimed.membership.role, 'OWNER');
    t.diagnostic(JSON.stringify({ surface: 'actual local HTTP + typed SDK', identityDenials: 4, allowedRoleChanges: 2, deniedRoleChanges: 5, foreignScope: 1, foreignEmail: 1, replay: 1, safeClaimConflict: 1, lastOwnerRace: race.length, ownersRemaining: 1, tokenLeaks: 0 }));
  } finally {
    await runtime.close();
  }
});

async function startRuntime() {
  const previous = { from: process.env.RAIBITSERVER_EMAIL_FROM, code: process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE, mode: process.env.RAIBITSERVER_EMAIL_DELIVERY_MODE };
  process.env.RAIBITSERVER_EMAIL_FROM = 'Matrix <identity@raibitserver.test>';
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '246810';
  process.env.RAIBITSERVER_EMAIL_DELIVERY_MODE = 'console';
  const controlPlane = new RAIBITSERVERControlPlane();
  const deliveries = [];
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret }, organizationInvites: { env: { NODE_ENV: 'test', RAIBITSERVER_APP_URL: 'https://console.raibitserver.test', RAIBITSERVER_EMAIL_DOMAIN: 'raibitserver.test' }, deliver: async (message) => { deliveries.push(message); } } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return { controlPlane, deliveries, baseUrl: `http://127.0.0.1:${address.port}`, close: async () => { server.close(); await once(server, 'close'); restoreEnv('RAIBITSERVER_EMAIL_FROM', previous.from); restoreEnv('RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE', previous.code); restoreEnv('RAIBITSERVER_EMAIL_DELIVERY_MODE', previous.mode); } };
}

function user(store, email, overrides = {}) {
  return store.createUser({ email, name: email.split('@')[0], approvalStatus: 'APPROVED', emailVerifiedAt: new Date('2026-09-06T00:00:00Z').toISOString(), sessionVersion: 0, ...overrides });
}

function token(actor, rolesByOrganization, global = false) {
  return signJwtHs256({ sub: actor.id, role: global ? 'ADMIN' : Object.values(rolesByOrganization)[0] || 'VIEWER', organizationIds: Object.keys(rolesByOrganization), rolesByOrganization, global, sessionVersion: actor.sessionVersion }, jwtSecret);
}

function expiredToken(actor) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: actor.id, role: 'VIEWER', organizationIds: [], rolesByOrganization: {}, sessionVersion: actor.sessionVersion, iss: 'raibitserver', aud: 'raibitserver-api', jti: 'expired-matrix-session', iat: 1, exp: 2 });
  const signature = crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function client(baseUrl, bearer) {
  return new RAIBITSERVERClient({ baseUrl, token: bearer });
}

function status(expected) {
  return (error) => error.status === expected;
}

function statusWithout(expected, forbidden) {
  return (error) => error.status === expected && forbidden.every((value) => !JSON.stringify(error.body).includes(value));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { resourceConsoleHostname, serviceConsoleHostname, serviceHostname } from '../packages/core/src/domain-router.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const contract = JSON.parse(await fs.readFile(new URL('../test-fixtures/contracts/organization-roles-v1.json', import.meta.url), 'utf8'));

function hostnameForFixture(fixture) {
  if (fixture.kind === 'service' || fixture.kind === 'preview') return serviceHostname(fixture.input);
  if (fixture.kind === 'serviceConsole') return serviceConsoleHostname(fixture.input);
  return resourceConsoleHostname(fixture.input);
}

test('given existing generated route fixtures when organization is the tenant then hosts are byte-for-byte stable', () => {
  for (const fixture of contract.routeFixtures) {
    assert.equal(hostnameForFixture(fixture), fixture.host);
  }

  const first = serviceHostname({ organizationSlug: 'alpha-org', projectSlug: contract.sharedProjectSlug });
  const second = serviceHostname({ organizationSlug: 'beta-org', projectSlug: contract.sharedProjectSlug });
  assert.notEqual(first, second);
});

test('given the organization role contract when grant and read parsers are used then only canonical roles can be assigned', async () => {
  const roles = await import('../packages/schemas/src/organization-role.ts');
  const rbac = await import('../packages/core/src/rbac.ts');
  assert.deepEqual(roles.ORGANIZATION_MEMBERSHIP_ROLES, contract.grantableRoles);
  assert.deepEqual(rbac.ORGANIZATION_MEMBERSHIP_ROLES, contract.grantableRoles);
  assert.deepEqual(roles.LEGACY_ORGANIZATION_ROLE_ALIASES, contract.legacyReadAliases);
  assert.deepEqual(rbac.LEGACY_ORGANIZATION_ROLE_ALIASES, contract.legacyReadAliases);
  for (const role of contract.grantableRoles) {
    assert.equal(roles.MembershipRoleMutationSchema.safeParse(role).success, true, role);
    assert.equal(rbac.parseOrganizationMembershipRoleForMutation(role).ok, true, role);
  }
  for (const alias of contract.legacyReadAliases) {
    assert.equal(roles.MembershipRoleMutationSchema.safeParse(alias).success, false, alias);
    assert.equal(roles.MembershipRoleReadSchema.safeParse(alias).success, true, alias);
    assert.equal(roles.normalizeOrganizationRoleForRead(alias), contract.readAliasRole);
    assert.equal(rbac.normalizeOrganizationRoleForRead(alias), contract.readAliasRole);
    assert.equal(rbac.parseOrganizationMembershipRoleForMutation(alias).ok, false, alias);
  }
});

test('given the role matrix when permissions and transitions are evaluated then every authority is explicit', async () => {
  const rbac = await import('../packages/core/src/rbac.ts');
  for (const [role, actions] of Object.entries(contract.permissionMatrix)) {
    for (const action of actions) assert.equal(rbac.can(role, action), true, `${role} -> ${action}`);
  }
  for (const [actorRole, grants] of Object.entries(contract.transitionAuthority)) {
    for (const targetRole of contract.grantableRoles) {
      const result = rbac.membershipRoleTransition({ actorRole, targetRole, currentRole: 'VIEWER', ownerCount: 2 });
      assert.equal(result.statusCode, grants.includes(targetRole) ? 200 : 403, `${actorRole} -> ${targetRole}`);
    }
  }
});

test('adversarial role and route matrix', async () => {
  const roles = await import('../packages/schemas/src/organization-role.ts');
  const rbac = await import('../packages/core/src/rbac.ts');

  for (const slug of contract.invalidTenantSlugs) {
    const result = roles.parseOrganizationRouteSlug(slug);
    assert.equal(result.statusCode, 400, slug);
    assert.deepEqual(rbac.parseOrganizationRouteSlug(slug), result, slug);
  }
  assert.equal(rbac.membershipRoleTransition({ actorRole: 'ADMIN', targetRole: 'OWNER', currentRole: 'VIEWER', ownerCount: 2 }).statusCode, 403);
  assert.equal(rbac.membershipRoleTransition({ actorRole: 'OWNER', targetRole: 'VIEWER', currentRole: 'OWNER', ownerCount: 1 }).statusCode, 409);
  assert.equal(rbac.membershipRoleTransition({ actorRole: 'VIEWER', targetRole: 'DEVELOPER', currentRole: 'VIEWER', ownerCount: 2 }).statusCode, 403);

  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Role Contract', slug: 'role-contract' });
  const user = store.createUser({ email: 'role-contract@example.com', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  assert.throws(
    () => store.addMember({ organizationId: organization.id, userId: user.id, role: 'billing-manager' }),
    (error) => error.statusCode === 400,
  );
  assert.throws(
    () => store.addMember({ organizationId: organization.id, userId: user.id, role: 'VIEWER' }),
    (error) => error.statusCode === 409,
  );
  assert.throws(
    () => store.removeMember({ organizationId: organization.id, userId: user.id }),
    (error) => error.statusCode === 409,
  );
  const secondOwner = store.createUser({ email: 'role-contract-second@example.com', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: secondOwner.id, role: 'OWNER' });
  assert.throws(
    () => store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER', actorRole: 'ADMIN' }),
    (error) => error.statusCode === 403,
  );
});

test('given an explicit organization route slug when direct, repository, and API creation occur then invalid input is a typed 400 before normalization', async () => {
  const invalidSlugs = ['api', '*foo', '1.2.3.4', 'a'.repeat(64)];
  const store = new ControlPlaneStore();
  for (const slug of invalidSlugs) {
    assert.throws(
      () => store.createOrganization({ name: 'Invalid Route', slug }),
      (error) => error.statusCode === 400 && error.message.startsWith('organization_route_slug_'),
      slug,
    );
  }
  assert.equal(store.createOrganization({ name: 'Stable Route', slug: 'stable-route' }).slug, 'stable-route');

  let upsertCalled = false;
  const repository = new PrismaControlPlaneRepository({
    organization: {
      upsert: async () => {
        upsertCalled = true;
        return { id: 'org_stable', name: 'Stable Route', slug: 'stable-route', plan: 'free' };
      },
    },
  });
  for (const slug of invalidSlugs) {
    await assert.rejects(
      repository.createOrganization({ name: 'Invalid Route', slug }),
      (error) => error.statusCode === 400 && error.message.startsWith('organization_route_slug_'),
      slug,
    );
  }
  assert.equal(upsertCalled, false);
  assert.equal((await repository.createOrganization({ name: 'Stable Route', slug: 'stable-route' })).slug, 'stable-route');

  store.emailVerificationCodes.push({
    id: 'email_1', email: 'in-memory-route-boundary@example.test', purpose: 'signup', expiresAt: new Date(Date.now() + 60_000).toISOString(), attempts: 0, consumedAt: null,
    payload: { kind: 'signup', organizationSlug: 'api' },
  });
  assert.throws(
    () => store.completeSignupEmailVerification({ email: 'in-memory-route-boundary@example.test', verifyCode: () => true }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_reserved',
  );
  assert.equal(store.emailVerificationCodes.at(-1).consumedAt, null);

  let verificationClaimed = false;
  const prismaSignupRepository = new PrismaControlPlaneRepository({
    $transaction: async (callback) => callback({
      emailVerificationCode: {
        findFirst: async () => ({ id: 'email_1', expiresAt: new Date(Date.now() + 60_000), attempts: 0, payload: { kind: 'signup', organizationSlug: 'api' } }),
        updateMany: async () => { verificationClaimed = true; return { count: 1 }; },
      },
    }),
  });
  await assert.rejects(
    prismaSignupRepository.completeSignupEmailVerification({ email: 'route-boundary@example.test', verifyCode: () => true }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_reserved',
  );
  assert.equal(verificationClaimed, false);

  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, {
    auth: { mode: 'disabled', allowDisabled: true, defaultRole: 'owner', jwtSecret: 'route-boundary-test-secret' },
  }));
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const directResponse = await requestJson(port, '/organizations', { name: 'Invalid Route', slug: 'api' });
    assert.equal(directResponse.statusCode, 400);
    assert.equal(directResponse.body.error, 'organization_route_slug_reserved');

    const signupResponse = await requestJson(port, '/auth/signup', {
      name: 'Signup Route', studentId: '2600', clubMemberClaim: false, email: 'route-boundary@example.test', password: 'correct-horse', organizationSlug: '*foo',
    });
    assert.equal(signupResponse.statusCode, 400);
    assert.equal(signupResponse.body.error, 'organization_route_slug_invalid');
    assert.equal(controlPlane.store.emailVerificationCodes.length, 0);

    const validSignupResponse = await requestJson(port, '/auth/signup', {
      name: 'Signup Route', studentId: '2600', clubMemberClaim: false, email: 'stable-route@example.test', password: 'correct-horse', organizationSlug: 'stable-signup-route',
    });
    assert.equal(validSignupResponse.statusCode, 201);
    assert.equal(controlPlane.store.emailVerificationCodes.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

function requestJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

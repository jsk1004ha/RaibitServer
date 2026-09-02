import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { resourceConsoleHostname, serviceConsoleHostname, serviceHostname } from '../packages/core/src/domain-router.ts';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { resourceConsoleHostname, serviceConsoleHostname, serviceHostname } from '../packages/core/src/domain-router.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { issueSignupEmailVerificationCode, verifyEmailCodeAndCreateSession } from '../packages/core/src/email-verification.ts';

const contract = JSON.parse(await fs.readFile(new URL('../test-fixtures/contracts/organization-roles-v1.json', import.meta.url), 'utf8'));
const verificationEnv = Object.freeze({
  NODE_ENV: 'test',
  RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <route-role@example.test>',
  RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '246810',
});
const verificationOptions = Object.freeze({ jwtSecret: 'route-role-verification-secret', issuer: 'raibitserver-route-role-test', env: verificationEnv });

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

  for (const slug of [...contract.invalidTenantSlugs, 'alpha--demo']) {
    const result = roles.parseOrganizationRouteSlug(slug);
    assert.equal(result.statusCode, 400, slug);
    assert.deepEqual(rbac.parseOrganizationRouteSlug(slug), result, slug);
    assert.equal(roles.OrganizationRouteSlugSchema.safeParse(slug).success, false, slug);
  }
  for (const slug of ['valid-route', 'a'.repeat(63)]) {
    const result = roles.parseOrganizationRouteSlug(slug);
    assert.equal(result.statusCode, 200, slug);
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

test('given a normalized sole owner when any caller demotes it then Store and Prisma reject without writes', async () => {
  for (const storedRole of ['owner', 'OWNER']) {
    for (const actorRole of [undefined, 'OWNER', 'VIEWER']) {
      const store = new ControlPlaneStore();
      const actorLabel = String(actorRole || 'none').toLowerCase();
      const organization = store.createOrganization({ name: `Sole ${storedRole}`, slug: `sole-${storedRole.toLowerCase()}-${actorLabel}` });
      const user = store.createUser({ email: `sole-${storedRole.toLowerCase()}-${actorLabel}@example.test`, approvalStatus: 'APPROVED' });
      store.addMember({ organizationId: organization.id, userId: user.id, role: storedRole });
      const before = {
        membership: structuredClone(store.members.find((member) => member.organizationId === organization.id && member.userId === user.id)),
        sessionVersion: store.users.get(user.id).sessionVersion,
        auditCount: store.auditLogs.length,
      };
      const input = { organizationId: organization.id, userId: user.id, role: 'VIEWER', ...(actorRole === undefined ? {} : { actorRole }) };
      assert.throws(() => store.addMember(input), (error) => error.statusCode === 409 && error.message === 'membership_last_owner', `${storedRole}/${actorRole || 'actorless'}`);
      assert.deepEqual(store.members.find((member) => member.organizationId === organization.id && member.userId === user.id), before.membership);
      assert.equal(store.users.get(user.id).sessionVersion, before.sessionVersion);
      assert.equal(store.auditLogs.length, before.auditCount);

      let upserts = 0;
      let sessionMutations = 0;
      const repository = new PrismaControlPlaneRepository({
        $transaction: async (callback) => callback({
          membership: {
            findUnique: async () => ({ role: storedRole }),
            count: async () => 1,
            upsert: async () => { upserts += 1; return { role: 'VIEWER' }; },
          },
          user: { update: async () => { sessionMutations += 1; return {}; } },
        }),
      });
      await assert.rejects(repository.addMember(input), (error) => error.statusCode === 409 && error.message === 'membership_last_owner', `Prisma ${storedRole}/${actorRole || 'actorless'}`);
      assert.equal(upserts, 0);
      assert.equal(sessionMutations, 0);
    }
  }

  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Two Owners', slug: 'two-owners' });
  const first = store.createUser({ email: 'two-owners-first@example.test', approvalStatus: 'APPROVED' });
  const second = store.createUser({ email: 'two-owners-second@example.test', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: first.id, role: 'owner' });
  store.addMember({ organizationId: organization.id, userId: second.id, role: 'OWNER' });
  const priorSessionVersion = store.users.get(first.id).sessionVersion;
  const priorAuditCount = store.auditLogs.length;
  assert.equal(store.addMember({ organizationId: organization.id, userId: first.id, role: 'VIEWER' }).role, 'VIEWER');
  assert.equal(store.users.get(first.id).sessionVersion, priorSessionVersion + 1);
  assert.equal(store.auditLogs.length, priorAuditCount + 1);
});

test('given explicit double-hyphen organization slugs when signup and verification run in either order then identity state cannot collide', async () => {
  for (const validFirst of [false, true]) {
    const repository = new InMemoryControlPlaneRepository();
    const validEmail = `valid-${validFirst ? 'first' : 'second'}@example.test`;
    const rejectedEmail = `rejected-${validFirst ? 'second' : 'first'}@example.test`;
    const issue = (email, organizationSlug) => issueSignupEmailVerificationCode(repository, {
      email,
      password: 'correct-horse',
      name: email.split('@')[0],
      studentId: '2600',
      organizationSlug,
    }, verificationOptions);
    const verify = (email) => verifyEmailCodeAndCreateSession(repository, { email, code: '246810' }, verificationOptions);

    if (validFirst) {
      await issue(validEmail, 'alpha-demo');
      await verify(validEmail);
      const victim = repository.store.findOrganizationBySlug('alpha-demo');
      repository.store.createProject({ organizationId: victim.id, name: 'victim-project' });
    }

    const beforeRejectedSignup = {
      organizations: repository.store.organizations.size,
      users: repository.store.users.size,
      members: structuredClone(repository.store.members),
      projects: structuredClone([...repository.store.projects.values()]),
      codes: structuredClone(repository.store.emailVerificationCodes),
    };
    await assert.rejects(issue(rejectedEmail, 'alpha--demo'), (error) => error.statusCode === 400 && error.message === 'organization_route_slug_invalid');
    assert.equal(repository.store.emailVerificationCodes.some((code) => code.email === rejectedEmail), false);
    assert.equal(repository.store.organizations.size, beforeRejectedSignup.organizations);
    assert.equal(repository.store.users.size, beforeRejectedSignup.users);
    assert.deepEqual(repository.store.members, beforeRejectedSignup.members);
    assert.deepEqual([...repository.store.projects.values()], beforeRejectedSignup.projects);
    assert.deepEqual(repository.store.emailVerificationCodes, beforeRejectedSignup.codes);

    if (!validFirst) {
      await issue(validEmail, 'alpha-demo');
      await verify(validEmail);
    }
    const organization = repository.store.findOrganizationBySlug('alpha-demo');
    const user = repository.store.findUserByEmail(validEmail);
    const project = repository.store.createProject({ organizationId: organization.id, name: 'api', slug: 'api' });
    assert.equal(repository.store.organizations.size, 1);
    assert.equal(repository.store.members.length, 1);
    assert.equal(repository.store.members[0].organizationId, organization.id);
    assert.equal(repository.store.members[0].userId, user.id);
    assert.equal(project.organizationId, organization.id);
  }
});

test('given an explicit organization route slug when direct, repository, and API creation occur then invalid input is a typed 400 before normalization', async () => {
  const invalidSlugs = ['api', '*foo', '1.2.3.4', 'alpha--demo', 'a'.repeat(64)];
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

  const desiredOrganizationUpserts = [];
  const desiredProjectUpserts = [];
  const desiredProjectRepository = new PrismaControlPlaneRepository({
    $transaction: async (callback) => callback({
      organization: {
        findUnique: async () => null,
        upsert: async (input) => {
          desiredOrganizationUpserts.push(input);
          return { id: 'org_desired', name: input.create.name, slug: input.create.slug, plan: input.create.plan };
        },
      },
      project: {
        findUnique: async () => null,
        upsert: async (input) => {
          desiredProjectUpserts.push(input);
          return { id: 'project_desired', organizationId: input.create.organizationId, slug: input.create.slug };
        },
      },
      auditLog: { create: async () => ({}) },
    }),
  });
  await assert.rejects(
    desiredProjectRepository.writeDesiredProject({ organization: { name: 'Invalid Desired Organization', slug: 'api' }, project: { name: 'desired-project', slug: 'desired-project' } }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_reserved',
  );
  assert.equal(desiredOrganizationUpserts.length, 0);

  await assert.rejects(
    desiredProjectRepository.writeDesiredProject({ organizationSlug: 'api', project: { name: 'defaulted-project', slug: 'defaulted-project' } }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_reserved',
  );
  assert.equal(desiredOrganizationUpserts.length, 0);

  await assert.rejects(
    desiredProjectRepository.writeDesiredProject({ organization: { name: 'Double Hyphen Organization', slug: 'alpha--demo' }, project: { name: 'desired-project', slug: 'desired-project' } }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_invalid',
  );
  await assert.rejects(
    desiredProjectRepository.writeDesiredProject({ organizationSlug: 'alpha--demo', project: { name: 'defaulted-project', slug: 'defaulted-project' } }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_invalid',
  );
  assert.equal(desiredOrganizationUpserts.length, 0);

  const validDesired = await desiredProjectRepository.writeDesiredProject({ organization: { name: 'Valid Desired Organization', slug: 'valid-desired-org' }, project: { name: 'desired-project', slug: 'desired-project' } });
  assert.equal(validDesired.organization.slug, 'valid-desired-org');
  assert.equal(desiredOrganizationUpserts.at(-1).where.slug, 'valid-desired-org');
  assert.equal(desiredProjectUpserts.at(-1).create.organizationId, 'org_desired');

  let existingOrganizationUpserts = 0;
  const existingOrganizationRepository = new PrismaControlPlaneRepository({
    $transaction: async (callback) => callback({
      organization: {
        findUnique: async ({ where }) => where.id === 'org_existing' ? { id: 'org_existing', name: 'Existing Organization', slug: 'api', plan: 'free' } : null,
        upsert: async () => { existingOrganizationUpserts += 1; throw new Error('unexpected organization upsert'); },
      },
      project: {
        findUnique: async () => null,
        upsert: async (input) => ({ id: 'project_existing', organizationId: input.create.organizationId, slug: input.create.slug }),
      },
      auditLog: { create: async () => ({}) },
    }),
  });
  const existingDesired = await existingOrganizationRepository.writeDesiredProject({ organizationId: 'org_existing', project: { name: 'existing-project', slug: 'existing-project' } });
  assert.equal(existingDesired.organization.id, 'org_existing');
  assert.equal(existingOrganizationUpserts, 0);

  store.emailVerificationCodes.push({
    id: 'email_1', email: 'in-memory-route-boundary@example.test', purpose: 'signup', expiresAt: new Date(Date.now() + 60_000).toISOString(), attempts: 0, consumedAt: null,
    payload: { kind: 'signup', organizationSlug: 'alpha--demo' },
  });
  assert.throws(
    () => store.completeSignupEmailVerification({ email: 'in-memory-route-boundary@example.test', verifyCode: () => true }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_invalid',
  );
  assert.equal(store.emailVerificationCodes.at(-1).consumedAt, null);

  let verificationClaimed = false;
  const prismaSignupRepository = new PrismaControlPlaneRepository({
    $transaction: async (callback) => callback({
      emailVerificationCode: {
        findFirst: async () => ({ id: 'email_1', expiresAt: new Date(Date.now() + 60_000), attempts: 0, payload: { kind: 'signup', organizationSlug: 'alpha--demo' } }),
        updateMany: async () => { verificationClaimed = true; return { count: 1 }; },
      },
    }),
  });
  await assert.rejects(
    prismaSignupRepository.completeSignupEmailVerification({ email: 'route-boundary@example.test', verifyCode: () => true }),
    (error) => error.statusCode === 400 && error.message === 'organization_route_slug_invalid',
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
    const signupResponse = await requestJson(port, '/auth/signup', {
      name: 'Signup Route', studentId: '2600', clubMemberClaim: false, email: 'route-boundary@example.test', password: 'correct-horse', organizationSlug: 'alpha--demo',
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

function tenantState(store) {
  return structuredClone({
    organizations: [...store.organizations], users: [...store.users], members: store.members,
    projects: [...store.projects], auditLogs: store.auditLogs, codes: store.emailVerificationCodes,
  });
}

for (const [scenario, first, second] of [
  ['long-slug forward', ['victim@example.test', 'x'.repeat(59) + 'a'], ['other@example.test', 'x'.repeat(59) + 'b']],
  ['long-slug reverse', ['victim@example.test', 'x'.repeat(59) + 'b'], ['other@example.test', 'x'.repeat(59) + 'a']],
  ['email forward', ['victim.a@example.test', 'victim-org'], ['victim-a@example.test', 'other-org']],
  ['email reverse', ['victim-a@example.test', 'victim-org'], ['victim.a@example.test', 'other-org']],
]) {
  test(`given a victim project when ${scenario} signup is verified then conflict preserves all tenant state and the challenge`, async () => {
    // Given a verified tenant owning a project before the distinct identity attempts signup.
    const repository = new InMemoryControlPlaneRepository();
    const issue = ([email, organizationSlug]) => issueSignupEmailVerificationCode(repository, {
      email, organizationSlug, name: 'Member', studentId: '2600', password: 'correct-horse',
    }, verificationOptions);
    const verify = ([email]) => verifyEmailCodeAndCreateSession(repository, { email, code: '246810' }, verificationOptions);
    await issue(first);
    await verify(first);
    const victim = repository.store.findOrganizationBySlug(first[1]);
    repository.store.createProject({ organizationId: victim.id, name: 'victim-project' });
    await issue(second);
    assert.equal(repository.store.emailVerificationCodes.at(-1).payload.kind, 'signup');
    const before = tenantState(repository.store);

    // When the real verification service completes the colliding signup.
    await assert.rejects(verify(second), (error) => error.statusCode === 409);

    // Then no organization, user, membership, project, audit or challenge field changed.
    assert.deepEqual(tenantState(repository.store), before);
    assert.equal(repository.store.emailVerificationCodes.at(-1).consumedAt, null);
  });
}

test('given colliding project identity parts when either organization creates then the victim project and audit remain unchanged', () => {
  for (const reverse of [false, true]) {
    // Given distinct existing organizations whose multipart project IDs collide.
    const store = new ControlPlaneStore();
    const alphaBeta = store.createOrganization({ name: 'Alpha Beta', slug: 'alpha-beta' });
    const alpha = store.createOrganization({ name: 'Alpha', slug: 'alpha' });
    const pair = [{ organizationId: alphaBeta.id, name: 'gamma' }, { organizationId: alpha.id, name: 'beta-gamma' }];
    if (reverse) pair.reverse();
    store.createProject(pair[0]);
    const before = tenantState(store);
    // When the other tenant creates its project, then fail closed before replacing the victim.
    assert.throws(() => store.createProject(pair[1]), (error) => error.statusCode === 409);
    assert.deepEqual(tenantState(store), before);
  }
});

test('given colliding organization and user keys when direct creation runs then identities are preserved and same-identity updates remain valid', () => {
  // Given existing normal identities and a long-slug tenant.
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Stable', slug: 'stable-route' });
  const user = store.createUser({ name: 'Victim', email: 'victim.a@example.test' });
  const project = store.createProject({ organizationId: organization.id, name: 'web' });
  store.createOrganization({ name: 'Long', slug: 'x'.repeat(59) + 'a' });
  const before = tenantState(store);
  // When distinct identities share a key, then reject; normal same-identity updates keep literal IDs.
  assert.throws(() => store.createOrganization({ name: 'Other', slug: 'x'.repeat(59) + 'b' }), (error) => error.statusCode === 409);
  assert.throws(() => store.createUser({ name: 'Other', email: 'victim-a@example.test' }), (error) => error.statusCode === 409);
  assert.deepEqual(tenantState(store), before);
  assert.equal(store.createOrganization({ name: 'Updated', slug: 'stable-route' }).id, 'org-stable-route');
  assert.equal(store.createUser({ name: 'Updated', email: 'VICTIM.A@EXAMPLE.TEST' }).id, user.id);
  assert.equal(store.createProject({ organizationId: organization.id, name: 'Updated', slug: 'web' }).id, project.id);
  assert.equal(project.id, 'prj-org-stable-route-web');
});

test('given an existing organization when explicit invalid nested desired slugs are supplied then both repositories reject before lookup or writes', async (t) => {
  for (const explicit of [{ organizationSlug: 'alpha--demo' }, { organization: { name: 'Ignored', slug: 'alpha--demo' } }]) {
    for (const useId of [false, true]) {
      // Given a victim organization/project and a Prisma seam that can resolve that existing ID.
      const repository = new InMemoryControlPlaneRepository();
      const organization = repository.store.createOrganization({ name: 'Alpha', slug: 'alpha-demo' });
      repository.store.createProject({ organizationId: organization.id, name: 'victim' });
      const input = { ...explicit, ...(useId ? { organizationId: organization.id } : {}), project: { name: 'other' } };
      const before = tenantState(repository.store);
      const calls = { lookups: 0, organizations: 0, projects: 0, audits: 0 };
      const prisma = new PrismaControlPlaneRepository({
        $transaction: async (callback) => callback({
          organization: {
            findUnique: async () => { calls.lookups += 1; return organization; },
            upsert: async () => { calls.organizations += 1; return organization; },
          },
          project: {
            findUnique: async () => { calls.lookups += 1; return null; },
            upsert: async () => { calls.projects += 1; return { id: 'other', organizationId: organization.id }; },
          },
          auditLog: { create: async () => { calls.audits += 1; return {}; } },
        }),
      });
      // When explicit invalid slugs accompany existing lookup inputs, then no lookup/mutation occurs.
      await t.test(`memory ${Object.keys(explicit)[0]} id=${useId}`, async () => {
        await assert.rejects(repository.writeDesiredProject(input), (error) => error.statusCode === 400);
        assert.deepEqual(tenantState(repository.store), before);
      });
      await t.test(`Prisma ${Object.keys(explicit)[0]} id=${useId}`, async () => {
        await assert.rejects(prisma.writeDesiredProject(input), (error) => error.statusCode === 400);
        assert.deepEqual(calls, { lookups: 0, organizations: 0, projects: 0, audits: 0 });
      });
    }
  }
});

test('given mixed and foreign Prisma memberships when one or two owners are demoted then the actual count query controls writes', async () => {
  for (const storedRole of ['OWNER', 'owner']) {
    for (const ownerCount of [1, 2]) {
      for (const actorRole of [undefined, 'OWNER', 'VIEWER']) {
        // Given real records filtered by the production query, including misleading foreign owners and local viewers.
        const members = [
          { organizationId: 'target-org', userId: 'target-user', role: storedRole },
          { organizationId: 'target-org', userId: 'viewer', role: 'VIEWER' },
          { organizationId: 'foreign-org', userId: 'foreign-upper', role: 'OWNER' },
          { organizationId: 'foreign-org', userId: 'foreign-lower', role: 'owner' },
          ...(ownerCount === 2 ? [{ organizationId: 'target-org', userId: 'second-owner', role: storedRole === 'OWNER' ? 'owner' : 'OWNER' }] : []),
        ];
        const before = structuredClone(members);
        const counters = { counts: 0, upserts: 0, sessions: 0 };
        const repository = new PrismaControlPlaneRepository({
          $transaction: async (callback) => callback({
            membership: {
              findUnique: async ({ where }) => structuredClone(members.find((row) => row.organizationId === where.organizationId_userId.organizationId && row.userId === where.organizationId_userId.userId)),
              count: async ({ where }) => {
                counters.counts += 1;
                return members.filter((row) => row.organizationId === where.organizationId && where.role.in.includes(row.role)).length;
              },
              upsert: async ({ where, update }) => {
                counters.upserts += 1;
                const row = members.find((item) => item.organizationId === where.organizationId_userId.organizationId && item.userId === where.organizationId_userId.userId);
                Object.assign(row, update);
                return row;
              },
            },
            user: { update: async ({ where, data }) => {
              assert.equal(where.id, 'target-user');
              counters.sessions += data.sessionVersion.increment;
              return {};
            } },
          }),
        });
        const input = { organizationId: 'target-org', userId: 'target-user', role: 'VIEWER', ...(actorRole === undefined ? {} : { actorRole }) };
        // When the repository demotes the member, then only two owners plus an authorized/absent actor allow it.
        const allowed = ownerCount === 2 && actorRole !== 'VIEWER';
        if (allowed) {
          assert.equal((await repository.addMember(input)).role, 'VIEWER');
          assert.deepEqual(counters, { counts: 1, upserts: 1, sessions: 1 });
          assert.deepEqual(members.slice(1), before.slice(1));
        } else {
          await assert.rejects(repository.addMember(input), (error) => error.statusCode === (ownerCount === 1 ? 409 : 403));
          assert.deepEqual(counters, { counts: 1, upserts: 0, sessions: 0 });
          assert.deepEqual(members, before);
        }
      }
    }
  }
});

test('given valid organization references when desired projects are written then existing IDs and derived names remain usable', async () => {
  // Given a known organization plus a Prisma seam using normal generated IDs.
  const memory = new InMemoryControlPlaneRepository();
  const existing = memory.store.createOrganization({ name: 'Existing', slug: 'existing-org' });
  const byId = await memory.writeDesiredProject({ organizationId: existing.id, project: { name: 'web' } });
  assert.equal(byId.organization.id, existing.id);
  const byName = await memory.writeDesiredProject({ organization: { name: 'Existing Org' }, project: { name: 'worker' } });
  assert.equal(byName.organization.id, existing.id);
  const prisma = new PrismaControlPlaneRepository({
    $transaction: async (callback) => callback({
      organization: {
        findUnique: async ({ where }) => where.id === existing.id ? existing : null,
        upsert: async ({ create }) => ({ id: 'generated-org-id', ...create }),
      },
      project: {
        findUnique: async () => null,
        upsert: async ({ create }) => ({ id: 'generated-project-id', ...create }),
      },
      auditLog: { create: async () => ({}) },
    }),
  });
  // When valid ID or derived-name inputs are used, then they retain their prior resolution.
  assert.equal((await prisma.writeDesiredProject({ organizationId: existing.id, project: { name: 'web' } })).organization.id, existing.id);
  assert.equal((await prisma.writeDesiredProject({ organization: { name: 'Derived Org' }, project: { name: 'web' } })).organization.slug, 'derived-org');
});

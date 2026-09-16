import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainLifecycleError,
  matchesDomainChallenge,
  normalizeCustomHostname,
} from '../packages/core/src/domain.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { can } from '../packages/core/src/rbac.ts';

function fixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Domain Team', slug: 'domain-team' });
  const project = store.createProject({ organizationId: organization.id, name: 'Site', slug: 'site' });
  const service = store.createService({ projectId: project.id, name: 'Web', slug: 'web', type: 'web' });
  return { store, organization, project, service };
}

test('custom domain API happy path creates, verifies, rotates and deletes desired state without retaining a raw challenge', () => {
  // Given
  const { store, organization, project, service } = fixture();
  const now = new Date('2026-09-06T00:00:00.000Z');

  // When
  const created = store.createCustomDomain({
    organizationId: organization.id,
    projectId: project.id,
    serviceId: service.id,
    hostname: 'B\u00dcCHER.Example.',
    actorUserId: 'owner-1',
    now,
  });

  // Then
  assert.equal(created.domain.hostname, 'xn--bcher-kva.example');
  assert.match(created.challengeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(matchesDomainChallenge(created.challengeToken, store.domains.get(created.domain.id).verificationTokenHash), true);
  assert.equal(JSON.stringify(created.domain).includes(created.challengeToken), false);
  assert.equal(JSON.stringify(store.snapshot()).includes(created.challengeToken), false);

  const requested = store.requestCustomDomainVerification(created.domain.id, { expectedVersion: 1, actorUserId: 'maintainer-1', now });
  assert.equal(requested.verificationRequestedAt, now.toISOString());
  const rotated = store.rotateCustomDomainChallenge(created.domain.id, { expectedVersion: 1, actorUserId: 'owner-1', now: new Date(now.getTime() + 1_000) });
  assert.equal(rotated.domain.verificationVersion, 2);
  assert.equal(rotated.domain.cleanupBarrier.version, 1);
  assert.equal(rotated.domain.cleanupBarrier.complete, false);
  assert.equal(rotated.domain.verifiedAt, null);
  assert.equal(rotated.domain.tlsStatus, 'PENDING');
  assert.equal(matchesDomainChallenge(created.challengeToken, store.domains.get(created.domain.id).verificationTokenHash), false);
  assert.equal(store.requestCustomDomainDeletion(created.domain.id, { expectedVersion: 2, actorUserId: 'owner-1', now }).status, 'DELETING');
});

test('custom domain API adversarial matrix rejects invalid, duplicate, stale and cross-scope bindings', () => {
  // Given
  const { store, organization, project, service } = fixture();
  const secondProject = store.createProject({ organizationId: organization.id, name: 'Other', slug: 'other' });
  const privateService = store.createService({ projectId: project.id, name: 'Worker', slug: 'worker', type: 'worker' });
  const foreignService = store.createService({ projectId: secondProject.id, name: 'Foreign', slug: 'foreign', type: 'web' });
  const invalid = ['127.0.0.1', '[::1]', '*.example.com', 'localhost', 'bad_label.example', `${'a'.repeat(64)}.example`, 'apps.raibitserver.app'];

  // When
  const attempts = invalid.map((hostname) => () => normalizeCustomHostname(hostname));

  // Then
  for (const attempt of attempts) assert.throws(attempt, DomainLifecycleError);
  assert.throws(() => store.createCustomDomain({ organizationId: organization.id, projectId: project.id, serviceId: privateService.id, hostname: 'worker.example', actorUserId: 'owner-1' }), /DOMAIN_SERVICE_NOT_PUBLIC_WEB/);
  assert.throws(() => store.createCustomDomain({ organizationId: organization.id, projectId: project.id, serviceId: foreignService.id, hostname: 'foreign.example', actorUserId: 'owner-1' }), /DOMAIN_SCOPE_NOT_FOUND/);
  const created = store.createCustomDomain({ organizationId: organization.id, projectId: project.id, serviceId: service.id, hostname: 'unique.example', actorUserId: 'owner-1' });
  assert.throws(() => store.createCustomDomain({ organizationId: organization.id, projectId: project.id, serviceId: service.id, hostname: 'UNIQUE.EXAMPLE.', actorUserId: 'owner-1' }), /DOMAIN_HOSTNAME_CONFLICT/);
  assert.throws(() => store.rotateCustomDomainChallenge(created.domain.id, { expectedVersion: 2, actorUserId: 'owner-1' }), /DOMAIN_VERSION_CONFLICT/);
  assert.equal(can('OWNER', 'domain:manage'), true);
  assert.equal(can('ADMIN', 'domain:manage'), true);
  assert.equal(can('MAINTAINER', 'domain:manage'), false);
  assert.equal(can('MAINTAINER', 'domain:verify'), true);
  assert.equal(can('VIEWER', 'domain:read'), true);
});

test('custom domain API happy path exposes one-time challenge and role-scoped reconciliation requests over Nest HTTP', async () => {
  // Given
  const runtime = await bootParityApi();
  const passwordHash = hashPassword('domain-test-password');
  const organization = runtime.repository.store.createOrganization({ name: 'HTTP Domain', slug: 'http-domain' });
  const project = runtime.repository.store.createProject({ organizationId: organization.id, name: 'Site', slug: 'site' });
  const service = runtime.repository.store.createService({ projectId: project.id, name: 'Web', slug: 'web', type: 'web' });
  const owner = runtime.repository.store.createUser({ name: 'Owner', email: 'owner-domain@example.test', passwordHash, role: 'USER', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER', emailVerifiedAt: new Date().toISOString() });
  const maintainer = runtime.repository.store.createUser({ name: 'Maintainer', email: 'maintainer-domain@example.test', passwordHash, role: 'USER', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER', emailVerifiedAt: new Date().toISOString() });
  runtime.repository.store.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });
  runtime.repository.store.addMember({ organizationId: organization.id, userId: maintainer.id, role: 'MAINTAINER' });
  const login = async (email) => (await fetch(`${runtime.baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'domain-test-password' }) })).json();

  try {
    // When
    const ownerSession = await login(owner.email);
    const maintainerSession = await login(maintainer.email);
    const maintainerClient = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: maintainerSession.token });
    const createdResponse = await fetch(`${runtime.baseUrl}/projects/${project.id}/domains`, { method: 'POST', headers: { authorization: `Bearer ${ownerSession.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: service.id, hostname: 'HTTP.Example.' }) });
    const created = await createdResponse.json();
    const status = await maintainerClient.getDomain(created.domain.id);
    const listed = await maintainerClient.listDomains(project.id);
    const verifyResponse = await fetch(`${runtime.baseUrl}/domains/${created.domain.id}/verify`, { method: 'POST', headers: { authorization: `Bearer ${maintainerSession.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) });
    const deniedRotate = await fetch(`${runtime.baseUrl}/domains/${created.domain.id}/rotate`, { method: 'POST', headers: { authorization: `Bearer ${maintainerSession.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, confirmed: true }) });

    // Then
    assert.equal(createdResponse.status, 201);
    assert.match(created.challengeToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(status.hostname, 'http.example');
    assert.equal(listed.domains.length, 1);
    assert.equal('challengeToken' in status, false);
    assert.equal('verificationTokenHash' in status, false);
    assert.equal(verifyResponse.status, 202);
    assert.equal(deniedRotate.status, 403);
  } finally {
    await runtime.app.close();
  }
});

test('custom domain API adversarial matrix rejects malformed duplicate and stale HTTP mutations without side effects', async () => {
  // Given
  const runtime = await bootParityApi();
  const passwordHash = hashPassword('domain-adversarial-password');
  const organization = runtime.repository.store.createOrganization({ name: 'HTTP Adversarial', slug: 'http-adversarial' });
  const project = runtime.repository.store.createProject({ organizationId: organization.id, name: 'Site', slug: 'site' });
  const service = runtime.repository.store.createService({ projectId: project.id, name: 'Web', slug: 'web', type: 'web' });
  const owner = runtime.repository.store.createUser({ name: 'Owner', email: 'owner-adversarial@example.test', passwordHash, role: 'USER', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER', emailVerifiedAt: new Date().toISOString() });
  runtime.repository.store.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });

  try {
    const session = await (await fetch(`${runtime.baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: 'domain-adversarial-password' }) })).json();
    const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };

    // When
    const malformed = await fetch(`${runtime.baseUrl}/projects/${project.id}/domains`, { method: 'POST', headers, body: JSON.stringify({ serviceId: service.id, hostname: '*.example.test' }) });
    const first = await (await fetch(`${runtime.baseUrl}/projects/${project.id}/domains`, { method: 'POST', headers, body: JSON.stringify({ serviceId: service.id, hostname: 'unique-http.example' }) })).json();
    const duplicate = await fetch(`${runtime.baseUrl}/projects/${project.id}/domains`, { method: 'POST', headers, body: JSON.stringify({ serviceId: service.id, hostname: 'UNIQUE-HTTP.EXAMPLE.' }) });
    const stale = await fetch(`${runtime.baseUrl}/domains/${first.domain.id}/rotate`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: 2, confirmed: true }) });
    const listed = await (await fetch(`${runtime.baseUrl}/projects/${project.id}/domains`, { headers })).json();

    // Then
    assert.equal(malformed.status, 400);
    assert.equal(duplicate.status, 409);
    assert.equal(stale.status, 409);
    assert.equal(listed.domains.length, 1);
    assert.equal(listed.domains[0].verificationVersion, 1);
    assert.equal(JSON.stringify(listed).includes(first.challengeToken), false);
  } finally {
    await runtime.app.close();
  }
});

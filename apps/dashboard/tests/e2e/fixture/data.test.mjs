import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import typescript from 'typescript';
import { apiOperations } from '../../../../../packages/schemas/src/api-contract.ts';
import {
  DEFAULT_PUBLIC_SITE_SCENARIO,
  FIXTURE_IDS,
  PUBLIC_SITE_SCENARIOS,
  TOKENS,
  isPublicSiteScenario,
  resetOrganizationFixture,
  resetProjectSettingsFixture,
  resetCustomDomainFixture,
  responseFor,
} from './data.mjs';
import { createFixtureState } from './state.mjs';

const request = (method, pathname, token = TOKENS.user, options = {}) => responseFor({
  token,
  method,
  pathname,
  searchParams: new URLSearchParams(),
  ...options,
});

async function parseFixtureHistory(value) {
  const directory = await mkdtemp(join(tmpdir(), 'task38-history-parser-'));
  try {
    const source = await readFile(new URL('../../../components/project-hub/deployment-history-model.ts', import.meta.url), 'utf8');
    const output = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 } }).outputText;
    const modulePath = join(directory, 'deployment-history-model.mjs');
    await writeFile(modulePath, output);
    const parser = await import(pathToFileURL(modulePath).href);
    return parser.deploymentHistoryPage(value);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('Given OWNER and ADMIN fixture sessions, when a member role is changed, then the changed membership is returned by the next list read', () => {
  resetOrganizationFixture();
  for (const [token, currentRole, nextRole] of [
    [TOKENS.roleOwner, 'OWNER', 'ADMIN'],
    [TOKENS.roleAdmin, 'ADMIN', 'MAINTAINER'],
  ]) {
    apiOperations['auth-me'].response.parse(request('GET', '/auth/me', token).body);
    const initial = request('GET', '/organizations/org_fixture_001/members', token);
    assert.equal(initial.status, 200);
    apiOperations['organizations-members'].response.parse(initial.body);
    assert.equal(initial.body.members.find((member) => member.id === 'mem_fixture_actor')?.role, currentRole);
    const target = initial.body.members.find((member) => member.id === 'mem_fixture_target');
    const changed = request('PATCH', '/organizations/org_fixture_001/members/mem_fixture_target', token, { body: { role: nextRole, expectedVersion: target.version } });
    assert.equal(changed.status, 200);
    apiOperations['organizations-members-patch'].response.parse(changed.body);
    assert.equal(changed.body.membership.role, nextRole);
    assert.equal(request('GET', '/organizations/org_fixture_001/members', token).body.members.find((member) => member.id === 'mem_fixture_target')?.role, nextRole);
  }
});

test('Given lower organization roles, when each directly changes a member role, then 403 leaves the target membership unchanged', () => {
  resetOrganizationFixture();
  for (const token of [TOKENS.roleMaintainer, TOKENS.roleDeveloper, TOKENS.roleDbAdmin, TOKENS.roleViewer]) {
    const before = request('GET', '/organizations/org_fixture_001/members', token);
    assert.equal(before.status, 200);
    apiOperations['organizations-members'].response.parse(before.body);
    assert.deepEqual(request('GET', '/organizations/org_fixture_001/invites', token), { status: 200, body: { invites: [] } });
    const target = before.body.members.find((member) => member.id === 'mem_fixture_target');
    const denied = request('PATCH', '/organizations/org_fixture_001/members/mem_fixture_target', token, { body: { role: 'DEVELOPER', expectedVersion: target.version } });
    const after = request('GET', '/organizations/org_fixture_001/members', token);
    assert.deepEqual(denied, { status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(after.body.members.find((member) => member.id === 'mem_fixture_target'), target);
  }
});

test('Given anonymous and pending sessions, when organization creation is requested, then neither response contains a created organization', () => {
  const anonymous = request('POST', '/organizations', '');
  const pending = request('POST', '/organizations', TOKENS.rolePending, { body: { name: 'Pending org', slug: 'pending-org' } });
  assert.equal(anonymous.status, 401);
  assert.equal(pending.status, 401);
  assert.equal('organization' in anonymous.body, false);
  assert.equal('organization' in pending.body, false);
});

test('Given a platform ADMIN without an organization membership, when a tenant is created, then only the new tenant grants OWNER', () => {
  const identity = request('GET', '/auth/me', TOKENS.roleGlobalAdmin);
  const created = request('POST', '/organizations', TOKENS.roleGlobalAdmin, { body: { name: 'Global admin tenant', slug: 'global-admin-tenant' } });
  const foreignMutation = request('PATCH', '/organizations/org_fixture_001/members/mem_fixture_target', TOKENS.roleGlobalAdmin, { body: { role: 'ADMIN', expectedVersion: 1 } });
  assert.equal(identity.body.user.role, 'ADMIN');
  apiOperations['auth-me'].response.parse(identity.body);
  assert.deepEqual(identity.body.memberships, []);
  assert.equal(created.status, 201);
  apiOperations['organizations-post'].response.parse(created.body);
  assert.equal(created.body.membership.role, 'OWNER');
  assert.equal(created.body.membership.userId, identity.body.user.id);
  assert.deepEqual(foreignMutation, { status: 403, body: { error: 'forbidden' } });
});

test('Given the populated fixture, when GitHub workflow data loads, then installation, repository, project, service, and branch IDs align', () => {
  const integrations = request('GET', '/integrations/github');
  const installations = request('GET', '/github/installations');
  const repositories = request('GET', '/github/installations/9001/repositories');
  const projects = request('GET', '/projects');
  const services = request('GET', '/projects/prj_fixture_001/services');

  assert.equal(integrations.status, 200);
  apiOperations['github-integrations-list'].response.parse(integrations.body);
  assert.deepEqual(integrations.body.integrations.map(({ id, organizationId, accountLogin, installationId, status }) => ({ id, organizationId, accountLogin, installationId, status })), [{
    id: 'ghi_fixture', organizationId: 'org_fixture_001', accountLogin: 'raibit-fixture', installationId: '9001', status: 'ACTIVE',
  }]);
  apiOperations['github-installations'].response.parse(installations.body);
  assert.deepEqual(installations.body.installations, [{
    id: '9001', installationId: '9001', integrationId: 'ghi_fixture', accountLogin: 'raibit-fixture', repositoryCount: 125,
  }]);
  apiOperations['github-repositories'].response.parse(repositories.body);
  assert.equal(repositories.body.repositories.length, 50);
  assert.equal(repositories.body.nextCursor, 'fixture-catalog-page-2');
  assert.deepEqual(repositories.body.repositories[0], {
    id: 'repo_fixture', githubRepoId: 'repo_fixture', fullName: 'raibit/fixture-app', name: 'fixture-app',
    owner: 'raibit', normalizedIdentity: 'raibit/fixture-app', defaultBranch: 'main', private: false, accessState: 'ACCESSIBLE', generation: 12, installationId: '9001',
  });
  assert.equal(projects.body.projects[0].id, 'prj_fixture_001');
  assert.deepEqual(services.body.services.map(({ id, projectId, branch }) => ({ id, projectId, branch })), [{
    id: 'svc_fixture_web', projectId: 'prj_fixture_001', branch: 'main',
  }, {
    id: 'svc_fixture_worker', projectId: 'prj_fixture_001', branch: 'main',
  }]);
});

test('Given the populated fixture, when GitHub happy-path endpoints are called, then deterministic responses identify the seeded records', () => {
  assert.deepEqual(request('GET', '/github/install'), {
    status: 200,
    body: { installUrl: 'https://github.com/apps/raibit-fixture/installations/new?state=public-fixture-state' },
  });
  assert.deepEqual(request('POST', '/github/repositories/import'), {
    status: 201,
    body: { projectId: 'prj_fixture_001', serviceId: 'svc_fixture_web', integrationId: 'ghi_fixture', repositoryId: 'repo_fixture' },
  });
  assert.deepEqual(request('POST', '/projects/prj_fixture_001/services/svc_fixture_web/github'), {
    status: 200,
    body: { projectId: 'prj_fixture_001', serviceId: 'svc_fixture_web', integrationId: 'ghi_fixture', repositoryId: 'repo_fixture', branch: 'main' },
  });
  assert.deepEqual(request('POST', '/github/repositories/raibit%2Ffixture-app/sync'), {
    status: 200,
    body: { installationId: '9001', repositoryId: 'repo_fixture', fullName: 'raibit/fixture-app', defaultBranch: 'main', synced: true },
  });
});

test('Given deployed service settings, when preview, conditional save, and replacement are requested, then the fixture keeps the prior service and deployment data immutable', () => {
  const settingsPath = '/services/svc_fixture_web/settings';
  const expectedUpdatedAt = '2026-08-31T03:00:00.000Z';
  const changes = { dockerfilePath: 'docker/Dockerfile' };
  const loaded = request('GET', settingsPath);
  const preview = request('POST', `${settingsPath}/preview`, TOKENS.user, { body: { expectedUpdatedAt, changes } });
  const saved = request('PATCH', settingsPath, TOKENS.user, { body: { expectedUpdatedAt, changes } });
  const replacement = request('POST', '/services/svc_fixture_web/replacements', TOKENS.user, {
    body: { expectedUpdatedAt, confirmed: true, name: 'web-v2', source: { sourceType: 'github', repoUrl: 'https://github.com/raibit/fixture-app' } },
  });

  assert.equal(loaded.status, 200);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.diff, [{ field: 'dockerfilePath', before: 'Dockerfile', after: 'docker/Dockerfile' }]);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.dockerfilePath, 'docker/Dockerfile');
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.impact, 'old_service_preserved');
  assert.equal(replacement.body.oldServiceId, 'svc_fixture_web');
  assert.equal(request('GET', settingsPath).body.settings.dockerfilePath, 'Dockerfile');
});

test('Given non-populated sessions, when GitHub data loads, then empty and authorization behavior stay deterministic', () => {
  assert.deepEqual(request('GET', '/github/installations', TOKENS.empty), { status: 200, body: { installations: [] } });
  assert.deepEqual(request('GET', '/github/installations', TOKENS.expired), { status: 401, body: { error: 'session_expired' } });
  const repositories = request('GET', '/github/installations/9001/repositories', TOKENS.partial);
  assert.equal(repositories.status, 200);
  apiOperations['github-repositories'].response.parse(repositories.body);
  assert.equal(repositories.body.repositories.length, 50);
  assert.equal(repositories.body.nextCursor, 'fixture-catalog-page-2');
  assert.deepEqual(repositories.body.repositories[0], {
    id: 'repo_fixture', githubRepoId: 'repo_fixture', fullName: 'raibit/fixture-app', name: 'fixture-app',
    owner: 'raibit', normalizedIdentity: 'raibit/fixture-app', defaultBranch: 'main', private: false, accessState: 'ACCESSIBLE', generation: 12, installationId: '9001',
  });
});

test('Given project settings, when a conditional update or deletion request is made, then immutable fields remain server-owned and role-gated', () => {
  const path = '/projects/prj_fixture_001/settings';
  const deletionPath = `${path}/deletion`;
  resetProjectSettingsFixture();

  const initial = request('GET', path);
  const updated = request('PATCH', path, TOKENS.user, { body: { expectedUpdatedAt: initial.body.snapshot.updatedAt, name: '변경된 운영 프로젝트' } });
  const stale = request('PATCH', path, TOKENS.user, { body: { expectedUpdatedAt: initial.body.snapshot.updatedAt, description: '오래된 설명' } });
  const forged = request('PATCH', path, TOKENS.user, { body: { expectedUpdatedAt: updated.body.snapshot.updatedAt, slug: 'forged', name: '변경된 운영 프로젝트' } });
  const deniedDeletion = request('POST', deletionPath, TOKENS.user, { body: { confirmed: true } });
  const scheduled = request('POST', deletionPath, TOKENS.admin, { body: { confirmed: true } });
  const repeated = request('POST', deletionPath, TOKENS.admin, { body: { confirmed: true } });

  assert.equal(initial.body.project.slug, 'deterministic-app');
  assert.equal(updated.status, 200);
  assert.equal(updated.body.project.name, '변경된 운영 프로젝트');
  assert.equal(updated.body.project.slug, 'deterministic-app');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'STALE_PROJECT');
  assert.equal(forged.status, 400);
  assert.equal(deniedDeletion.status, 403);
  assert.deepEqual(scheduled.body, repeated.body);
  assert.equal(scheduled.status, 202);
  assert.equal(scheduled.body.scheduled, true);
  resetProjectSettingsFixture();
});

test('Given custom domains, when a domain is added, verified, rotated, or deleted, then only create and rotate expose one-time tokens and reconciliation remains asynchronous', () => {
  const listPath = '/projects/prj_fixture_001/domains';
  resetCustomDomainFixture();

  const listed = request('GET', listPath);
  const created = request('POST', listPath, TOKENS.admin, { body: { serviceId: 'svc_fixture_web', hostname: 'docs.fixture.example' } });
  const createdId = created.body.domain.id;
  const listedAfterCreate = request('GET', listPath);
  const verified = request('POST', `/domains/${createdId}/verify`, TOKENS.user, { body: { expectedVersion: created.body.domain.verificationVersion } });
  const rotated = request('POST', `/domains/${createdId}/rotate`, TOKENS.admin, { body: { expectedVersion: verified.body.verificationVersion, confirmed: true } });
  const deleted = request('DELETE', `/domains/${createdId}`, TOKENS.admin, { body: { expectedVersion: rotated.body.domain.verificationVersion } });
  const deniedCreate = request('POST', listPath, TOKENS.user, { body: { serviceId: 'svc_fixture_web', hostname: 'denied.fixture.example' } });

  assert.equal(listed.status, 200);
  assert.equal(listed.body.domains[0].status, 'READY');
  assert.equal(created.status, 201);
  assert.match(created.body.challengeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal('challengeToken' in listedAfterCreate.body.domains.at(-1), false);
  assert.equal(verified.status, 202);
  assert.equal(verified.body.status, 'ROUTING');
  assert.equal('challengeToken' in verified.body, false);
  assert.equal(rotated.status, 202);
  assert.match(rotated.body.challengeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.body.challengeToken, created.body.challengeToken);
  assert.equal(deleted.status, 202);
  assert.equal(deleted.body.status, 'DELETING');
  assert.equal(deleted.body.cleanupBarrier.complete, false);
  assert.equal(deniedCreate.status, 403);
  resetCustomDomainFixture();
});

test('Given a ready backup, when a restore is accepted, then fixture readback preserves the operation, target resource, and requested name', async () => {
  const fixture = await import('./data.mjs');
  assert.equal(typeof fixture.resetResourceRecoveryFixture, 'function');
  assert.equal(typeof fixture.resourceRecoveryFixtureSnapshot, 'function');
  fixture.resetResourceRecoveryFixture();

  const restored = request('POST', '/backups/bak_fixture_ready/restores', TOKENS.admin, {
    body: { formatVersion: 1, requestIdempotencyKey: 'restore-readback', name: 'task49-restored' },
  });

  assert.equal(restored.status, 202);
  assert.deepEqual(fixture.resourceRecoveryFixtureSnapshot(), [{
    id: 'rst_fixture_requested',
    targetResourceId: 'res_fixture_restored',
    requestedName: 'task49-restored',
    status: 'QUEUED',
  }]);
});

test('Given the fixture-only public state switch, when each allowlisted scenario loads, then public payloads are deterministic and reset-safe', () => {
  assert.equal(DEFAULT_PUBLIC_SITE_SCENARIO, 'populated');
  assert.deepEqual(PUBLIC_SITE_SCENARIOS, ['populated', 'empty', 'partial', 'long']);
  for (const scenario of PUBLIC_SITE_SCENARIOS) assert.equal(isPublicSiteScenario(scenario), true);
  assert.equal(isPublicSiteScenario('production'), false);

  const populated = request('GET', '/public/sites', '', { publicSiteScenario: 'populated' });
  const empty = request('GET', '/public/sites', '', { publicSiteScenario: 'empty' });
  const partial = request('GET', '/public/sites', '', { publicSiteScenario: 'partial' });
  const long = request('GET', '/public/sites', '', { publicSiteScenario: 'long' });

  assert.equal(populated.status, 200);
  assert.deepEqual(populated.body.sites.map((site) => site.id), ['prj_fixture_001', 'prj_public_docs']);
  assert.deepEqual(empty, { status: 200, body: { sites: [], limit: null } });
  assert.deepEqual(partial, { status: 503, body: { error: 'fixture_public_sites_unavailable' } });
  assert.equal(long.status, 200);
  assert.match(long.body.sites[0].name, /배포 로그가 길어져도/);
  assert.equal(request('GET', '/public/sites', '', { publicSiteScenario: 'not-allowlisted' }).status, 400);
});

test('Given a fixture-only state holder, when a public scenario is selected and reset, then only allowlisted state reaches the public response boundary', () => {
  const state = createFixtureState();
  assert.deepEqual(state.snapshot(), { publicSiteScenario: 'populated' });
  assert.equal(state.selectPublicSiteScenario('production'), null);
  assert.deepEqual(state.selectPublicSiteScenario('long'), { publicSiteScenario: 'long' });
  assert.match(request('GET', '/public/sites', '', state.snapshot()).body.sites[0].name, /배포 로그가 길어져도/);
  assert.deepEqual(state.reset(), { publicSiteScenario: 'populated' });
});

test('Given deployment detail and history fixtures, when overview, logs, events, recovery, and parser boundaries run, then typed rows and operation contracts stay exact', async () => {
  const readyPath = `/deployments/${FIXTURE_IDS.readyDeployment}`;
  const cancellablePaths = [
    `/deployments/${FIXTURE_IDS.queuedDeployment}`,
    `/deployments/${FIXTURE_IDS.buildingDeployment}`,
    `/deployments/${FIXTURE_IDS.imageReadyDeployment}`,
  ];

  assert.deepEqual(request('GET', readyPath).body, {
    id: FIXTURE_IDS.readyDeployment, projectId: FIXTURE_IDS.project, serviceId: 'svc_fixture_web', deploymentType: 'production', status: 'READY',
    imageUrl: 'registry.fixture.invalid/raibit/web:fixed', imageDigest: 'sha256:fixture0001', commitSha: '0123456789abcdef0123456789abcdef01234567', createdAt: '2026-08-31T03:00:00.000Z',
    service: { id: 'svc_fixture_web', name: 'web', slug: 'web' }, environment: 'production', trigger: 'push', updatedAt: '2026-08-31T03:00:00.000Z',
    source: { commitSha: '0123456789abcdef0123456789abcdef01234567', imageDigest: 'sha256:fixture0001', snapshotVersion: 3 },
    lineage: { sourceDeploymentId: null, retryOfDeploymentId: null, rollbackOfDeploymentId: null, previousDeploymentId: FIXTURE_IDS.failedDeployment, previewLineageId: null, previewGeneration: null },
    operation: { requestedByUserId: 'usr_fixture_user', requestIdempotencyKey: `fixture-${FIXTURE_IDS.readyDeployment}` },
    health: { rolloutStatus: 'ready', publicHealthStatus: 'healthy', healthCheckedAt: '2026-08-31T03:00:00.000Z', healthFailureCode: null, observedGeneration: 3 },
    recovery: { retryable: false, reason: '서버 상태가 이 복구 요청을 허용하지 않습니다.' }, permissions: { execute: false }, eligibleAction: null,
  });
  const history = request('GET', `/projects/${FIXTURE_IDS.project}/deployments/history`, TOKENS.admin, { searchParams: new URLSearchParams('serviceId=svc_fixture_web&status=FAILED') });
  const parsedHistory = await parseFixtureHistory(history.body);
  assert.equal(history.status, 200);
  assert.equal(parsedHistory.deployments.length, 1);
  assert.equal(parsedHistory.deployments[0].projectId, FIXTURE_IDS.project);
  assert.equal(parsedHistory.deployments[0].eligibleAction?.type, 'retry');
  assert.equal(request('GET', `${readyPath}/logs`).body.logs[0].line, '이미지 준비가 완료되었습니다.');
  assert.equal(request('GET', `${readyPath}/events`).body.events[0].id, 'evt_fixture_ready');
  assert.deepEqual(request('POST', `${readyPath}/rollback`, TOKENS.user, { body: { confirmed: true } }), {
    status: 202, body: {
      operationId: 'op_fixture_rollback', status: 'QUEUED', streamHref: `${readyPath}/stream`, rollbackOfDeploymentId: FIXTURE_IDS.readyDeployment, workflowJob: {},
      deployment: { id: 'dep_fixture_rollback_successor', serviceId: 'svc_fixture_web', deploymentType: 'production', status: 'QUEUED', imageUrl: 'registry.fixture.invalid/raibit/web:fixed', imageDigest: 'sha256:fixture0001', commitSha: '0123456789abcdef0123456789abcdef01234567', createdAt: '2026-08-31T03:00:00.000Z' },
      previousDeployment: { id: FIXTURE_IDS.readyDeployment, serviceId: 'svc_fixture_web', deploymentType: 'production', status: 'READY', imageUrl: 'registry.fixture.invalid/raibit/web:fixed', imageDigest: 'sha256:fixture0001', commitSha: '0123456789abcdef0123456789abcdef01234567', createdAt: '2026-08-31T03:00:00.000Z' },
    },
  });
  assert.deepEqual(request('POST', `${readyPath}/rollback`), { status: 400, body: { error: 'fixture_confirmation_required' } });
  assert.deepEqual(request('POST', `${readyPath}/cancel`), { status: 409, body: { error: 'fixture_cancel_not_allowed' } });
  for (const path of cancellablePaths) {
    const cancelled = request('POST', `${path}/cancel`);
    const detail = request('GET', path).body;
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, {
      operationId: 'op_fixture_cancel', status: 'CANCELLED', streamHref: `${path}/stream`,
      deployment: { id: detail.id, serviceId: detail.serviceId, deploymentType: detail.deploymentType, status: 'CANCELLED', imageUrl: detail.imageUrl, imageDigest: detail.imageDigest, commitSha: detail.commitSha, createdAt: detail.createdAt },
    });
  }

  const partialLogs = request('GET', `${readyPath}/logs`, TOKENS.partial);
  assert.deepEqual(partialLogs, { status: 503, body: { error: 'fixture_operation_data_unavailable' } });
  assert.doesNotMatch(JSON.stringify(partialLogs), /secret|password|token/i);
});

test('Given long and hostile operational records, when fixture responses are requested, then the literal test data stays bounded to fixture paths and resource console data is complete', () => {
  const hostilePath = `/deployments/${encodeURIComponent(FIXTURE_IDS.hostileDeployment)}`;
  const longLogs = request('GET', `/deployments/${FIXTURE_IDS.readyDeployment}/logs`, TOKENS.long);
  const hostileDeployment = request('GET', hostilePath);
  const resourceBase = `/resources/${FIXTURE_IDS.resource}/console`;

  assert.equal(longLogs.status, 200);
  assert.match(longLogs.body.logs[0].line, /^build-output-x{768}$/);
  assert.equal(hostileDeployment.body.id, FIXTURE_IDS.hostileDeployment);
  assert.match(hostileDeployment.body.id, /<img/);
  assert.equal(request('GET', `${resourceBase}/schema`).body.schema.engine, 'postgresql');
  assert.equal(request('GET', `${resourceBase}/tables`).body.tables[1].name, 'events_<img src=x onerror=fixture-hostile-table>');
  assert.deepEqual(request('POST', `${resourceBase}/browse`).body.rows, [{ id: 'row_fixture_001', status: 'READY' }]);
  assert.deepEqual(request('POST', `${resourceBase}/command`), { status: 400, body: { error: 'fixture_confirmation_required' } });
  assert.deepEqual(request('POST', `${resourceBase}/command`, TOKENS.user, { body: { confirmed: 'true' } }), {
    status: 202, body: { operation: 'provider_command_requested', resourceId: FIXTURE_IDS.resource },
  });
  assert.deepEqual(request('GET', `${resourceBase}/schema`, TOKENS.partial), { status: 503, body: { error: 'fixture_resource_data_unavailable' } });
});

test('Given admin state sessions, when admin loaders request snapshot and usage data, then empty, partial, and long states preserve admin authorization', () => {
  const emptySnapshot = request('GET', '/snapshot', TOKENS.adminEmpty);
  const partialSnapshot = request('GET', '/snapshot', TOKENS.adminPartial);
  const partialUsage = request('GET', '/usage/me', TOKENS.adminPartial);
  const longSnapshot = request('GET', '/snapshot', TOKENS.adminLong);

  assert.deepEqual(emptySnapshot, { status: 200, body: { users: [], quotas: [], auditLogs: [] } });
  assert.equal(partialSnapshot.status, 200);
  assert.equal(partialSnapshot.body.users[0].role, 'USER');
  assert.deepEqual(partialUsage, { status: 500, body: { error: 'fixture_internal_secret_must_not_escape' } });
  assert.equal(longSnapshot.status, 200);
  assert.match(longSnapshot.body.users[0].name, /배포 로그가 길어져도/);
  assert.equal(longSnapshot.body.users[0].role, 'USER');
});

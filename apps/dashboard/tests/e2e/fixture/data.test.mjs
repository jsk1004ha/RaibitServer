import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PUBLIC_SITE_SCENARIO,
  FIXTURE_IDS,
  PUBLIC_SITE_SCENARIOS,
  TOKENS,
  isPublicSiteScenario,
  resetProjectSettingsFixture,
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

test('Given the populated fixture, when GitHub workflow data loads, then installation, repository, project, service, and branch IDs align', () => {
  const integrations = request('GET', '/integrations/github');
  const installations = request('GET', '/github/installations');
  const repositories = request('GET', '/github/installations/9001/repositories');
  const projects = request('GET', '/projects');
  const services = request('GET', '/projects/prj_fixture_001/services');

  assert.equal(integrations.status, 200);
  assert.deepEqual(integrations.body.integrations, [{
    id: 'ghi_fixture', provider: 'github', status: 'connected', login: 'raibit-fixture',
  }]);
  assert.deepEqual(installations.body.installations, [{
    id: '9001', installationId: '9001', integrationId: 'ghi_fixture', accountLogin: 'raibit-fixture', repositoryCount: 1,
  }]);
  assert.deepEqual(repositories.body.repositories, [{
    id: 'repo_fixture', githubRepoId: 'repo_fixture', fullName: 'raibit/fixture-app', name: 'fixture-app',
    defaultBranch: 'main', private: false, installationId: '9001',
  }]);
  assert.equal(projects.body.projects[0].id, 'prj_fixture_001');
  assert.deepEqual(services.body.services.map(({ id, projectId, branch }) => ({ id, projectId, branch })), [{
    id: 'svc_fixture_web', projectId: 'prj_fixture_001', branch: 'main',
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
  assert.deepEqual(request('GET', '/github/installations/9001/repositories', TOKENS.partial), {
    status: 200,
    body: { repositories: [{
      id: 'repo_fixture', githubRepoId: 'repo_fixture', fullName: 'raibit/fixture-app', name: 'fixture-app',
      defaultBranch: 'main', private: false, installationId: '9001',
    }] },
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

test('Given deployment detail fixtures, when overview, logs, events, rollback, and cancel endpoints run, then status gating and sanitized partial failures stay exact', () => {
  const readyPath = `/deployments/${FIXTURE_IDS.readyDeployment}`;
  const cancellablePaths = [
    `/deployments/${FIXTURE_IDS.queuedDeployment}`,
    `/deployments/${FIXTURE_IDS.buildingDeployment}`,
    `/deployments/${FIXTURE_IDS.imageReadyDeployment}`,
  ];

  assert.deepEqual(request('GET', readyPath).body, {
    id: FIXTURE_IDS.readyDeployment, serviceId: 'svc_fixture_web', deploymentType: 'production', status: 'READY',
    imageUrl: 'registry.fixture.invalid/raibit/web:fixed', imageDigest: 'sha256:fixture0001', commitSha: '0123456789abcdef0123456789abcdef01234567', createdAt: '2026-08-31T03:00:00.000Z',
  });
  assert.equal(request('GET', `${readyPath}/logs`).body.logs[0].line, '이미지 준비가 완료되었습니다.');
  assert.equal(request('GET', `${readyPath}/events`).body.events[0].id, 'evt_fixture_ready');
  assert.deepEqual(request('POST', `${readyPath}/rollback`, TOKENS.user, { body: { confirmed: 'true' } }), {
    status: 202, body: { operation: 'rollback_requested', deploymentId: FIXTURE_IDS.readyDeployment, status: 'QUEUED' },
  });
  assert.deepEqual(request('POST', `${readyPath}/rollback`), { status: 400, body: { error: 'fixture_confirmation_required' } });
  assert.deepEqual(request('POST', `${readyPath}/cancel`), { status: 409, body: { error: 'fixture_cancel_not_allowed' } });
  for (const path of cancellablePaths) {
    const cancelled = request('POST', `${path}/cancel`);
    assert.equal(cancelled.status, 202);
    assert.deepEqual(cancelled.body, {
      operation: 'cancel_requested', deploymentId: decodeURIComponent(path.slice('/deployments/'.length)), status: 'CANCEL_REQUESTED',
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

export const FIXED_TIME = '2026-08-31T03:00:00.000Z';
export const SESSION_COOKIE = 'raibitserver_session';
export const PUBLIC_SITE_SCENARIOS = Object.freeze(['populated', 'empty', 'partial', 'long']);
export const DEFAULT_PUBLIC_SITE_SCENARIO = 'populated';

export function isPublicSiteScenario(value) {
  return typeof value === 'string' && PUBLIC_SITE_SCENARIOS.includes(value);
}

const longKoreanText = '배포 로그가 길어져도 레이아웃과 오류 경계가 안정적으로 유지되어야 합니다. '.repeat(18).trim();
const longUnbrokenLog = `build-output-${'x'.repeat(768)}`;
const hostileLogLine = '<img src=x onerror="fixture-hostile-log">';
const project = {
  id: 'prj_fixture_001', organizationId: 'org_fixture_001', organizationSlug: 'raibit',
  name: '결정적 운영 프로젝트', slug: 'deterministic-app', status: 'active', serviceCount: 1, resourceCount: 1,
};
const service = {
  id: 'svc_fixture_web', projectId: project.id, name: 'web', slug: 'web', type: 'web', status: 'running',
  sourceType: 'github', repoUrl: 'https://github.com/raibit/fixture-app', branch: 'main', dockerfilePath: 'Dockerfile', port: 3000,
};
const githubIntegration = { id: 'ghi_fixture', provider: 'github', status: 'connected', login: 'raibit-fixture' };
const githubInstallation = {
  id: '9001', installationId: '9001', integrationId: githubIntegration.id, accountLogin: 'raibit-fixture', repositoryCount: 1,
};
const githubRepository = {
  id: 'repo_fixture', githubRepoId: 'repo_fixture', fullName: 'raibit/fixture-app', name: 'fixture-app',
  defaultBranch: service.branch, private: false, installationId: githubInstallation.installationId,
};
const deployment = {
  id: 'dep_fixture_ready', serviceId: service.id, deploymentType: 'production', status: 'READY',
  imageUrl: 'registry.fixture.invalid/raibit/web:fixed', imageDigest: 'sha256:fixture0001', commitSha: '0123456789abcdef0123456789abcdef01234567', createdAt: FIXED_TIME,
};
const buildingDeployment = {
  ...deployment, id: 'dep_fixture_building', status: 'BUILDING', imageDigest: 'sha256:fixture-building', createdAt: '2026-08-31T02:58:00.000Z',
};
const queuedDeployment = {
  ...deployment, id: 'dep_fixture_queued', status: 'QUEUED', imageDigest: 'sha256:fixture-queued', createdAt: '2026-08-31T02:59:00.000Z',
};
const imageReadyDeployment = {
  ...deployment, id: 'dep_fixture_image_ready', status: 'IMAGE_READY', imageDigest: 'sha256:fixture-image-ready', createdAt: '2026-08-31T02:58:30.000Z',
};
const failedDeployment = {
  ...deployment, id: 'dep_fixture_failed', status: 'FAILED', errorCode: 'build_failed', errorMessage: '빌드 워커의 결과를 다시 확인하세요.', createdAt: '2026-08-31T02:57:00.000Z',
};
const longDeployment = {
  ...deployment, id: `dep_fixture_${'x'.repeat(180)}`, imageDigest: `sha256:${'a'.repeat(96)}`, createdAt: '2026-08-31T02:56:00.000Z',
};
const hostileDeployment = {
  ...deployment, id: 'dep_fixture_<img src=x onerror=fixture-hostile-id>', imageUrl: 'registry.fixture.invalid/raibit/<svg/onload=fixture-hostile-image>', createdAt: '2026-08-31T02:55:00.000Z',
};
const deploymentFixtures = [
  { deployment, logs: [{ timestamp: FIXED_TIME, line: '이미지 준비가 완료되었습니다.' }], events: [{ id: 'evt_fixture_ready', createdAt: FIXED_TIME, type: 'ready', message: '운영 배포가 준비되었습니다.' }] },
  { deployment: queuedDeployment, logs: [{ timestamp: FIXED_TIME, line: '배포 대기열에 등록되었습니다.' }], events: [{ id: 'evt_fixture_queued', createdAt: FIXED_TIME, type: 'queued', message: '빌드 작업을 기다리고 있습니다.' }] },
  { deployment: buildingDeployment, logs: [{ timestamp: FIXED_TIME, line: '컨테이너 이미지를 빌드하고 있습니다.' }], events: [{ id: 'evt_fixture_building', createdAt: FIXED_TIME, type: 'build', message: '빌드 단계가 진행 중입니다.' }] },
  { deployment: imageReadyDeployment, logs: [{ timestamp: FIXED_TIME, line: '이미지가 준비되어 배포를 기다리고 있습니다.' }], events: [{ id: 'evt_fixture_image_ready', createdAt: FIXED_TIME, type: 'image_ready', message: '이미지 준비가 완료되었습니다.' }] },
  { deployment: failedDeployment, logs: [{ timestamp: FIXED_TIME, line: '안전하게 정리된 빌드 실패 상태입니다.' }], events: [{ id: 'evt_fixture_failed', createdAt: FIXED_TIME, type: 'failed', message: '빌드 결과를 확인해야 합니다.' }] },
  { deployment: longDeployment, logs: [{ timestamp: FIXED_TIME, line: longUnbrokenLog }, { timestamp: FIXED_TIME, line: longKoreanText }], events: [{ id: 'evt_fixture_long', createdAt: FIXED_TIME, type: 'notice', message: longKoreanText }] },
  { deployment: hostileDeployment, logs: [{ timestamp: FIXED_TIME, line: hostileLogLine }], events: [{ id: 'evt_fixture_hostile', createdAt: FIXED_TIME, type: 'notice', message: hostileLogLine }] },
];
const resource = {
  id: 'res_fixture_pg', projectId: project.id, name: 'primary-postgres', type: 'database', engine: 'postgresql', status: 'READY', provider: 'fixture', plan: 'shared-small', region: 'local',
};
const resourceConsole = {
  schema: { engine: 'postgresql', tables: 2, connectionInfo: { databaseUrl: 'postgresql://provider-managed@fixture.invalid/primary' } },
  tables: [{ name: 'deployments', type: 'table' }, { name: 'events_<img src=x onerror=fixture-hostile-table>', type: 'table' }],
  collections: [],
  keys: [{ name: 'deployments_pkey', type: 'primary' }],
  browse: { rows: [{ id: 'row_fixture_001', status: 'READY' }], connectionInfo: { databaseUrl: 'postgresql://provider-managed@fixture.invalid/primary' } },
};

export const FIXTURE_IDS = Object.freeze({
  project: project.id,
  service: service.id,
  resource: resource.id,
  readyDeployment: deployment.id,
  queuedDeployment: queuedDeployment.id,
  buildingDeployment: buildingDeployment.id,
  imageReadyDeployment: imageReadyDeployment.id,
  failedDeployment: failedDeployment.id,
  longDeployment: longDeployment.id,
  hostileDeployment: hostileDeployment.id,
});

const users = {
  user: { id: 'usr_fixture_user', email: 'user@fixture.test', name: 'Fixture User', role: 'USER', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' },
  admin: { id: 'usr_fixture_admin', email: 'admin@fixture.test', name: 'Fixture Admin', role: 'ADMIN', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER' },
};

export const TOKENS = {
  user: 'fixture-user-populated', admin: 'fixture-admin-populated', empty: 'fixture-user-empty',
  partial: 'fixture-user-partial', long: 'fixture-user-long', expired: 'fixture-expired',
  adminEmpty: 'fixture-admin-empty', adminPartial: 'fixture-admin-partial', adminLong: 'fixture-admin-long',
};

export const loginAccounts = new Map([
  ['user@fixture.test', { password: 'fixture-user-pass', token: TOKENS.user }],
  ['admin@fixture.test', { password: 'fixture-admin-pass', token: TOKENS.admin }],
  ['empty@fixture.test', { password: 'fixture-empty-pass', token: TOKENS.empty }],
  ['partial@fixture.test', { password: 'fixture-partial-pass', token: TOKENS.partial }],
  ['long@fixture.test', { password: 'fixture-long-pass', token: TOKENS.long }],
]);

export function responseFor({ token, method, pathname, searchParams, publicSiteScenario = DEFAULT_PUBLIC_SITE_SCENARIO, body = {} }) {
  if (pathname === '/health') return json(200, { status: 'ok', checkedAt: FIXED_TIME });
  if (pathname === '/public/sites') return publicSitesResponse(publicSiteScenario, searchParams);
  if (!token || token === TOKENS.expired) return json(401, { error: 'session_expired' });
  const state = [TOKENS.empty, TOKENS.adminEmpty].includes(token)
    ? 'empty'
    : [TOKENS.partial, TOKENS.adminPartial].includes(token)
      ? 'partial'
      : [TOKENS.long, TOKENS.adminLong].includes(token)
        ? 'long'
        : 'populated';
  const actor = [TOKENS.admin, TOKENS.adminEmpty, TOKENS.adminPartial, TOKENS.adminLong].includes(token) ? users.admin : users.user;
  if (state === 'partial' && pathname === '/usage/me') return json(500, { error: 'fixture_internal_secret_must_not_escape' });
  if (pathname === '/auth/me') return json(200, { user: actor, subject: { ...actor, organizationId: project.organizationId, organizationSlug: project.organizationSlug } });
  if (pathname === '/projects') return json(200, { projects: state === 'empty' ? [] : [{ ...project, name: state === 'long' ? longKoreanText : project.name }] });
  if (pathname === '/usage/me') return json(200, { usage: [{ metric: 'deployments', used: 1, limit: 10 }], quota: { maxProjects: 5 } });
  if (pathname === '/integrations/github') return json(200, { integrations: state === 'empty' ? [] : [githubIntegration] });
  if (pathname === '/github/install') return json(200, { installUrl: 'https://github.com/apps/raibit-fixture/installations/new?state=public-fixture-state' });
  if (pathname === '/github/installations') return json(200, { installations: state === 'empty' ? [] : [githubInstallation] });
  if (pathname === '/github/installations/9001/repositories') return json(200, { repositories: [githubRepository] });
  if (pathname === `/projects/${project.id}/services`) return json(200, { services: [service] });
  if (method === 'POST' && pathname === '/github/repositories/import') return json(201, {
    projectId: project.id, serviceId: service.id, integrationId: githubIntegration.id, repositoryId: githubRepository.id,
  });
  if (method === 'POST' && pathname === `/projects/${project.id}/services/${service.id}/github`) return json(200, {
    projectId: project.id, serviceId: service.id, integrationId: githubIntegration.id, repositoryId: githubRepository.id, branch: service.branch,
  });
  if (method === 'POST' && pathname === '/github/repositories/raibit%2Ffixture-app/sync') return json(200, {
    installationId: githubInstallation.installationId, repositoryId: githubRepository.id,
    fullName: githubRepository.fullName, defaultBranch: githubRepository.defaultBranch, synced: true,
  });
  if (pathname === `/projects/${project.id}/overview`) return json(200, { project, services: [service], deployments: [deployment], resources: [resource] });
  const deploymentFixture = deploymentFixtureForPath(pathname);
  if (deploymentFixture) return deploymentResponse({ body, deploymentFixture, method, pathname, state });
  if (pathname === `/resources/${resource.id}`) return json(200, resource);
  if (pathname.startsWith(`/resources/${resource.id}/console/`)) return resourceConsoleResponse({ body, method, pathname, state });
  if (pathname === `/services/${service.id}/logs`) return json(200, { logs: [{ timestamp: FIXED_TIME, line: longKoreanText }] });
  if (pathname === '/snapshot') {
    if (actor.role !== 'ADMIN') return json(403, { error: 'forbidden' });
    const snapshotUsers = state === 'empty'
      ? []
      : [
          { ...users.user, name: state === 'long' ? longKoreanText : users.user.name },
          users.admin,
          { id: 'usr_pending', email: 'pending@fixture.test', name: '승인 대기', role: 'USER', accountType: 'NON_CLUB', approvalStatus: 'PENDING', clubMemberClaim: true },
        ];
    return json(200, { users: snapshotUsers, quotas: [], auditLogs: [] });
  }
  if (method === 'POST') return json(200, { ok: true });
  return json(404, { error: 'fixture_route_not_found' });
}

function json(status, body) { return { status, body }; }

function publicSitesResponse(scenario, searchParams) {
  const limit = searchParams.get('limit');
  if (!isPublicSiteScenario(scenario)) return json(400, { error: 'invalid_fixture_public_site_scenario' });
  if (scenario === 'partial') return json(503, { error: 'fixture_public_sites_unavailable' });
  const populated = [
    { id: project.id, name: project.name, owner: 'RAIBIT', url: 'http://apps--raibit--deterministic-app.localhost' },
    { id: 'prj_public_docs', name: '라이빗 문서', owner: 'RAIBIT', url: 'https://docs.fixture.invalid' },
  ];
  const sites = scenario === 'empty'
    ? []
    : scenario === 'long'
      ? [{ ...populated[0], name: longKoreanText, owner: longKoreanText, url: 'https://long.fixture.invalid' }]
      : populated;
  return json(200, { sites, limit });
}

function deploymentFixtureForPath(pathname) {
  return deploymentFixtures.find((fixture) => {
    const base = `/deployments/${encodeURIComponent(fixture.deployment.id)}`;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

function deploymentResponse({ body, deploymentFixture, method, pathname, state }) {
  const base = `/deployments/${encodeURIComponent(deploymentFixture.deployment.id)}`;
  if (pathname === base && method === 'GET') return json(200, deploymentFixture.deployment);
  if (state === 'partial' && (pathname === `${base}/logs` || pathname === `${base}/events`)) return json(503, { error: 'fixture_operation_data_unavailable' });
  if (pathname === `${base}/logs` && method === 'GET') {
    const logs = state === 'empty' ? [] : state === 'long' ? [{ timestamp: FIXED_TIME, line: longUnbrokenLog }, { timestamp: FIXED_TIME, line: hostileLogLine }, { timestamp: FIXED_TIME, line: longKoreanText }] : deploymentFixture.logs;
    return json(200, { logs });
  }
  if (pathname === `${base}/events` && method === 'GET') return json(200, { events: state === 'empty' ? [] : deploymentFixture.events });
  if (pathname === `${base}/rollback` && method === 'POST') {
    if (body.confirmed !== 'true') return json(400, { error: 'fixture_confirmation_required' });
    return json(202, { operation: 'rollback_requested', deploymentId: deploymentFixture.deployment.id, status: 'QUEUED' });
  }
  if (pathname === `${base}/cancel` && method === 'POST') {
    const cancellable = new Set(['QUEUED', 'BUILDING', 'IMAGE_READY']);
    if (!cancellable.has(deploymentFixture.deployment.status)) return json(409, { error: 'fixture_cancel_not_allowed' });
    return json(202, { operation: 'cancel_requested', deploymentId: deploymentFixture.deployment.id, status: 'CANCEL_REQUESTED' });
  }
  return json(405, { error: 'fixture_operation_method_not_allowed' });
}

function resourceConsoleResponse({ body, method, pathname, state }) {
  const base = `/resources/${resource.id}/console`;
  if (state === 'partial' && ['/schema', '/tables', '/collections', '/keys'].some((suffix) => pathname === `${base}${suffix}`)) return json(503, { error: 'fixture_resource_data_unavailable' });
  if (pathname === `${base}/schema` && method === 'GET') return json(200, { schema: resourceConsole.schema, connectionInfo: resourceConsole.schema.connectionInfo });
  if (pathname === `${base}/tables` && method === 'GET') return json(200, { tables: state === 'empty' ? [] : resourceConsole.tables });
  if (pathname === `${base}/collections` && method === 'GET') return json(200, { collections: state === 'empty' ? [] : resourceConsole.collections });
  if (pathname === `${base}/keys` && method === 'GET') return json(200, { keys: state === 'empty' ? [] : resourceConsole.keys });
  if (pathname === `${base}/browse` && method === 'POST') return json(200, state === 'empty' ? { rows: [] } : resourceConsole.browse);
  if (pathname === `${base}/query` && method === 'POST') return json(200, { result: { rows: [{ status: 'READY' }], confirmed: body.confirmed === 'true' } });
  if (pathname === `${base}/command` && method === 'POST') {
    if (body.confirmed !== 'true') return json(400, { error: 'fixture_confirmation_required' });
    return json(202, { operation: 'provider_command_requested', resourceId: resource.id });
  }
  return json(405, { error: 'fixture_resource_method_not_allowed' });
}

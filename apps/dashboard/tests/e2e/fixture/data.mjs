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
  name: '결정적 운영 프로젝트', slug: 'deterministic-app', status: 'active', serviceCount: 2, resourceCount: 1,
};
const initialSettingsProject = Object.freeze({ name: project.name, description: null, updatedAt: FIXED_TIME, deletionRequestedAt: null });
let settingsProject = initialSettingsProject;
const initialDomains = Object.freeze([
  Object.freeze({
    id: 'dom_fixture_ready', organizationId: project.organizationId, projectId: project.id, serviceId: 'svc_fixture_web', hostname: 'app.fixture.example',
    status: 'READY', verificationVersion: 1, issuedAt: FIXED_TIME, expiresAt: '2026-09-01T03:00:00.000Z', verifiedAt: FIXED_TIME,
    verificationRequestedAt: FIXED_TIME, lastCheckedAt: FIXED_TIME, nextCheckAt: null, consecutiveFailures: 0, tlsStatus: 'READY', desiredGeneration: 1,
    controllerLeaseGeneration: 1, certificateObservedGeneration: 1, routeObservedGeneration: 1, cleanupBarrier: null, deletionRequestedAt: null,
    actorUserId: 'usr_fixture_admin', lastErrorCode: null, lastErrorMessage: null, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
  }),
  Object.freeze({
    id: 'dom_fixture_failed', organizationId: project.organizationId, projectId: project.id, serviceId: 'svc_fixture_web', hostname: 'failed.fixture.example',
    status: 'FAILED', verificationVersion: 1, issuedAt: FIXED_TIME, expiresAt: '2026-09-01T03:00:00.000Z', verifiedAt: null,
    verificationRequestedAt: FIXED_TIME, lastCheckedAt: FIXED_TIME, nextCheckAt: '2026-08-31T03:05:00.000Z', consecutiveFailures: 1, tlsStatus: 'PENDING', desiredGeneration: 1,
    controllerLeaseGeneration: 1, certificateObservedGeneration: null, routeObservedGeneration: null, cleanupBarrier: null, deletionRequestedAt: null,
    actorUserId: 'usr_fixture_admin', lastErrorCode: 'DNS_CHALLENGE_NOT_FOUND', lastErrorMessage: 'sanitized dns check failure', createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
  }),
]);
let customDomains = initialDomains;
const service = {
  id: 'svc_fixture_web', projectId: project.id, name: 'web', slug: 'web', type: 'web', status: 'running',
  sourceType: 'github', repoUrl: 'https://github.com/raibit/fixture-app', branch: 'main', dockerfilePath: 'Dockerfile', port: 3000,
};
const workerService = {
  id: 'svc_fixture_worker', projectId: project.id, name: 'worker', slug: 'worker', type: 'worker', status: 'running',
  sourceType: 'github', repoUrl: 'https://github.com/raibit/fixture-app', branch: 'main', dockerfilePath: 'Dockerfile', port: 3000,
};
const serviceSettings = {
  ...service,
  branch: 'main', rootDirectory: '', buildContext: '', dockerfilePath: 'Dockerfile', installCommand: '', buildCommand: '', startCommand: '', outputDirectory: '',
  healthCheckPath: '/healthz', livenessPath: '/healthz/live', readinessPath: '/healthz/ready', publicHealthPath: '/healthz',
  resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
};
const githubIntegration = {
  id: 'ghi_fixture', provider: 'github', organizationId: project.organizationId, accountLogin: 'raibit-fixture', installationId: '9001',
  status: 'ACTIVE', version: 7, connected: true, credentialIssuance: 'allowed', verifiedAt: FIXED_TIME,
  externalGitHubSettingsUrl: 'https://github.com/settings/installations/9001', reattachUrl: '/github/install',
};
const githubInstallation = {
  id: '9001', installationId: '9001', integrationId: githubIntegration.id, accountLogin: 'raibit-fixture', repositoryCount: 125,
};
const githubRepository = {
  id: 'repo_fixture', githubRepoId: 'repo_fixture', fullName: 'raibit/fixture-app', name: 'fixture-app',
  owner: 'raibit', normalizedIdentity: 'raibit/fixture-app', defaultBranch: service.branch, private: false,
  accessState: 'ACCESSIBLE', generation: 12, installationId: githubInstallation.installationId,
};
const githubRepositories = Object.freeze(Array.from({ length: 125 }, (_, index) => {
  if (index === 0) return githubRepository;
  const ordinal = String(index + 1).padStart(3, '0');
  const name = `fixture-repository-${ordinal}`;
  return Object.freeze({
    id: `repo_fixture_${ordinal}`, githubRepoId: `repo_fixture_${ordinal}`, installationId: githubInstallation.installationId,
    owner: 'raibit', name, fullName: `raibit/${name}`, normalizedIdentity: `raibit/${name}`,
    defaultBranch: index % 3 === 0 ? 'develop' : 'main', private: index % 2 === 0,
    accessState: index === 74 || index === 124 ? 'REVOKED' : 'ACCESSIBLE', generation: 12,
  });
}));
const githubMutationResults = new Map();
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
const resourceBackups = [
  {
    id: 'bak_fixture_ready', organizationId: project.organizationId, projectId: project.id, resourceId: resource.id, engine: resource.engine,
    status: 'READY', createdAt: FIXED_TIME, readyAt: FIXED_TIME, errorCode: null, size: '1048576', expiresAt: '2026-09-07T03:00:00.000Z', recoverable: true,
  },
  {
    id: 'bak_fixture_verifying', organizationId: project.organizationId, projectId: project.id, resourceId: resource.id, engine: resource.engine,
    status: 'VERIFYING', createdAt: '2026-08-31T02:59:00.000Z', readyAt: null, errorCode: null, size: null, expiresAt: null, recoverable: false,
  },
  {
    id: 'bak_fixture_failed', organizationId: project.organizationId, projectId: project.id, resourceId: resource.id, engine: resource.engine,
    status: 'FAILED', createdAt: '2026-08-31T02:58:00.000Z', readyAt: null, errorCode: 'RECOVERY_SOURCE_UNAVAILABLE', size: null, expiresAt: null, recoverable: false,
  },
];

export const FIXTURE_IDS = Object.freeze({
  project: project.id,
  service: service.id,
  workerService: workerService.id,
  resource: resource.id,
  readyDeployment: deployment.id,
  queuedDeployment: queuedDeployment.id,
  buildingDeployment: buildingDeployment.id,
  imageReadyDeployment: imageReadyDeployment.id,
  failedDeployment: failedDeployment.id,
  longDeployment: longDeployment.id,
  hostileDeployment: hostileDeployment.id,
  readyBackup: resourceBackups[0].id,
  verifyingBackup: resourceBackups[1].id,
  failedBackup: resourceBackups[2].id,
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

export function resetProjectSettingsFixture() {
  settingsProject = initialSettingsProject;
}

export function resetCustomDomainFixture() {
  customDomains = initialDomains;
}

export function resetGitHubMutationFixture() {
  githubMutationResults.clear();
}

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
  if (pathname === '/auth/me') return json(200, { user: actor, subject: { ...actor, organizationId: project.organizationId, organizationSlug: project.organizationSlug }, memberships: [{ organizationId: project.organizationId, role: actor.role === 'ADMIN' ? 'ADMIN' : 'VIEWER' }] });
  if (pathname === '/projects') return json(200, { projects: state === 'empty' ? [] : [{ ...project, name: state === 'long' ? longKoreanText : project.name }] });
  if (pathname === '/usage/me') return json(200, { usage: [{ metric: 'deployments', used: 1, limit: 10 }], quota: { maxProjects: 5 } });
  if (pathname === '/integrations/github') return json(200, { integrations: state === 'empty' ? [] : [githubIntegration] });
  if (method === 'POST' && pathname === `/organizations/${project.organizationId}/integrations/github/${githubIntegration.id}/disconnect`) {
    if (actor.role !== 'ADMIN') return json(403, { error: 'forbidden' });
    if (body.expectedVersion !== githubIntegration.version) return json(409, { error: 'stale_version' });
    return json(200, { integration: { ...githubIntegration, status: 'DISCONNECTED', version: githubIntegration.version + 1, connected: false, credentialIssuance: 'denied' }, affectedServiceCount: 2, credentialIssuance: 'denied', githubAppUninstalled: false });
  }
  if (pathname === '/github/install') return json(200, { installUrl: 'https://github.com/apps/raibit-fixture/installations/new?state=public-fixture-state' });
  if (pathname === '/github/installations') return json(200, { installations: state === 'empty' ? [] : [githubInstallation] });
  if (method === 'POST' && pathname === '/github/installations/9001/repositories/refresh') {
    if (actor.role !== 'ADMIN') return json(403, { error: 'forbidden' });
    if (body.expectedIntegrationVersion !== githubIntegration.version || body.expectedGeneration !== 12) return json(409, {});
    return json(200, { refreshed: true, repositoryCount: githubRepositories.length, generation: 12, refreshStatus: 'IDLE', lastSuccessfulSyncAt: FIXED_TIME, staleAt: null });
  }
  if (pathname === '/github/installations/9001/repositories') return githubCatalogResponse(searchParams);
  if (pathname === `/projects/${project.id}/services`) return json(200, { services: [service, workerService] });
  if (pathname === `/projects/${project.id}/domains`) return customDomainsResponse({ actor, body, method });
  const domainRoute = /^\/domains\/([^/]+)(?:\/(rotate|verify))?$/.exec(pathname);
  if (domainRoute) return customDomainResponse({ actor, body, method, domainId: decodeURIComponent(domainRoute[1]), action: domainRoute[2] || 'status' });
  if (pathname === `/projects/${project.id}/settings/deletion`) return projectDeletionResponse({ actor, body, method });
  if (pathname === `/projects/${project.id}/settings`) return projectSettingsResponse({ actor, body, method });
  if (method === 'POST' && pathname === '/github/repositories/import') return githubMutationResponse('import', body, importConflict(body), 201, {
    projectId: project.id, serviceId: service.id, integrationId: githubIntegration.id, repositoryId: githubRepository.id,
  });
  if (method === 'POST' && pathname === `/projects/${project.id}/services/${service.id}/github`) return githubMutationResponse('attach', body, attachConflict(body), 200, {
    projectId: project.id, serviceId: service.id, integrationId: githubIntegration.id, repositoryId: githubRepository.id, branch: service.branch,
  });
  if (method === 'POST' && pathname === '/github/repositories/raibit%2Ffixture-app/sync') return githubMutationResponse('sync', body, syncConflict(body), 200, {
    installationId: githubInstallation.installationId, repositoryId: githubRepository.id,
    fullName: githubRepository.fullName, defaultBranch: githubRepository.defaultBranch, synced: true,
  });
  if (pathname === `/projects/${project.id}/overview`) return json(200, { project, services: [service, workerService], deployments: [deployment], resources: [resource] });
  if (pathname === `/projects/${project.id}/deployments/history` && method === 'GET') return deploymentHistoryResponse({ actor, searchParams, state });
  if (pathname === `/services/${service.id}/settings`) return serviceSettingsResponse({ body, method });
  if (pathname === `/services/${service.id}/settings/preview`) return serviceSettingsPreviewResponse({ body, method });
  if (pathname === `/services/${service.id}/replacements`) return serviceReplacementResponse({ body, method });
  const deploymentFixture = deploymentFixtureForPath(pathname);
  if (deploymentFixture) return deploymentResponse({ actor, body, deploymentFixture, method, pathname, state });
  if (pathname === `/resources/${resource.id}`) return json(200, resource);
  if (pathname === `/resources/${resource.id}/backups`) return resourceBackupResponse({ body, method, pathname, state });
  if (pathname.startsWith('/backups/')) return resourceBackupResponse({ body, method, pathname, state });
  if (pathname.startsWith(`/resources/${resource.id}/console/`)) return resourceConsoleResponse({ body, method, pathname, state });
  if (pathname === `/services/${service.id}/logs`) return json(200, { logs: [{ timestamp: FIXED_TIME, line: longKoreanText }] });
  if (pathname === `/services/${workerService.id}/logs`) return json(200, { logs: [{ id: 'worker-initial', timestamp: FIXED_TIME, level: 'info', line: 'worker-only-initial-log' }, { id: 'worker-hostile', timestamp: FIXED_TIME, level: 'warn', line: hostileLogLine }] });
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

function githubCatalogResponse(searchParams) {
  const q = normalizeRepositoryQuery(searchParams.get('q') || '');
  const cursor = searchParams.get('cursor') || '';
  const offsetByCursor = { '': 0, 'fixture-catalog-page-2': 50, 'fixture-catalog-page-3': 100 };
  if (!Object.hasOwn(offsetByCursor, cursor)) return json(400, { error: 'invalid_cursor' });
  const repositories = q ? githubRepositories.filter((repository) => repository.normalizedIdentity.includes(q)) : githubRepositories;
  const offset = offsetByCursor[cursor];
  const page = repositories.slice(offset, offset + 50);
  const nextCursor = offset + 50 < repositories.length
    ? offset === 0 ? 'fixture-catalog-page-2' : 'fixture-catalog-page-3'
    : null;
  return json(200, {
    installationId: githubInstallation.installationId,
    generation: 12,
    refreshStatus: 'IDLE',
    lastSuccessfulSyncAt: FIXED_TIME,
    staleAt: null,
    repositories: page,
    nextCursor,
  });
}

function normalizeRepositoryQuery(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 200);
}

function githubMutationResponse(operation, body, conflict, status, success) {
  if (conflict) return json(409, conflict);
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!idempotencyKey) return json(status, success);
  const fingerprint = JSON.stringify(Object.entries(body).filter(([key]) => key !== 'idempotencyKey').sort(([left], [right]) => left.localeCompare(right)));
  const existing = githubMutationResults.get(`${operation}:${idempotencyKey}`);
  if (existing && existing.fingerprint !== fingerprint) return json(409, githubConflict('GITHUB_IDEMPOTENCY_CONFLICT', { action: 'CANCEL' }));
  if (existing) return existing.response;
  const response = json(status, success);
  githubMutationResults.set(`${operation}:${idempotencyKey}`, { fingerprint, response });
  return response;
}

function importConflict(body) {
  if (body.repositoryId === 'repo_fixture_duplicate') return githubConflict('GITHUB_DUPLICATE_IMPORT', { action: 'OPEN_EXISTING_PROJECT', projectId: project.id });
  if (body.serviceSlug === 'foreign') return githubConflict('GITHUB_DUPLICATE_IMPORT', { action: 'CANCEL' });
  if (body.serviceSlug === 'taken') return githubConflict('GITHUB_PROJECT_SLUG_COLLISION', { action: 'CHOOSE_NEW_SLUG', suggestedSlug: 'fixture-app-2' });
  if (body.expectedCatalogGeneration === 11) return githubConflict('GITHUB_CATALOG_STALE', { action: 'REFRESH_CATALOG', installationId: githubInstallation.installationId });
  return null;
}

function attachConflict(body) {
  if (body.branch === 'changed') return githubConflict('GITHUB_DEFAULT_BRANCH_CHANGED', { action: 'SELECT_BRANCH', repositoryId: githubRepository.id, currentDefaultBranch: 'trunk', requestedBranch: 'main' });
  if (body.branch === 'missing') return githubConflict('GITHUB_DEFAULT_BRANCH_MISSING', { action: 'SELECT_BRANCH', repositoryId: githubRepository.id });
  if (body.repositoryId === 'repo_fixture_bound') return githubConflict('GITHUB_SERVICE_ALREADY_BOUND', { action: 'OPEN_EXISTING_SERVICE', projectId: project.id, serviceId: service.id });
  if (body.integrationId === 'ghi_fixture_mismatch') return githubConflict('GITHUB_INSTALLATION_MISMATCH', { action: 'REATTACH_INSTALLATION', installationId: githubInstallation.installationId });
  return null;
}

function syncConflict(body) {
  if (body.idempotencyKey === 'fixture-revoked') return githubConflict('GITHUB_SOURCE_ACCESS_REVOKED', { action: 'REFRESH_CATALOG', installationId: githubInstallation.installationId });
  if (body.idempotencyKey === 'fixture-disconnected') return githubConflict('GITHUB_SOURCE_DISCONNECTED', { action: 'REATTACH_INSTALLATION', installationId: githubInstallation.installationId });
  return null;
}

function githubConflict(code, recovery) {
  return { statusCode: 409, message: code, error: code, code, retryable: false, terminal: true, permission: false, recovery };
}

function json(status, body) { return { status, body }; }

function projectSettingsResponse({ actor, body, method }) {
  if (method === 'GET') return json(200, projectSettingsView());
  if (method !== 'PATCH') return json(405, { error: 'fixture_settings_method_not_allowed' });
  if (actor.role !== 'ADMIN' && actor.id !== users.user.id) return json(403, { error: 'permission_denied' });
  const keys = Object.keys(body).sort();
  if (keys.length < 2 || keys.length > 3 || !keys.includes('expectedUpdatedAt') || keys.some((key) => !['expectedUpdatedAt', 'name', 'description'].includes(key))) return json(400, { error: 'invalid_request_body' });
  if (typeof body.expectedUpdatedAt !== 'string' || (body.name !== undefined && typeof body.name !== 'string') || (body.description !== undefined && typeof body.description !== 'string')) return json(400, { error: 'invalid_request_body' });
  if (body.expectedUpdatedAt !== settingsProject.updatedAt) return json(409, { error: 'STALE_PROJECT' });
  settingsProject = {
    ...settingsProject,
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.description === undefined ? {} : { description: body.description }),
    updatedAt: '2026-08-31T03:00:01.000Z',
  };
  return json(200, projectSettingsView());
}

function projectSettingsView() {
  return {
    project: {
      id: project.id,
      organizationId: project.organizationId,
      name: settingsProject.name,
      slug: project.slug,
      description: settingsProject.description,
      status: project.status,
      updatedAt: settingsProject.updatedAt,
      deletionRequestedAt: settingsProject.deletionRequestedAt,
    },
    snapshot: { updatedAt: settingsProject.updatedAt },
    deletionImpact: { services: 2, resources: 1, previews: 1 },
  };
}

function projectDeletionResponse({ actor, body, method }) {
  if (method !== 'POST') return json(405, { error: 'fixture_settings_method_not_allowed' });
  if (actor.role !== 'ADMIN') return json(403, { error: 'permission_denied' });
  if (Object.keys(body).length !== 1 || body.confirmed !== true) return json(400, { error: 'invalid_request_body' });
  if (settingsProject.deletionRequestedAt === null) settingsProject = { ...settingsProject, deletionRequestedAt: '2026-08-31T03:00:02.000Z' };
  return json(202, { projectId: project.id, status: 'DELETE_REQUESTED', deletionRequestedAt: settingsProject.deletionRequestedAt, scheduled: true });
}

function serviceSettingsSnapshot(settings = serviceSettings) {
  return { serviceId: service.id, projectId: project.id, updatedAt: FIXED_TIME, deployed: true, settings };
}

function serviceSettingsResponse({ body, method }) {
  if (method === 'GET') return json(200, serviceSettingsSnapshot());
  if (method === 'PATCH') {
    if (body.expectedUpdatedAt !== FIXED_TIME || !body.changes || typeof body.changes !== 'object') return json(409, { error: 'fixture_settings_stale' });
    return json(200, serviceSettingsSnapshot({ ...serviceSettings, ...body.changes }));
  }
  return json(405, { error: 'fixture_settings_method_not_allowed' });
}

function serviceSettingsPreviewResponse({ body, method }) {
  if (method !== 'POST') return json(405, { error: 'fixture_settings_preview_method_not_allowed' });
  if (body.expectedUpdatedAt !== FIXED_TIME || !body.changes || typeof body.changes !== 'object') return json(409, { error: 'fixture_settings_stale' });
  const next = { ...serviceSettings, ...body.changes };
  const diff = Object.entries(body.changes).map(([field, after]) => ({ field, before: serviceSettings[field] ?? null, after }));
  return json(200, { snapshot: serviceSettingsSnapshot(next), settings: next, diff, buildPlan: { before: { mode: 'dockerfile', dockerfilePath: serviceSettings.dockerfilePath }, after: { mode: 'dockerfile', dockerfilePath: next.dockerfilePath } } });
}

function serviceReplacementResponse({ body, method }) {
  if (method !== 'POST') return json(405, { error: 'fixture_replacement_method_not_allowed' });
  if (body.expectedUpdatedAt !== FIXED_TIME || body.confirmed !== true || !body.source || typeof body.name !== 'string') return json(409, { error: 'fixture_replacement_stale' });
  return json(201, { impact: 'old_service_preserved', oldServiceId: service.id, service: { ...service, id: 'svc_fixture_replacement', name: body.name, ...body.source } });
}

function customDomainsResponse({ actor, body, method }) {
  if (method === 'GET') return json(200, { domains: customDomains });
  if (method !== 'POST') return json(405, { code: 'DOMAIN_METHOD_NOT_ALLOWED' });
  if (actor.role !== 'ADMIN') return json(403, { code: 'permission_denied' });
  if (Object.keys(body).sort().join(',') !== 'hostname,serviceId' || typeof body.serviceId !== 'string' || typeof body.hostname !== 'string') return json(400, { code: 'DOMAIN_HOSTNAME_INVALID' });
  const hostname = body.hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!fixtureHostname(hostname)) return json(400, { code: 'DOMAIN_HOSTNAME_INVALID' });
  if (hostname.endsWith('.raibitserver.app')) return json(400, { code: 'DOMAIN_PLATFORM_ZONE_FORBIDDEN' });
  if (body.serviceId !== service.id) return json(400, { code: 'DOMAIN_SERVICE_NOT_PUBLIC_WEB' });
  if (customDomains.some((domain) => domain.hostname === hostname)) return json(409, { code: 'DOMAIN_HOSTNAME_CONFLICT' });
  const domain = fixtureDomain({ id: `dom_fixture_${customDomains.length + 1}`, serviceId: body.serviceId, hostname, actorUserId: actor.id });
  customDomains = [...customDomains, domain];
  return json(201, { domain, challengeToken: 'c'.repeat(43) });
}

function customDomainResponse({ actor, body, method, domainId, action }) {
  const domain = customDomains.find((candidate) => candidate.id === domainId);
  if (!domain) return json(404, { code: 'DOMAIN_NOT_FOUND' });
  if (action === 'status') {
    if (method === 'GET') return json(200, domain);
    if (method === 'DELETE') return deleteFixtureDomain({ actor, body, domain });
    return json(405, { code: 'DOMAIN_METHOD_NOT_ALLOWED' });
  }
  if (action === 'rotate') return rotateFixtureDomain({ actor, body, domain, method });
  if (action === 'verify') return verifyFixtureDomain({ actor, body, domain, method });
  return json(404, { code: 'DOMAIN_NOT_FOUND' });
}

function rotateFixtureDomain({ actor, body, domain, method }) {
  if (method !== 'POST') return json(405, { code: 'DOMAIN_METHOD_NOT_ALLOWED' });
  if (actor.role !== 'ADMIN') return json(403, { code: 'permission_denied' });
  if (Object.keys(body).sort().join(',') !== 'confirmed,expectedVersion' || body.confirmed !== true || !fixtureVersion(body.expectedVersion, domain)) return json(409, { code: 'DOMAIN_VERSION_CONFLICT' });
  const next = { ...domain, status: 'PENDING_VERIFICATION', verificationVersion: domain.verificationVersion + 1, issuedAt: '2026-08-31T03:00:02.000Z', expiresAt: '2026-09-01T03:00:02.000Z', verifiedAt: null, verificationRequestedAt: null, lastCheckedAt: null, nextCheckAt: null, consecutiveFailures: 0, tlsStatus: 'PENDING', desiredGeneration: domain.desiredGeneration + 1, certificateObservedGeneration: null, routeObservedGeneration: null, cleanupBarrier: { version: domain.verificationVersion, certificateAbsentObservedVersion: null, routeAbsentObservedVersion: null, complete: false }, actorUserId: actor.id, lastErrorCode: null, lastErrorMessage: null, updatedAt: '2026-08-31T03:00:02.000Z' };
  replaceFixtureDomain(next);
  return json(202, { domain: next, challengeToken: 'r'.repeat(43) });
}

function verifyFixtureDomain({ actor, body, domain, method }) {
  if (method !== 'POST') return json(405, { code: 'DOMAIN_METHOD_NOT_ALLOWED' });
  if (!['ADMIN', 'USER'].includes(actor.role)) return json(403, { code: 'permission_denied' });
  if (Object.keys(body).join(',') !== 'expectedVersion' || !fixtureVersion(body.expectedVersion, domain)) return json(409, { code: 'DOMAIN_VERSION_CONFLICT' });
  if (domain.status === 'DELETING') return json(409, { code: 'DOMAIN_DELETING' });
  const next = { ...domain, status: 'ROUTING', verifiedAt: '2026-08-31T03:00:03.000Z', verificationRequestedAt: '2026-08-31T03:00:03.000Z', lastCheckedAt: '2026-08-31T03:00:03.000Z', nextCheckAt: '2026-08-31T03:05:03.000Z', tlsStatus: 'PENDING', lastErrorCode: null, lastErrorMessage: null, updatedAt: '2026-08-31T03:00:03.000Z' };
  replaceFixtureDomain(next);
  return json(202, next);
}

function deleteFixtureDomain({ actor, body, domain }) {
  if (actor.role !== 'ADMIN') return json(403, { code: 'permission_denied' });
  if (Object.keys(body).join(',') !== 'expectedVersion' || !fixtureVersion(body.expectedVersion, domain)) return json(409, { code: 'DOMAIN_VERSION_CONFLICT' });
  const next = { ...domain, status: 'DELETING', deletionRequestedAt: '2026-08-31T03:00:04.000Z', cleanupBarrier: { version: domain.verificationVersion, certificateAbsentObservedVersion: null, routeAbsentObservedVersion: null, complete: false }, updatedAt: '2026-08-31T03:00:04.000Z' };
  replaceFixtureDomain(next);
  return json(202, next);
}

function fixtureHostname(hostname) {
  return hostname.length > 3 && hostname.length <= 253 && hostname.split('.').length > 1 && hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function fixtureVersion(version, domain) {
  return Number.isInteger(version) && version === domain.verificationVersion;
}

function fixtureDomain({ id, serviceId, hostname, actorUserId }) {
  return {
    id, organizationId: project.organizationId, projectId: project.id, serviceId, hostname, status: 'PENDING_VERIFICATION', verificationVersion: 1,
    issuedAt: '2026-08-31T03:00:01.000Z', expiresAt: '2026-09-01T03:00:01.000Z', verifiedAt: null, verificationRequestedAt: null,
    lastCheckedAt: null, nextCheckAt: null, consecutiveFailures: 0, tlsStatus: 'PENDING', desiredGeneration: 1, controllerLeaseGeneration: null,
    certificateObservedGeneration: null, routeObservedGeneration: null, cleanupBarrier: null, deletionRequestedAt: null, actorUserId, lastErrorCode: null,
    lastErrorMessage: null, createdAt: '2026-08-31T03:00:01.000Z', updatedAt: '2026-08-31T03:00:01.000Z',
  };
}

function replaceFixtureDomain(next) {
  customDomains = customDomains.map((domain) => domain.id === next.id ? next : domain);
}

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

function deploymentHistoryRow(value, actor) {
  const action = actor.role === 'ADMIN'
    ? value.status === 'FAILED'
      ? { type: 'retry', targetId: value.id, href: `/deployments/${encodeURIComponent(value.id)}/retry`, method: 'POST', confirmationRequired: true, snapshotVersion: 3 }
      : value.status === 'BUILDING'
        ? { type: 'cancel', targetId: value.id, href: `/deployments/${encodeURIComponent(value.id)}/cancel`, method: 'POST', confirmationRequired: true, snapshotVersion: 3 }
        : value.status === 'READY'
          ? { type: 'rollback', targetId: value.id, href: `/deployments/${encodeURIComponent(value.id)}/rollback`, method: 'POST', confirmationRequired: true, snapshotVersion: 3 }
          : null
    : null;
  return {
    ...value,
    projectId: project.id,
    service: { id: value.serviceId, name: value.serviceId === workerService.id ? workerService.name : service.name, slug: value.serviceId === workerService.id ? workerService.slug : service.slug },
    environment: value.deploymentType, trigger: 'push', updatedAt: value.createdAt,
    source: { commitSha: value.commitSha || null, imageDigest: value.imageDigest || null, snapshotVersion: 3 },
    lineage: { sourceDeploymentId: null, retryOfDeploymentId: value.status === 'FAILED' ? deployment.id : null, rollbackOfDeploymentId: null, previousDeploymentId: value.status === 'READY' ? failedDeployment.id : null, previewLineageId: null, previewGeneration: null },
    operation: { requestedByUserId: actor.id, requestIdempotencyKey: `fixture-${value.id}` },
    health: { rolloutStatus: value.status === 'READY' ? 'ready' : 'pending', publicHealthStatus: value.status === 'READY' ? 'healthy' : 'unknown', healthCheckedAt: value.status === 'READY' ? value.createdAt : null, healthFailureCode: value.errorCode || null, observedGeneration: 3 },
    recovery: { retryable: value.status === 'FAILED', reason: value.status === 'FAILED' ? null : '서버 상태가 이 복구 요청을 허용하지 않습니다.' },
    permissions: { execute: actor.role === 'ADMIN' },
    eligibleAction: action,
  };
}

function deploymentHistoryResponse({ actor, searchParams, state }) {
  const filters = {
    serviceId: searchParams.get('serviceId'), environment: searchParams.get('environment'), status: searchParams.get('status'), trigger: searchParams.get('trigger'), from: searchParams.get('from'), to: searchParams.get('to'),
  };
  const limitValue = Number(searchParams.get('limit'));
  const limit = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 100 ? limitValue : 25;
  const rows = (state === 'empty' ? [] : deploymentFixtures.map(({ deployment: entry }) => deploymentHistoryRow(entry, actor)))
    .filter((entry) => (!filters.serviceId || entry.service.id === filters.serviceId) && (!filters.environment || entry.environment === filters.environment) && (!filters.status || entry.status === filters.status) && (!filters.trigger || entry.trigger === filters.trigger) && (!filters.from || entry.createdAt >= filters.from) && (!filters.to || entry.createdAt <= filters.to));
  const start = searchParams.get('cursor') === 'fixture-history-page-2' ? limit : 0;
  const deployments = rows.slice(start, start + limit);
  return json(200, { deployments, page: { limit, nextCursor: start + limit < rows.length ? 'fixture-history-page-2' : null }, filters });
}

function deploymentResponse({ actor, body, deploymentFixture, method, pathname, state }) {
  const base = `/deployments/${encodeURIComponent(deploymentFixture.deployment.id)}`;
  if (pathname === base && method === 'GET') return json(200, deploymentHistoryRow(deploymentFixture.deployment, actor));
  if (state === 'partial' && (pathname === `${base}/logs` || pathname === `${base}/events`)) return json(503, { error: 'fixture_operation_data_unavailable' });
  if (pathname === `${base}/logs` && method === 'GET') {
    const logs = state === 'empty' ? [] : state === 'long' ? [{ timestamp: FIXED_TIME, line: longUnbrokenLog }, { timestamp: FIXED_TIME, line: hostileLogLine }, { timestamp: FIXED_TIME, line: longKoreanText }] : deploymentFixture.logs;
    return json(200, { logs });
  }
  if (pathname === `${base}/events` && method === 'GET') return json(200, { events: state === 'empty' ? [] : deploymentFixture.events });
  if (pathname === `${base}/retry` && method === 'POST') {
    if (typeof body.requestIdempotencyKey !== 'string' || body.snapshotVersion !== 3) return json(400, { error: 'fixture_retry_input_invalid' });
    return json(202, { operationId: 'op_fixture_retry', status: 'QUEUED', streamHref: `${base}/stream`, deployment: { ...deploymentFixture.deployment, id: 'dep_fixture_retry_successor', status: 'QUEUED' }, workflowJob: {} });
  }
  if (pathname === `${base}/rollback` && method === 'POST') {
    if (body.confirmed !== true) return json(400, { error: 'fixture_confirmation_required' });
    return json(202, { operationId: 'op_fixture_rollback', status: 'QUEUED', streamHref: `${base}/stream`, deployment: { ...deploymentFixture.deployment, id: 'dep_fixture_rollback_successor', status: 'QUEUED' }, rollbackOfDeploymentId: deploymentFixture.deployment.id, previousDeployment: deploymentFixture.deployment, workflowJob: {} });
  }
  if (pathname === `${base}/cancel` && method === 'POST') {
    const cancellable = new Set(['QUEUED', 'BUILDING', 'IMAGE_READY']);
    if (!cancellable.has(deploymentFixture.deployment.status)) return json(409, { error: 'fixture_cancel_not_allowed' });
    return json(200, { operationId: 'op_fixture_cancel', status: 'CANCELLED', streamHref: `${base}/stream`, deployment: { ...deploymentFixture.deployment, status: 'CANCELLED' } });
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

function resourceBackupResponse({ body, method, pathname, state }) {
  const listPath = `/resources/${resource.id}/backups`;
  if (state === 'partial' && pathname === listPath && method === 'GET') return json(503, { error: 'fixture_backup_data_unavailable' });
  if (pathname === listPath && method === 'GET') return json(200, { backups: state === 'empty' ? [] : resourceBackups, nextCursor: null });
  if (pathname === listPath && method === 'POST') {
    if (body.formatVersion !== 1 || typeof body.requestIdempotencyKey !== 'string') return json(400, { error: 'fixture_backup_input_invalid' });
    return json(202, {
      id: 'bak_fixture_requested', organizationId: project.organizationId, projectId: project.id, resourceId: resource.id, engine: resource.engine,
      status: 'QUEUED', createdAt: FIXED_TIME, readyAt: null, errorCode: null, size: null, expiresAt: null, recoverable: false,
    });
  }
  const restoreMatch = /^\/backups\/([^/]+)\/restores$/.exec(pathname);
  if (restoreMatch && method === 'POST') {
    const backup = resourceBackups.find((candidate) => candidate.id === restoreMatch[1]);
    if (!backup || backup.status !== 'READY' || !backup.recoverable) return json(409, { error: 'fixture_restore_not_available' });
    if (body.formatVersion !== 1 || typeof body.requestIdempotencyKey !== 'string' || typeof body.name !== 'string') return json(400, { error: 'fixture_restore_input_invalid' });
    return json(202, {
      id: 'rst_fixture_requested', organizationId: project.organizationId, projectId: project.id, backupId: backup.id, sourceResourceId: resource.id,
      targetResourceId: 'res_fixture_restored', engine: resource.engine, status: 'QUEUED', createdAt: FIXED_TIME, readyAt: null, errorCode: null,
    });
  }
  const deleteMatch = /^\/backups\/([^/]+)$/.exec(pathname);
  if (deleteMatch && method === 'DELETE') {
    const backup = resourceBackups.find((candidate) => candidate.id === deleteMatch[1]);
    if (!backup) return json(404, { error: 'RECOVERY_NOT_FOUND' });
    if (body.confirmed !== true) return json(400, { error: 'fixture_delete_confirmation_required' });
    return json(200, { ...backup, status: backup.status === 'DELETED' ? 'DELETED' : 'DELETING', recoverable: false });
  }
  return json(405, { error: 'fixture_backup_method_not_allowed' });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RAIBITSERVERClient, ApiTerminalError } from '../packages/api-client/src/index.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { GitHubSourceConflict } from '../packages/core/src/github-conflict.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

function fixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Conflicts', slug: 'conflicts' });
  const user = store.createUser({ email: 'conflicts@example.test', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  const project = store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const integration = store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '800', accountLogin: 'acme' });
  store.replaceGitHubInstallationRepositories({ installationId: '800', repositories: [{ githubRepoId: '101', fullName: 'acme/web', defaultBranch: 'main', private: true }] });
  return { store, organization, user, project, integration };
}

function expectConflict(operation, code, action) {
  assert.throws(operation, error => error.statusCode === 409 && error.code === code && error.recovery?.action === action);
}

test('GitHub source conflicts expose safe deterministic recoveries', () => {
  const stale = fixture();
  stale.store.githubIntegrations.set(stale.integration.id, { ...stale.store.githubIntegrations.get(stale.integration.id), refreshStatus: 'STALE' });
  expectConflict(() => stale.store.importGitHubRepository({ projectId: stale.project.id, integrationId: stale.integration.id, repositoryId: '101' }), 'GITHUB_CATALOG_STALE', 'REFRESH_CATALOG');

  const disconnected = fixture();
  disconnected.store.disconnectGitHubIntegration({ organizationId: disconnected.organization.id, integrationId: disconnected.integration.id, expectedVersion: 1 });
  expectConflict(() => disconnected.store.importGitHubRepository({ projectId: disconnected.project.id, integrationId: disconnected.integration.id, repositoryId: '101' }), 'GITHUB_SOURCE_DISCONNECTED', 'REATTACH_INSTALLATION');

  const revoked = fixture();
  const row = [...revoked.store.githubRepositories.values()][0];
  revoked.store.githubRepositories.set(row.id, { ...row, accessState: 'REVOKED' });
  expectConflict(() => revoked.store.importGitHubRepository({ projectId: revoked.project.id, integrationId: revoked.integration.id, repositoryId: '101' }), 'GITHUB_SOURCE_ACCESS_REVOKED', 'REFRESH_CATALOG');

  const branches = fixture();
  expectConflict(() => branches.store.importGitHubRepository({ projectId: branches.project.id, integrationId: branches.integration.id, repositoryId: '101', expectedDefaultBranch: 'trunk' }), 'GITHUB_DEFAULT_BRANCH_CHANGED', 'SELECT_BRANCH');
  const branchRow = [...branches.store.githubRepositories.values()][0];
  branches.store.githubRepositories.set(branchRow.id, { ...branchRow, defaultBranch: '' });
  expectConflict(() => branches.store.importGitHubRepository({ projectId: branches.project.id, integrationId: branches.integration.id, repositoryId: '101' }), 'GITHUB_DEFAULT_BRANCH_MISSING', 'SELECT_BRANCH');

  const mismatch = fixture();
  const other = mismatch.store.connectVerifiedGitHubInstallation({ organizationId: mismatch.organization.id, installationId: '801', accountLogin: 'other' });
  mismatch.store.registerGitHubRepository({ installationId: '801', githubRepoId: '202', fullName: 'other/api' });
  assert.throws(() => mismatch.store.importGitHubRepository({ projectId: mismatch.project.id, integrationId: mismatch.integration.id, repositoryId: '202' }), error => error.code === 'GITHUB_INSTALLATION_MISMATCH' && JSON.stringify(error.recovery) === '{"action":"CANCEL"}');
  assert.equal(other.status, 'ACTIVE');
});

test('GitHub import attach and sync are tenant-scoped and idempotent', () => {
  const { store, organization, project, integration } = fixture();
  const input = { projectId: project.id, integrationId: integration.id, repositoryId: '101', serviceName: 'Web', idempotencyKey: 'import-1' };
  const first = store.importGitHubRepository(input);
  const replay = store.importGitHubRepository(input);
  assert.equal(first.service.id, replay.service.id);
  assert.equal([...store.services.values()].filter(service => service.projectId === project.id).length, 1);
  assert.equal(store.auditLogs.filter(entry => entry.action === 'github:import-repository').length, 1);
  expectConflict(() => store.importGitHubRepository({ ...input, serviceName: 'Changed' }), 'GITHUB_IDEMPOTENCY_CONFLICT', 'CANCEL');
  expectConflict(() => store.importGitHubRepository({ ...input, idempotencyKey: 'import-2' }), 'GITHUB_DUPLICATE_IMPORT', 'OPEN_EXISTING_SERVICE');

  store.createService({ projectId: project.id, name: 'Taken' });
  store.registerGitHubRepository({ installationId: '800', githubRepoId: '102', fullName: 'acme/api', defaultBranch: 'main' });
  expectConflict(() => store.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repositoryId: '102', serviceName: 'Taken', serviceSlug: 'taken' }), 'GITHUB_PROJECT_SLUG_COLLISION', 'CHOOSE_NEW_SLUG');
  const recovered = store.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repositoryId: '102', serviceName: 'API', serviceSlug: 'api-recovered' });
  assert.deepEqual({ slug: recovered.service.slug, repositoryId: recovered.service.githubRepositoryId }, { slug: 'api-recovered', repositoryId: '102' });

  const target = store.createService({ projectId: project.id, name: 'Target', sourceType: 'image' });
  const attached = store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: target.id, integrationId: integration.id, repositoryId: '101', idempotencyKey: 'attach-1' });
  assert.equal(store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: target.id, integrationId: integration.id, repositoryId: '101', idempotencyKey: 'attach-1' }).service.id, attached.service.id);
  assert.equal(store.auditLogs.filter(entry => entry.action === 'github:attach-repository').length, 1);
  expectConflict(() => store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: target.id, integrationId: integration.id, repositoryId: '101', branch: 'other', idempotencyKey: 'attach-1' }), 'GITHUB_IDEMPOTENCY_CONFLICT', 'CANCEL');
  expectConflict(() => store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: recovered.service.id, integrationId: integration.id, repositoryId: '101' }), 'GITHUB_SERVICE_ALREADY_BOUND', 'OPEN_EXISTING_SERVICE');

  const sync = store.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: organization.id, idempotencyKey: 'sync-1' });
  const syncReplay = store.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: organization.id, idempotencyKey: 'sync-1' });
  assert.equal(sync.workflowJob.id, syncReplay.workflowJob.id);
  assert.equal(store.workflowJobs.filter(job => job.type === 'github-repository-sync').length, 1);
  expectConflict(() => store.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: organization.id, serviceIds: [target.id], idempotencyKey: 'sync-1' }), 'GITHUB_IDEMPOTENCY_CONFLICT', 'CANCEL');
  const foreignOrganization = store.createOrganization({ name: 'Foreign', slug: 'foreign' });
  const foreignProject = store.createProject({ organizationId: foreignOrganization.id, name: 'Foreign', slug: 'foreign' });
  assert.throws(() => store.importGitHubRepository({ ...input, projectId: foreignProject.id }), error => error.statusCode === 403 && error.recovery === undefined);
  store.githubIntegrations.set(integration.id, { ...store.githubIntegrations.get(integration.id), refreshStatus: 'STALE' });
  expectConflict(() => store.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: organization.id, idempotencyKey: 'sync-stale' }), 'GITHUB_CATALOG_STALE', 'REFRESH_CATALOG');
});

test('GitHub source mutation inputs survive Nest HTTP routing', async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', fileURLToPath(new URL('../apps/api/tsconfig.build.json', import.meta.url))]);
  const [{ Module }, { NestFactory }, { GitHubIntegrationController }, { GitHubIntegrationService }, { RAIBITSERVERService }] = await Promise.all([
    import('@nestjs/common'), import('@nestjs/core'),
    import(new URL('../apps/api/dist/modules/integrations/github.controller.js', import.meta.url).href),
    import(new URL('../apps/api/dist/modules/integrations/github.service.js', import.meta.url).href),
    import(new URL('../apps/api/dist/raibitserver.service.js', import.meta.url).href),
  ]);
  const calls = [];
  const service = {
    importGitHubRepository(input, subject) { calls.push({ input, subject }); return { service: { id: 'service-1', projectId: input.projectId, name: 'web', type: 'web' } }; },
  };
  class ConflictTestModule {}
  Module({ controllers: [GitHubIntegrationController], providers: [{ provide: GitHubIntegrationService, useValue: service }] })(ConflictTestModule);
  const app = await NestFactory.create(ConflictTestModule, { logger: false });
  const subject = { id: 'owner-1', role: 'OWNER', organizationId: 'org-1' };
  app.use((req, _res, next) => { req.raibitSubject = subject; next(); });
  await app.listen(0, '127.0.0.1');
  try {
    const result = await request(app.getHttpServer(), '/github/repositories/import', { projectId: 'project-1', integrationId: 'integration-1', repositoryId: '101', serviceSlug: 'web-new', expectedDefaultBranch: 'main', expectedCatalogGeneration: 4, idempotencyKey: 'nest-1' });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(calls, [{ input: { projectId: 'project-1', integrationId: 'integration-1', repositoryId: '101', serviceSlug: 'web-new', expectedDefaultBranch: 'main', expectedCatalogGeneration: 4, idempotencyKey: 'nest-1' }, subject }]);
    const controlPlaneService = new RAIBITSERVERService();
    Object.defineProperty(controlPlaneService, 'repositoryPromise', { value: Promise.resolve({
      getProject: async () => ({ id: 'project-1', organizationId: 'org-1' }),
      importGitHubRepository: async () => { throw new GitHubSourceConflict('GITHUB_CATALOG_STALE', { action: 'REFRESH_CATALOG', installationId: '800' }); },
    }) });
    await assert.rejects(controlPlaneService.importGitHubRepository({ projectId: 'project-1' }, subject), error => {
      assert.equal(error.getStatus(), 409);
      assert.deepEqual(error.getResponse(), { statusCode: 409, message: 'GITHUB_CATALOG_STALE', error: 'GITHUB_CATALOG_STALE', code: 'GITHUB_CATALOG_STALE', retryable: false, terminal: true, permission: false, recovery: { action: 'REFRESH_CATALOG', installationId: '800' } });
      return true;
    });
  } finally { await app.close(); }
});

function request(server, path, body) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return new Promise((resolve, reject) => {
    const value = JSON.stringify(body);
    const outgoing = http.request({ host: '127.0.0.1', port: address.port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(value) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    outgoing.on('error', reject);
    outgoing.end(value);
  });
}

test('GitHub conflict contract survives semantic HTTP and typed SDK', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const { organization, user, project, integration } = (() => {
    const organization = controlPlane.store.createOrganization({ name: 'HTTP', slug: 'conflict-http' });
    const user = controlPlane.store.createUser({ email: 'conflict-http@example.test', approvalStatus: 'APPROVED' });
    controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
    const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'HTTP App', slug: 'http-app' });
    const integration = controlPlane.store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '900', accountLogin: 'http' });
    controlPlane.store.replaceGitHubInstallationRepositories({ installationId: '900', repositories: [{ githubRepoId: '901', fullName: 'http/web', defaultBranch: 'main' }] });
    controlPlane.store.githubIntegrations.set(integration.id, { ...controlPlane.store.githubIntegrations.get(integration.id), refreshStatus: 'STALE' });
    return { organization, user, project, integration };
  })();
  const secret = 'github-conflict-http-secret';
  const token = signJwtHs256({ sub: user.id, role: 'OWNER', organizationId: organization.id }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${address.port}`, token });
    await assert.rejects(client.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repositoryId: '901', idempotencyKey: 'http-1' }), error => error instanceof ApiTerminalError && error.body.code === 'GITHUB_CATALOG_STALE' && error.body.recovery?.action === 'REFRESH_CATALOG');
  } finally { server.close(); }
});

test('Prisma transaction fixture persists one sync result per idempotency key', async () => {
  const mutations = new Map();
  const jobs = [];
  const service = { id: 'service-1', projectId: 'project-1', githubRepositoryId: '101', branch: 'main', repoUrl: 'https://github.com/acme/web.git', desiredState: { githubIntegrationId: 'integration-1', githubRepositoryId: '101', githubRepository: 'acme/web', sourceAccess: 'github-app-private' }, project: { organizationId: 'organization-1' } };
  const tx = {
    service: { findMany: async () => [service] },
    gitHubIntegration: { findUnique: async () => ({ id: 'integration-1', organizationId: 'organization-1', installationId: '800', status: 'ACTIVE', verifiedAt: new Date() }) },
    gitHubInstallation: { findUnique: async () => ({ installationId: '800', generation: 0, refreshStatus: 'IDLE' }) },
    gitHubRepository: { findMany: async () => [{ id: 'row-101', githubRepoId: '101', installationId: '800', fullName: 'acme/web', defaultBranch: 'main', accessState: 'ACCESSIBLE', generation: 0 }] },
    gitHubSourceMutation: {
      findUnique: async ({ where }) => mutations.get(`${where.organizationId_operation_idempotencyKey.organizationId}:${where.organizationId_operation_idempotencyKey.operation}:${where.organizationId_operation_idempotencyKey.idempotencyKey}`) || null,
      create: async ({ data }) => { mutations.set(`${data.organizationId}:${data.operation}:${data.idempotencyKey}`, data); return data; },
    },
    workflowJob: { create: async ({ data }) => { const row = { id: `job-${jobs.length + 1}`, ...data }; jobs.push(row); return row; } },
    auditLog: { create: async ({ data }) => data },
  };
  const repository = new PrismaControlPlaneRepository({ service: tx.service, $transaction: async callback => callback(tx) });
  const first = await repository.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: 'organization-1', idempotencyKey: 'prisma-sync-1' });
  const replay = await repository.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: 'organization-1', idempotencyKey: 'prisma-sync-1' });
  assert.equal(first.workflowJob.id, replay.workflowJob.id);
  assert.deepEqual({ mutations: mutations.size, jobs: jobs.length }, { mutations: 1, jobs: 1 });
  await assert.rejects(repository.syncGitHubRepository({ repositoryId: 'acme/web', organizationId: 'organization-1', branch: 'changed', idempotencyKey: 'prisma-sync-1' }), error => error.code === 'GITHUB_IDEMPOTENCY_CONFLICT' && error.recovery.action === 'CANCEL');
});

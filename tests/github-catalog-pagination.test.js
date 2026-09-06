import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

function repository(index, installationId = '700') {
  return { installationId, githubRepoId: String(10_000 + index), fullName: `Catalog/Repo-${String(index).padStart(3, '0')}`, defaultBranch: index % 2 ? 'main' : 'trunk', private: index % 3 === 0 };
}

function fixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Catalog', slug: 'catalog' });
  const foreign = store.createOrganization({ name: 'Foreign', slug: 'foreign-catalog' });
  const user = store.createUser({ email: 'catalog@example.test', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  const integration = store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '700', accountLogin: 'catalog' });
  return { store, organization, foreign, user, integration };
}

test('repository catalog pagination happy path', async () => {
  const { store, organization, integration, user } = fixture();
  const source = Array.from({ length: 125 }, (_, index) => repository(index));
  const fetchedPages = [];
  store.setGitHubCatalogPageFetcher(async ({ page }) => {
    fetchedPages.push(page);
    return { repositories: source.slice((page - 1) * 60, page * 60), hasNextPage: page < 3 };
  });
  const refreshed = await store.refreshGitHubInstallationRepositories({ organizationId: organization.id, installationId: '700', expectedIntegrationVersion: integration.version, expectedGeneration: 0, actorUserId: 'owner' });
  assert.deepEqual(fetchedPages, [1, 2, 3]);
  assert.equal(refreshed.repositoryCount, 125);
  assert.equal(refreshed.generation, 1);
  assert.ok(refreshed.lastSuccessfulSyncAt);

  const first = store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id });
  const second = store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id, cursor: first.nextCursor });
  const third = store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id, cursor: second.nextCursor });
  assert.deepEqual([first.repositories.length, second.repositories.length, third.repositories.length], [50, 50, 25]);
  assert.equal(third.nextCursor, null);
  const ids = [...first.repositories, ...second.repositories, ...third.repositories].map(row => row.githubRepoId);
  assert.equal(new Set(ids).size, 125);

  const jwtSecret = 'catalog-pagination-jwt-secret';
  const token = signJwtHs256({ sub: user.id, role: 'OWNER', organizationId: organization.id }, jwtSecret);
  const server = http.createServer(createApiHandler(new RAIBITSERVERControlPlane(store), { auth: { mode: 'jwt', jwtSecret } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${address.port}`, token });
    const page = await client.listGitHubInstallationRepositories('700', { cursor: second.nextCursor });
    assert.equal(page.repositories.length, 25);
    assert.equal(page.generation, 1);
    const apiRefresh = await client.refreshGitHubInstallationRepositories('700', { expectedIntegrationVersion: integration.version, expectedGeneration: 1 });
    assert.equal(apiRefresh.generation, 2);
    assert.equal(apiRefresh.repositoryCount, 125);
  } finally { server.close(); }
});

test('repository catalog adversarial matrix', async () => {
  const { store, organization, foreign, integration } = fixture();
  const baseline = Array.from({ length: 55 }, (_, index) => repository(index));
  store.setGitHubCatalogPageFetcher(async () => ({ repositories: baseline, hasNextPage: false }));
  await store.refreshGitHubInstallationRepositories({ organizationId: organization.id, installationId: '700', expectedIntegrationVersion: integration.version, expectedGeneration: 0 });
  const project = store.createProject({ organizationId: organization.id, name: 'Catalog App', slug: 'catalog-app' });
  const imported = store.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repositoryId: '10000' }).service;
  const page = store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id });
  assert.throws(() => store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id, cursor: `${page.nextCursor}x` }), /cursor/i);
  assert.throws(() => store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id, cursor: page.nextCursor, q: 'other' }), /cursor/i);
  assert.deepEqual(store.listGitHubInstallationRepositories({ installationId: '700', organizationId: foreign.id }).repositories, []);

  for (const status of [403, 404, 429, 500, 504]) {
    let calls = 0;
    store.setGitHubCatalogPageFetcher(async ({ page: upstreamPage }) => {
      calls += 1;
      if (upstreamPage === 1) return { repositories: baseline.slice(0, 25), hasNextPage: true };
      const error = new Error('untrusted upstream failure');
      error.statusCode = status;
      throw error;
    });
    await assert.rejects(store.refreshGitHubInstallationRepositories({ organizationId: organization.id, installationId: '700', expectedIntegrationVersion: integration.version, expectedGeneration: 1 }), error => error.code === 'GITHUB_CATALOG_REFRESH_FAILED');
    assert.equal(calls, 4);
    const retained = store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id });
    assert.equal(retained.repositories.length, 50);
    assert.equal(retained.generation, 1);
    assert.equal(retained.refreshStatus, 'STALE');
  }

  store.setGitHubCatalogPageFetcher(async ({ page: upstreamPage }) => {
    if (upstreamPage === 1) return { repositories: baseline.slice(0, 25), hasNextPage: true };
    store.applyGitHubCatalogWebhook('installation_repositories', { action: 'removed', installation: { id: 700 }, catalog_generation: 1, repositories_removed: [{ id: 10_000 }] });
    return { repositories: baseline.slice(25), hasNextPage: false };
  });
  await assert.rejects(store.refreshGitHubInstallationRepositories({ organizationId: organization.id, installationId: '700', expectedIntegrationVersion: integration.version, expectedGeneration: 1 }), /generation/i);
  const afterRace = store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id });
  assert.equal(afterRace.generation, 2);
  assert.equal(afterRace.refreshStatus, 'IDLE');
  assert.equal(afterRace.repositories.some(row => row.githubRepoId === '10000'), false);
  assert.equal(store.services.get(imported.id).desiredState.sourceAccess, 'SOURCE_ACCESS_REVOKED');
  assert.throws(() => store.listGitHubInstallationRepositories({ installationId: '700', organizationId: organization.id, cursor: page.nextCursor }), /cursor/i);

  const disconnected = fixture();
  disconnected.store.setGitHubCatalogPageFetcher(async () => ({ repositories: baseline, hasNextPage: false }));
  await disconnected.store.refreshGitHubInstallationRepositories({ organizationId: disconnected.organization.id, installationId: '700', expectedIntegrationVersion: disconnected.integration.version, expectedGeneration: 0 });
  const disconnectProject = disconnected.store.createProject({ organizationId: disconnected.organization.id, name: 'Disconnect App', slug: 'disconnect-app' });
  const disconnectService = disconnected.store.importGitHubRepository({ projectId: disconnectProject.id, integrationId: disconnected.integration.id, repositoryId: '10000' }).service;
  disconnected.store.setGitHubCatalogPageFetcher(async ({ page: upstreamPage }) => {
    if (upstreamPage === 1) return { repositories: baseline.slice(0, 25), hasNextPage: true };
    disconnected.store.disconnectGitHubIntegration({ organizationId: disconnected.organization.id, integrationId: disconnected.integration.id, expectedVersion: disconnected.integration.version, actorUserId: disconnected.user.id });
    return { repositories: baseline.slice(25), hasNextPage: false };
  });
  await assert.rejects(disconnected.store.refreshGitHubInstallationRepositories({ organizationId: disconnected.organization.id, installationId: '700', expectedIntegrationVersion: disconnected.integration.version, expectedGeneration: 1 }), /version/i);
  const afterDisconnectRace = disconnected.store.listGitHubInstallationRepositories({ installationId: '700', organizationId: disconnected.organization.id });
  assert.equal(afterDisconnectRace.generation, 1);
  assert.equal(afterDisconnectRace.refreshStatus, 'STALE');
  assert.equal(afterDisconnectRace.repositories.length, 0);
  assert.equal([...disconnected.store.githubRepositories.values()].filter(row => row.installationId === '700').length, 55);
  assert.equal(disconnected.store.services.get(disconnectService.id).desiredState.sourceAccess, 'GITHUB_SOURCE_DISCONNECTED');
  assert.equal(JSON.stringify([...store.auditLogs, ...disconnected.store.auditLogs]).includes('untrusted upstream failure'), false);
});

test('repository catalog Nest HTTP contract', async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', fileURLToPath(new URL('../apps/api/tsconfig.build.json', import.meta.url))]);
  const [{ Module }, { NestFactory }, { GitHubIntegrationController }, { GitHubIntegrationService }] = await Promise.all([
    import('@nestjs/common'), import('@nestjs/core'),
    import(new URL('../apps/api/dist/modules/integrations/github.controller.js', import.meta.url).href),
    import(new URL('../apps/api/dist/modules/integrations/github.service.js', import.meta.url).href),
  ]);
  const calls = [];
  const page = { installationId: '700', generation: 4, refreshStatus: 'IDLE', lastSuccessfulSyncAt: '2026-09-06T00:00:00.000Z', staleAt: null, repositories: [repository(1)], nextCursor: 'opaque-next' };
  const refreshed = { refreshed: true, repositoryCount: 125, generation: 5, refreshStatus: 'IDLE', lastSuccessfulSyncAt: '2026-09-06T00:01:00.000Z', staleAt: null };
  const service = {
    listGitHubInstallationRepositories(installationId, query, subject) { calls.push({ kind: 'list', installationId, query: { ...query }, subject }); return page; },
    refreshGitHubInstallationRepositories(installationId, input, subject) { calls.push({ kind: 'refresh', installationId, input, subject }); return refreshed; },
  };
  class CatalogTestModule {}
  Module({ controllers: [GitHubIntegrationController], providers: [{ provide: GitHubIntegrationService, useValue: service }] })(CatalogTestModule);
  const app = await NestFactory.create(CatalogTestModule, { logger: false });
  const subject = { id: 'owner-1', role: 'OWNER', organizationId: 'org-catalog' };
  app.use((req, _res, next) => { req.raibitSubject = subject; next(); });
  await app.listen(0, '127.0.0.1');
  try {
    const listed = await nestRequest(app.getHttpServer(), '/github/installations/700/repositories?cursor=opaque&q=repo', 'GET');
    const refresh = await nestRequest(app.getHttpServer(), '/github/installations/700/repositories/refresh', 'POST', { expectedIntegrationVersion: 3, expectedGeneration: 4 });
    assert.deepEqual({ status: listed.statusCode, generation: listed.body.generation, next: listed.body.nextCursor }, { status: 200, generation: 4, next: 'opaque-next' });
    assert.deepEqual({ status: refresh.statusCode, generation: refresh.body.generation, count: refresh.body.repositoryCount }, { status: 200, generation: 5, count: 125 });
    assert.deepEqual(calls, [
      { kind: 'list', installationId: '700', query: { cursor: 'opaque', q: 'repo' }, subject },
      { kind: 'refresh', installationId: '700', input: { expectedIntegrationVersion: 3, expectedGeneration: 4 }, subject },
    ]);
  } finally { await app.close(); }
});

function nestRequest(server, path, method, body) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return new Promise((resolve, reject) => {
    const value = body === undefined ? null : JSON.stringify(body);
    const headers = value === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(value) };
    const outgoing = http.request({ host: '127.0.0.1', port: address.port, path, method, headers }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    outgoing.on('error', reject);
    outgoing.end(value);
  });
}

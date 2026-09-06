import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createApiHandler } from '../packages/core/src/api.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';

const webhookSecret = 'github-lifecycle-test-secret';

function lifecycleFixture() {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Alice', slug: 'alice-lifecycle' });
  const foreignOrganization = store.createOrganization({ name: 'Mallory', slug: 'mallory-lifecycle' });
  const user = store.createUser({ email: 'alice-lifecycle@example.com', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  const project = store.createProject({ organizationId: organization.id, name: 'Web', slug: 'web' });
  const integration = store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '900', accountLogin: 'alice' });
  store.replaceGitHubInstallationRepositories({ installationId: '900', repositories: [
    { githubRepoId: '101', fullName: 'alice/web', private: true },
    { githubRepoId: '102', fullName: 'alice/docs', private: false },
  ] });
  const service = store.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repositoryId: '101', actorUserId: user.id });
  const deployment = store.createDeployment({ serviceId: service.service.id, status: 'READY', imageUrl: `registry.example/alice/web@sha256:${'a'.repeat(64)}` });
  return { store, organization, foreignOrganization, integration, service: service.service, deployment };
}

function signedLifecycleInput(event, action, deliveryId, extra = {}) {
  const payload = { action, installation: { id: 900, account: { login: 'alice', type: 'Organization' } }, sender: { id: 77 }, ...extra };
  const body = JSON.stringify(payload);
  return { event, deliveryId, payload, body, signature: `sha256=${crypto.createHmac('sha256', webhookSecret).update(body).digest('hex')}`, secret: webhookSecret };
}

test('GitHub disconnect reattach happy path', () => {
  const { store, organization, integration, service, deployment } = lifecycleFixture();

  const disconnected = store.disconnectGitHubIntegration({ organizationId: organization.id, integrationId: integration.id, expectedVersion: 1, actorUserId: 'owner-1' });
  assert.equal(disconnected.integration.status, 'DISCONNECTED');
  assert.equal(disconnected.integration.version, 2);
  assert.equal(disconnected.integration.credentialIssuance, 'denied');
  assert.equal(disconnected.githubAppUninstalled, false);
  assert.equal(disconnected.affectedServiceCount, 1);
  assert.equal(store.services.get(service.id).desiredState.sourceAccess, 'GITHUB_SOURCE_DISCONNECTED');
  assert.equal(store.deployments.get(deployment.id).status, 'READY');
  assert.equal(store.deployments.get(deployment.id).imageUrl, deployment.imageUrl);

  const reattached = store.connectVerifiedGitHubInstallation({ organizationId: organization.id, installationId: '900', accountLogin: 'alice', verifiedBy: 'trusted-callback' });
  assert.equal(reattached.status, 'ACTIVE');
  assert.equal(reattached.version, 3);
  assert.equal(store.services.get(service.id).desiredState.sourceAccess, 'GITHUB_SOURCE_DISCONNECTED');
  store.replaceGitHubInstallationRepositories({ installationId: '900', repositories: [{ githubRepoId: '101', fullName: 'alice/web', private: true }] });
  assert.equal(store.services.get(service.id).desiredState.sourceAccess, 'github-app-private');
  assert.match(reattached.externalGitHubSettingsUrl, /^https:\/\/github\.com\/settings\/installations\/900$/);
});

test('GitHub disconnect adversarial matrix', () => {
  const { store, organization, foreignOrganization, integration, service, deployment } = lifecycleFixture();
  assert.throws(() => store.disconnectGitHubIntegration({ organizationId: foreignOrganization.id, integrationId: integration.id, expectedVersion: 1, actorUserId: 'foreign' }), /not found/i);
  assert.throws(() => store.disconnectGitHubIntegration({ organizationId: organization.id, integrationId: integration.id, expectedVersion: 9, actorUserId: 'owner' }), /version/i);
  assert.equal(store.githubIntegrations.get(integration.id).status, 'ACTIVE');

  const suspended = store.handleGitHubWebhook(signedLifecycleInput('installation', 'suspended', 'delivery-suspended'));
  assert.equal(suspended.duplicate, false);
  assert.equal(store.githubIntegrations.get(integration.id).status, 'SUSPENDED');
  assert.equal(store.services.get(service.id).desiredState.sourceAccess, 'SOURCE_ACCESS_REVOKED');
  const duplicate = store.handleGitHubWebhook(signedLifecycleInput('installation', 'suspended', 'delivery-suspended'));
  assert.equal(duplicate.duplicate, true);
  store.handleGitHubWebhook(signedLifecycleInput('installation', 'unsuspended', 'delivery-unsuspended'));
  assert.equal(store.githubIntegrations.get(integration.id).status, 'ACTIVE');
  assert.equal(store.services.get(service.id).desiredState.sourceAccess, 'github-app-private');

  store.handleGitHubWebhook(signedLifecycleInput('installation_repositories', 'removed', 'delivery-repository-removed', {
    repositories_removed: [{ id: 101, full_name: 'alice/web' }],
  }));
  assert.equal(store.services.get(service.id).desiredState.sourceAccess, 'SOURCE_ACCESS_REVOKED');
  assert.equal(store.deployments.get(deployment.id).status, 'READY');
  assert.equal(store.deployments.get(deployment.id).imageUrl, deployment.imageUrl);

  store.disconnectGitHubIntegration({ organizationId: organization.id, integrationId: integration.id, expectedVersion: 3, actorUserId: 'owner' });
  store.handleGitHubWebhook(signedLifecycleInput('installation', 'deleted', 'delivery-deleted'));
  assert.equal(store.githubIntegrations.get(integration.id).status, 'DELETED');
  assert.equal(store.githubIntegrations.get(integration.id).version, 5);
  store.handleGitHubWebhook(signedLifecycleInput('installation', 'deleted', 'delivery-deleted-replayed'));
  assert.equal(store.githubIntegrations.get(integration.id).version, 5);

  const auditText = JSON.stringify(store.auditLogs);
  assert.equal(auditText.includes(webhookSecret), false);
  assert.equal(auditText.includes('token'), false);
});

test('GitHub disconnect reattach happy path over semantic HTTP', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'HTTP', slug: 'github-http' });
  const user = controlPlane.store.createUser({ email: 'github-http@example.com', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'ADMIN' });
  const integration = controlPlane.store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '901', accountLogin: 'http' });
  const jwtSecret = 'github-http-jwt-secret-for-tests';
  const token = signJwtHs256({ sub: user.id, role: 'ADMIN', organizationId: organization.id }, jwtSecret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret } }));
  server.listen(0);
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const result = await new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${address.port}`, token }).disconnectGitHubIntegration(organization.id, integration.id, 1);
    assert.deepEqual({ status: result.integration.status, version: result.integration.version, uninstalled: result.githubAppUninstalled }, { status: 'DISCONNECTED', version: 2, uninstalled: false });
  } finally {
    server.close();
  }
});

test('GitHub disconnect adversarial matrix over semantic HTTP', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'HTTP denied', slug: 'github-http-denied' });
  const foreign = controlPlane.store.createOrganization({ name: 'Foreign', slug: 'github-http-foreign' });
  const user = controlPlane.store.createUser({ email: 'github-http-denied@example.com', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'VIEWER' });
  const integration = controlPlane.store.connectVerifiedGitHubInstallation({ organizationId: organization.id, userId: user.id, installationId: '902', accountLogin: 'denied' });
  const jwtSecret = 'github-http-denied-jwt-secret';
  const viewer = signJwtHs256({ sub: user.id, role: 'VIEWER', organizationId: organization.id }, jwtSecret);
  const admin = signJwtHs256({ sub: user.id, role: 'ADMIN', organizationId: organization.id }, jwtSecret);
  const multiOrgAdmin = signJwtHs256({ sub: user.id, role: 'ADMIN', organizationId: organization.id, organizationIds: [organization.id, foreign.id], rolesByOrganization: { [organization.id]: 'ADMIN', [foreign.id]: 'ADMIN' } }, jwtSecret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret } }));
  server.listen(0);
  await once(server, 'listening');
  try {
    assert.equal((await request(server, `/organizations/${organization.id}/integrations/github/${integration.id}/disconnect`, viewer, { expectedVersion: 1 })).statusCode, 403);
    assert.equal((await request(server, `/organizations/${organization.id}/integrations/github/${integration.id}/disconnect`, admin, { expectedVersion: 9 })).statusCode, 409);
    assert.equal((await request(server, `/organizations/${foreign.id}/integrations/github/${integration.id}/disconnect`, admin, { expectedVersion: 1 })).statusCode, 403);
    assert.equal((await request(server, `/organizations/${foreign.id}/integrations/github/${integration.id}/disconnect`, multiOrgAdmin, { expectedVersion: 1 })).statusCode, 404);
    assert.equal(controlPlane.store.githubIntegrations.get(integration.id).status, 'ACTIVE');
  } finally {
    server.close();
  }
});

test('GitHub disconnect reattach happy path over Nest semantic HTTP', async () => {
  const controllerUrl = new URL('../apps/api/dist/modules/integrations/github.controller.js', import.meta.url);
  if (!existsSync(controllerUrl)) {
    execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', fileURLToPath(new URL('../apps/api/tsconfig.build.json', import.meta.url))]);
  }
  const [{ Module }, { NestFactory }, { GitHubIntegrationController }, { GitHubIntegrationService }] = await Promise.all([
    import('@nestjs/common'),
    import('@nestjs/core'),
    import(controllerUrl.href),
    import(new URL('../apps/api/dist/modules/integrations/github.service.js', import.meta.url).href),
  ]);
  const calls = [];
  const service = {
    disconnectGitHubIntegration(organizationId, integrationId, input, subject) {
      calls.push({ organizationId, integrationId, input, subject });
      return { integration: { id: integrationId, organizationId, accountLogin: 'nest', installationId: '903', status: 'DISCONNECTED', version: 2, connected: false, credentialIssuance: 'denied', verifiedAt: null, externalGitHubSettingsUrl: 'https://github.com/settings/installations/903', reattachUrl: `/github/install?organizationId=${organizationId}` }, affectedServiceCount: 1, credentialIssuance: 'denied', githubAppUninstalled: false };
    },
  };
  class LifecycleTestModule {}
  Module({ controllers: [GitHubIntegrationController], providers: [{ provide: GitHubIntegrationService, useValue: service }] })(LifecycleTestModule);
  const app = await NestFactory.create(LifecycleTestModule, { logger: false });
  app.use((req, _res, next) => { req.raibitSubject = { id: 'owner-1', role: 'OWNER', organizationId: 'org-nest' }; next(); });
  await app.listen(0, '127.0.0.1');
  try {
    const result = await request(app.getHttpServer(), '/organizations/org-nest/integrations/github/integration-nest/disconnect', 'fixture', { expectedVersion: 1 });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.integration.status, 'DISCONNECTED');
    assert.deepEqual(calls, [{ organizationId: 'org-nest', integrationId: 'integration-nest', input: { expectedVersion: 1 }, subject: { id: 'owner-1', role: 'OWNER', organizationId: 'org-nest' } }]);
  } finally {
    await app.close();
  }
});

function request(server, path, token, body) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return new Promise((resolve, reject) => {
    const value = JSON.stringify(body);
    const outgoing = http.request({ port: address.port, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(value) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    outgoing.on('error', reject);
    outgoing.end(value);
  });
}

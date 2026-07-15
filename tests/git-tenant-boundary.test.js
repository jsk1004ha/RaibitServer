import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';

import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { sanitizeTenantServiceInput } from '../packages/core/src/security.ts';

function verifiedIntegration(store, organizationId, accountLogin, installationId, userId = null) {
  const integration = store.createGitHubIntegration({ organizationId, userId, accountLogin, installationId });
  return store.verifyGitHubIntegration({
    integrationId: integration.id,
    installationId,
    accountLogin,
    verifiedBy: 'github-app-callback',
  });
}

function signedWebhook(store, event, deliveryId, payload, secret = 'tenant-boundary-secret') {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return store.handleGitHubWebhook({ event, deliveryId, payload, body, signature, secret });
}

test('GitHub repository attachment requires a verified same-organization installation repository', () => {
  const store = new ControlPlaneStore();
  const organizationA = store.createOrganization({ name: 'Organization A', slug: 'organization-a' });
  const organizationB = store.createOrganization({ name: 'Organization B', slug: 'organization-b' });
  const projectA = store.createProject({ organizationId: organizationA.id, name: 'Project A', slug: 'project-a' });
  const serviceA = store.createService({ projectId: projectA.id, name: 'web', sourceType: 'image', imageUrl: 'registry.example/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const integrationA = verifiedIntegration(store, organizationA.id, 'alice', 'installation-a');
  const integrationB = verifiedIntegration(store, organizationB.id, 'bob', 'installation-b');
  const repositoryA = store.registerGitHubRepository({ installationId: 'installation-a', githubRepoId: '101', fullName: 'alice/web', private: true });
  store.registerGitHubRepository({ installationId: 'installation-b', githubRepoId: '202', fullName: 'bob/private', private: true });
  const unverified = store.createGitHubIntegration({ organizationId: organizationA.id, accountLogin: 'mallory', installationId: 'installation-unverified' });

  assert.throws(
    () => store.attachGitHubRepositoryToService({ projectId: projectA.id, serviceId: serviceA.id, integrationId: 'missing', repoUrl: 'alice/web' }),
    /integration not found/i,
  );
  assert.throws(
    () => store.attachGitHubRepositoryToService({ projectId: projectA.id, serviceId: serviceA.id, integrationId: unverified.id, repoUrl: 'alice/web' }),
    /verified GitHub App installation/i,
  );
  assert.throws(
    () => store.attachGitHubRepositoryToService({ projectId: projectA.id, serviceId: serviceA.id, integrationId: integrationB.id, repoUrl: 'bob/private' }),
    /does not belong/i,
  );
  assert.throws(
    () => store.attachGitHubRepositoryToService({ projectId: projectA.id, serviceId: serviceA.id, integrationId: integrationA.id, repoUrl: 'bob/private' }),
    /repository is not available to the selected GitHub installation/i,
  );

  const attached = store.attachGitHubRepositoryToService({
    projectId: projectA.id,
    serviceId: serviceA.id,
    integrationId: integrationA.id,
    repositoryId: repositoryA.githubRepoId,
    repoUrl: 'https://github.com/ALICE/web.git',
    branch: 'main',
  });
  assert.equal(attached.service.repoUrl, 'https://github.com/alice/web.git');
  assert.equal(attached.service.githubRepositoryId, '101');
  assert.equal(attached.service.githubIntegrationId, integrationA.id);
  assert.equal(attached.service.githubInstallationId, 'installation-a');
  assert.equal(attached.service.githubRepositoryVisibility, 'private');
  assert.equal(attached.service.desiredState.github.repositoryId, '101');

  assert.throws(
    () => store.updateService(serviceA.id, { repoUrl: 'https://github.com/bob/private.git' }),
    /repository binding is immutable/i,
  );
  assert.throws(
    () => store.attachGitHubRepositoryToService({ projectId: projectA.id, serviceId: serviceA.id, integrationId: integrationA.id, repoUrl: 'alice/other' }),
    /repository binding is immutable|repository is not available/i,
  );
});

test('GitHub repository import resolves the authoritative installation record instead of trusting a URL claim', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Organization', slug: 'organization' });
  const project = store.createProject({ organizationId: organization.id, name: 'Project', slug: 'project' });
  const integration = verifiedIntegration(store, organization.id, 'alice', 'installation-a');
  store.registerGitHubRepository({ installationId: 'installation-a', githubRepoId: '101', fullName: 'alice/web', private: false, defaultBranch: 'trunk' });

  assert.throws(
    () => store.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repository: 'victim/private' }),
    /repository is not available to the selected GitHub installation/i,
  );

  const imported = store.importGitHubRepository({ projectId: project.id, integrationId: integration.id, repositoryId: '101', repository: 'alice/web' });
  assert.equal(imported.service.repoUrl, 'https://github.com/alice/web.git');
  assert.equal(imported.service.githubRepositoryId, '101');
  assert.equal(imported.service.branch, 'trunk');
});

test('tenant service payloads cannot self-assert a GitHub installation binding', () => {
  for (const binding of [
    { githubIntegrationId: 'integration-a' },
    { githubRepositoryId: '101' },
    { githubRepository: 'alice/web' },
    { desiredSpec: { githubIntegrationId: 'integration-a', githubRepositoryId: '101' } },
  ]) {
    assert.throws(
      () => sanitizeTenantServiceInput({ name: 'web', sourceType: 'github', repoUrl: 'https://github.com/alice/web.git', ...binding }),
      /GitHub repository bindings must be created through the verified attach or import flow/i,
    );
  }

  const anonymous = sanitizeTenantServiceInput({ name: 'public-web', sourceType: 'github', repoUrl: 'https://github.com/alice/public-web.git' });
  assert.equal(anonymous.repoUrl, 'https://github.com/alice/public-web.git');
  assert.equal(anonymous.githubIntegrationId, undefined);

  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Boundary Org', slug: 'boundary-org' });
  const project = store.createProject({ organizationId: organization.id, name: 'Boundary Project', slug: 'boundary-project' });
  assert.throws(
    () => store.createService({ projectId: project.id, name: 'forged', githubIntegrationId: 'integration-a', githubRepositoryId: '101' }),
    /verified attach or import flow/i,
  );
  const service = store.createService({ projectId: project.id, name: 'unbound', repoUrl: 'https://github.com/alice/public-web.git' });
  assert.throws(
    () => store.updateService(service.id, { githubInstallationId: 'installation-a', githubRepositoryId: '101' }),
    /verified attach or import flow/i,
  );
});

test('Prisma repository boundary enforces verified same-organization authoritative GitHub records', async () => {
  const project = { id: 'project-a', organizationId: 'organization-a', status: 'ACTIVE' };
  const service = { id: 'service-a', projectId: project.id, project, sourceType: 'image', repoUrl: null, githubRepositoryId: null, desiredState: {}, status: 'CREATED' };
  const integrations = {
    verified: { id: 'verified', organizationId: project.organizationId, installationId: 'installation-a', accountLogin: 'alice', defaultBranch: 'main', verifiedAt: new Date() },
    unverified: { id: 'unverified', organizationId: project.organizationId, installationId: 'installation-u', accountLogin: 'mallory', verifiedAt: null },
    cross: { id: 'cross', organizationId: 'organization-b', installationId: 'installation-b', accountLogin: 'bob', verifiedAt: new Date() },
  };
  const repositories = [{ id: 'record-101', installationId: 'installation-a', githubRepoId: '101', fullName: 'Alice/Web', defaultBranch: 'trunk', private: true }];
  let updateData = null;
  const prisma = {
    service: {
      findUnique: async () => service,
      update: async ({ data }) => {
        updateData = data;
        return { ...service, ...data };
      },
    },
    gitHubIntegration: { findUnique: async ({ where }) => integrations[where.id] || null },
    gitHubRepository: { findMany: async ({ where }) => repositories.filter((row) => row.installationId === where.installationId) },
    auditLog: { create: async () => ({}) },
  };
  const repository = new PrismaControlPlaneRepository(prisma);

  await assert.rejects(
    repository.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: 'missing', repositoryId: '101' }),
    /integration not found/i,
  );
  await assert.rejects(
    repository.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: 'unverified', repositoryId: '101' }),
    /verified GitHub App installation/i,
  );
  await assert.rejects(
    repository.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: 'cross', repositoryId: '101' }),
    /does not belong/i,
  );
  await assert.rejects(
    repository.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: 'verified', repository: 'victim/private' }),
    /repository is not available/i,
  );

  const attached = await repository.attachGitHubRepositoryToService({
    projectId: project.id,
    serviceId: service.id,
    integrationId: 'verified',
    repositoryId: '101',
    repository: 'alice/web',
  });
  assert.equal(attached.service.repoUrl, 'https://github.com/alice/web.git');
  assert.equal(attached.service.githubRepositoryId, '101');
  assert.equal(updateData.desiredState.github.installationId, 'installation-a');
  assert.equal(updateData.desiredState.github.visibility, 'private');
});

test('Prisma direct service mutations cannot self-assert a GitHub binding', async () => {
  let upsertCalled = false;
  const current = { id: 'service-a', projectId: 'project-a', status: 'CREATED', desiredState: {}, repoUrl: null, githubRepositoryId: null };
  const tx = {
    project: { findUnique: async () => ({ id: 'project-a', status: 'ACTIVE' }) },
    service: {
      findUnique: async ({ where }) => (where.id ? current : null),
      upsert: async () => { upsertCalled = true; return {}; },
      update: async () => { upsertCalled = true; return {}; },
    },
  };
  const repository = new PrismaControlPlaneRepository({ $transaction: async (callback) => callback(tx) });
  await assert.rejects(
    repository.createService({ projectId: 'project-a', name: 'forged', githubIntegrationId: 'integration-a', githubRepositoryId: '101' }),
    /verified attach or import flow/i,
  );
  await assert.rejects(
    repository.updateService('service-a', { githubInstallationId: 'installation-a', githubRepositoryId: '101' }),
    /verified attach or import flow/i,
  );
  assert.equal(upsertCalled, false);
});

test('signed GitHub installation events are the production trust path for installation and repository catalog records', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Webhook Organization', slug: 'webhook-organization' });
  const user = store.createUser({ email: 'installer@example.com', githubId: '500', approvalStatus: 'APPROVED' });
  const integration = store.createGitHubIntegration({ organizationId: organization.id, userId: user.id, accountLogin: 'alice' });

  const created = signedWebhook(store, 'installation', 'installation-created', {
    action: 'created',
    sender: { id: 500, login: 'alice-admin' },
    installation: { id: 900, account: { login: 'alice', type: 'Organization' } },
    repositories: [{ id: 101, full_name: 'alice/web', default_branch: 'main', private: false }],
  });

  assert.equal(created.actions.some((action) => action.type === 'github-installation-catalog-verified'), true);
  const verified = store.listGitHubIntegrations({ organizationId: organization.id })[0];
  assert.equal(String(verified.installationId), '900');
  assert.ok(verified.verifiedAt);
  const repositories = store.listGitHubInstallationRepositories({ installationId: '900', organizationId: organization.id }).repositories;
  assert.deepEqual(repositories.map((repository) => [repository.githubRepoId, repository.fullName]), [['101', 'alice/web']]);

  const rejectedStore = new ControlPlaneStore();
  const rejectedOrganization = rejectedStore.createOrganization({ name: 'Rejected Organization', slug: 'rejected-organization' });
  const rejectedUser = rejectedStore.createUser({ email: 'other-installer@example.com', githubId: '501', approvalStatus: 'APPROVED' });
  const rejectedIntegration = rejectedStore.createGitHubIntegration({ organizationId: rejectedOrganization.id, userId: rejectedUser.id, accountLogin: 'victim' });
  const rejected = signedWebhook(rejectedStore, 'installation', 'installation-unmatched-sender', {
    action: 'created',
    sender: { id: 999, login: 'attacker' },
    installation: { id: 901, account: { login: 'victim', type: 'Organization' } },
    repositories: [{ id: 201, full_name: 'victim/private', private: true }],
  });
  assert.equal(rejected.actions.some((action) => action.type === 'github-installation-catalog-verified'), false);
  assert.equal(rejectedStore.githubIntegrations.get(rejectedIntegration.id).verifiedAt, null);
  assert.equal(rejectedStore.githubRepositories.size, 0);
  assert.equal(integration.verifiedAt, null, 'tenant-created integration starts unverified');
});

test('GitHub deploy webhooks require the catalog installation id, numeric repository id, canonical name, and production branch', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Deploy Organization', slug: 'deploy-organization' });
  const owner = store.createUser({ email: 'deploy-owner@example.com', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  store.addMember({ organizationId: organization.id, userId: owner.id, role: 'owner' });
  store.setQuota({ userId: owner.id, accountType: 'NON_CLUB', maxDeploymentsPerDay: 10, maxPreviewDeployments: 5 });
  const project = store.createProject({ organizationId: organization.id, name: 'Deploy Project', slug: 'deploy-project' });
  const integration = verifiedIntegration(store, organization.id, 'alice', '900', owner.id);
  store.registerGitHubRepository({ installationId: '900', githubRepoId: '101', fullName: 'alice/web', private: false, defaultBranch: 'main' });
  const pending = store.createService({ projectId: project.id, name: 'web', sourceType: 'image', imageUrl: 'registry.example/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: pending.id, integrationId: integration.id, repositoryId: '101', branch: 'main' });
  const push = (deliveryId, overrides = {}) => signedWebhook(store, 'push', deliveryId, {
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    installation: { id: 900 },
    repository: { id: 101, full_name: 'alice/web', default_branch: 'main' },
    ...overrides,
  });

  assert.equal(push('exact-identity').actions.filter((action) => action.type === 'production-deployment-enqueued').length, 1);
  assert.equal(push('wrong-installation', { installation: { id: 901 } }).actions.length, 0);
  assert.equal(push('wrong-repository-id', { repository: { id: 999, full_name: 'alice/web', default_branch: 'main' } }).actions.length, 0);
  assert.equal(push('wrong-repository-name', { repository: { id: 101, full_name: 'mallory/web', default_branch: 'main' } }).actions.length, 0);
  assert.equal(push('feature-branch', { ref: 'refs/heads/feature/demo' }).actions.length, 0);

  const transferred = signedWebhook(store, 'repository', 'repository-transferred', {
    action: 'transferred',
    installation: { id: 900 },
    repository: { id: 101, full_name: 'alice/web', default_branch: 'main' },
    sender: { id: 500 },
  });
  assert.equal(transferred.actions.some((action) => action.type === 'github-repository-catalog-invalidated'), true);
  assert.equal(push('same-full-name-after-transfer').actions.length, 0);
});

test('Prisma GitHub webhook lookup fails closed when the authoritative repository catalog record is absent', async () => {
  const secret = 'prisma-webhook-boundary-secret';
  const payload = {
    ref: 'refs/heads/main',
    after: 'b'.repeat(40),
    installation: { id: 900 },
    repository: { id: 101, full_name: 'alice/web', default_branch: 'main' },
  };
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  let queriedServices = false;
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    webhookEvent: {
      findUnique: async () => null,
      create: async ({ data }) => ({ id: 'webhook-1', ...data }),
      update: async ({ data }) => ({ id: 'webhook-1', deliveryId: 'prisma-no-catalog', ...data }),
    },
    gitHubRepository: { findFirst: async () => null },
    service: { findMany: async () => { queriedServices = true; return []; } },
    auditLog: { upsert: async () => ({}) },
  };
  const repository = new PrismaControlPlaneRepository(prisma);
  const result = await repository.handleGitHubWebhook({ event: 'push', deliveryId: 'prisma-no-catalog', payload, body, signature, secret });
  assert.equal(result.matchedServiceCount, 0);
  assert.equal(queriedServices, false);
});

test('production Helm builder has no shared Git credential mount or token environment', async () => {
  const [builder, values, productionValues] = await Promise.all([
    fs.readFile(new URL('../infra/helm/raibitserver/templates/builder-deployment.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../infra/helm/raibitserver/values.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../infra/helm/raibitserver/ci-production-values.yaml', import.meta.url), 'utf8'),
  ]);
  for (const forbidden of ['GIT_ASKPASS', 'RAIBITSERVER_GIT_TOKEN_FILE', 'RAIBITSERVER_GIT_USERNAME_FILE', 'git-credentials']) {
    assert.equal(builder.includes(forbidden), false, `builder template must not contain shared Git credential marker ${forbidden}`);
  }
  assert.equal(/gitCredentials:/i.test(values), false);
  assert.equal(/gitCredentials:/i.test(productionValues), false);
  assert.match(values, /anonymousGit:\s*[\s\S]*enabled:\s*false/);
  assert.match(builder, /RAIBITSERVER_ALLOW_ANONYMOUS_GIT/);
});

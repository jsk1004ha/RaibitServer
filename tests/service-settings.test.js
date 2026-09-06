import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import YAML from 'yaml';
import { createApiHandler } from '../packages/core/src/api.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';
import { ServiceSettingsMutationSchema, ServiceSettingsSnapshotSchema } from '../packages/schemas/src/service-settings.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';

async function fixture() {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Settings', slug: 'settings' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', sourceType: 'github', branch: 'main' });
  return { repository, project, service };
}

test('Given a service snapshot, When settings are previewed twice, Then the build-plan diff is deterministic and does not write', async () => {
  // Given
  const { repository, service } = await fixture();
  const input = {
    expectedUpdatedAt: service.updatedAt,
    changes: { branch: 'release', dockerfilePath: 'deploy/Dockerfile', port: 8080 },
    files: { 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'deploy/Dockerfile': 'FROM node:24' },
  };

  // When
  const first = await repository.previewServiceSettings(service.id, input);
  const second = await repository.previewServiceSettings(service.id, input);

  // Then
  assert.deepEqual(first, second);
  assert.equal(first.buildPlan.after.mode, 'dockerfile');
  assert.deepEqual(first.diff.map((entry) => entry.field), ['branch', 'dockerfilePath', 'port']);
  assert.equal((await repository.getService(service.id)).branch, 'main');
  assert.equal(repository.store.auditLogs.filter((entry) => entry.action === 'service:update').length, 0);
});

test('Given current settings, When a conditional save is accepted, Then mutable fields persist once without a deployment job', async () => {
  // Given
  const { repository, service } = await fixture();
  const beforeJobs = repository.store.workflowJobs.length;

  // When
  const result = await repository.updateServiceSettings(service.id, {
    expectedUpdatedAt: service.updatedAt,
    changes: {
      name: 'API', type: 'private', sourceType: 'gitlab', repoUrl: 'https://gitlab.com/team/api.git', branch: 'release',
      rootDirectory: 'apps/api', buildContext: 'apps/api', dockerfilePath: 'Dockerfile', installCommand: 'pnpm install',
      buildCommand: 'pnpm build', startCommand: 'pnpm start', outputDirectory: 'dist', port: 8080,
      healthCheckPath: '/health', livenessPath: '/live', readinessPath: '/ready',
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
    },
  }, { actorUserId: 'maintainer' });

  // Then
  assert.equal(result.settings.name, 'API');
  assert.equal(result.settings.sourceType, 'gitlab');
  assert.equal(result.settings.resources.limits.memory, '512Mi');
  assert.equal(repository.store.workflowJobs.length, beforeJobs);
  assert.equal(repository.store.auditLogs.filter((entry) => entry.action === 'service:update').length, 1);
});

test('Given a stale snapshot, When a conditional save is attempted, Then no partial write occurs', async () => {
  // Given
  const { repository, service } = await fixture();
  const current = await repository.updateServiceSettings(service.id, { expectedUpdatedAt: service.updatedAt, changes: { branch: 'release' } });
  const auditCount = repository.store.auditLogs.length;

  // When / Then
  await assert.rejects(
    repository.updateServiceSettings(service.id, { expectedUpdatedAt: service.updatedAt, changes: { branch: 'stale', port: 9000 } }),
    (error) => error.code === 'STALE_SERVICE' && error.statusCode === 409,
  );
  assert.equal((await repository.getService(service.id)).branch, 'release');
  assert.equal((await repository.getService(service.id)).updatedAt, current.updatedAt);
  assert.equal(repository.store.auditLogs.length, auditCount);
});

test('Given a deployed service, When identity is patched or explicitly replaced, Then the old service and deployment snapshot remain immutable', async () => {
  // Given
  const { repository, project, service } = await fixture();
  const deployment = await repository.createDeployment({ serviceId: service.id, projectId: project.id, desiredSpecSnapshot: { branch: service.branch } });

  // When / Then
  for (const changes of [{ name: 'Renamed' }, { type: 'worker' }, { sourceType: 'image', image: 'example/api:v2' }]) {
    await assert.rejects(repository.updateServiceSettings(service.id, { expectedUpdatedAt: service.updatedAt, changes }), (error) => error.code === 'IMMUTABLE_SETTINGS');
  }
  const replacement = await repository.createServiceReplacement(service.id, {
    expectedUpdatedAt: service.updatedAt,
    confirmed: true,
    name: 'Web replacement',
    source: { sourceType: 'image', image: 'example/api:v2' },
  }, { actorUserId: 'maintainer' });
  assert.equal(replacement.impact, 'old_service_preserved');
  assert.equal(replacement.oldServiceId, service.id);
  assert.equal(replacement.service.sourceType, 'image');
  assert.equal((await repository.getService(service.id)).sourceType, 'github');
  assert.deepEqual(repository.store.getDeployment(deployment.id).desiredSpecSnapshot, { branch: 'main' });
});

test('Given the real in-memory HTTP API, When settings are previewed, saved, conflicted, and replaced, Then each typed outcome is observable', async () => {
  // Given
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'HTTP settings', slug: 'http-settings' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'Web', sourceType: 'github', branch: 'main' });
  controlPlane.store.createDeployment({ serviceId: service.id, projectId: project.id, desiredSpecSnapshot: { branch: 'main' } });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // When
    const snapshot = await request(server, 'GET', `/services/${service.id}/settings`);
    const preview = await request(server, 'POST', `/services/${service.id}/settings/preview`, { expectedUpdatedAt: snapshot.body.updatedAt, changes: { branch: 'release' } });
    const saved = await request(server, 'PATCH', `/services/${service.id}/settings`, { expectedUpdatedAt: snapshot.body.updatedAt, changes: { branch: 'release' } });
    const stale = await request(server, 'PATCH', `/services/${service.id}/settings`, { expectedUpdatedAt: snapshot.body.updatedAt, changes: { port: 9090 } });
    const replacement = await request(server, 'POST', `/services/${service.id}/replacements`, { expectedUpdatedAt: saved.body.updatedAt, confirmed: true, name: 'Web v2', source: { sourceType: 'image', image: 'example/web:v2' } });

    // Then
    assert.deepEqual([snapshot.statusCode, preview.statusCode, saved.statusCode, stale.statusCode, replacement.statusCode], [200, 200, 200, 409, 201]);
    assert.equal(preview.body.diff[0].field, 'branch');
    assert.equal(saved.body.settings.branch, 'release');
    assert.match(JSON.stringify(stale.body), /STALE_SERVICE/);
    assert.equal(replacement.body.impact, 'old_service_preserved');
    assert.equal(controlPlane.store.workflowJobs.length, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given public service settings contracts, When schemas and OpenAPI are inspected, Then secrets are excluded and checked-in paths match', async () => {
  // Given
  const artifact = YAML.parse(await readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  const generated = JSON.parse(JSON.stringify(createOpenApiDocument()));

  // When
  const rejectedEnvironment = ServiceSettingsMutationSchema.safeParse({
    expectedUpdatedAt: '2026-09-06T00:00:00.000Z', changes: { environment: { SECRET: 'value' } },
  });
  const safeSnapshot = ServiceSettingsSnapshotSchema.safeParse({
    serviceId: 'service', projectId: 'project', updatedAt: '2026-09-06T00:00:00.000Z', deployed: false, settings: { branch: 'main' },
  });

  // Then
  assert.equal(rejectedEnvironment.success, false);
  assert.equal(safeSnapshot.success, true);
  for (const path of ['/services/{serviceId}/settings', '/services/{serviceId}/settings/preview', '/services/{serviceId}/replacements']) {
    assert.deepEqual(artifact.paths[path], generated.paths[path]);
  }
});

test('Given maintainer and viewer sessions, When service settings are changed, Then the configured role permissions are enforced', async () => {
  // Given
  const secret = 'service-settings-role-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Roles', slug: 'roles' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'Web', branch: 'main' });
  const maintainerUser = controlPlane.store.createUser({ email: 'maintainer@example.test', approvalStatus: 'APPROVED' });
  const viewerUser = controlPlane.store.createUser({ email: 'viewer@example.test', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: maintainerUser.id, role: 'MAINTAINER' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: viewerUser.id, role: 'VIEWER' });
  const maintainer = signJwtHs256({ sub: maintainerUser.id, role: 'MAINTAINER', organizationId: organization.id, approvalStatus: 'APPROVED' }, secret);
  const viewer = signJwtHs256({ sub: viewerUser.id, role: 'VIEWER', organizationId: organization.id, approvalStatus: 'APPROVED' }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // When
    const denied = await request(server, 'PATCH', `/services/${service.id}/settings`, { expectedUpdatedAt: service.updatedAt, changes: { branch: 'viewer' } }, viewer);
    const allowed = await request(server, 'PATCH', `/services/${service.id}/settings`, { expectedUpdatedAt: service.updatedAt, changes: { branch: 'maintainer' } }, maintainer);

    // Then
    assert.equal(denied.statusCode, 403);
    assert.equal(allowed.statusCode, 200);
    assert.equal(controlPlane.store.getService(service.id).branch, 'maintainer');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given the real Nest API with memory persistence, When settings are read and updated, Then controller metadata reaches the repository', async () => {
  // Given
  const runtime = await bootParityApi();
  const user = runtime.repository.store.createUser({ email: 'nest-settings@example.test', approvalStatus: 'APPROVED' });
  const organization = runtime.repository.store.createOrganization({ name: 'Nest settings', slug: 'nest-settings' });
  runtime.repository.store.addMember({ userId: user.id, organizationId: organization.id, role: 'MAINTAINER' });
  const project = runtime.repository.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = runtime.repository.store.createService({ projectId: project.id, name: 'Web', branch: 'main' });
  const token = signJwtHs256({ sub: user.id, role: 'MAINTAINER', organizationId: organization.id, approvalStatus: 'APPROVED' }, 'local-semantic-parity-test-secret-only');

  try {
    // When
    const snapshot = await requestUrl(runtime.baseUrl, 'GET', `/services/${service.id}/settings`, undefined, token);
    const updated = await requestUrl(runtime.baseUrl, 'PATCH', `/services/${service.id}/settings`, { expectedUpdatedAt: snapshot.body.updatedAt, changes: { branch: 'nest-release' } }, token);

    // Then
    assert.equal(snapshot.statusCode, 200);
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.settings.branch, 'nest-release');
    assert.equal(runtime.routes.some((route) => route.path === '/services/{serviceId}/settings' && route.method === 'patch' && route.permission === 'service:update'), true);
  } finally {
    await runtime.app.close();
  }
});

function request(server, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const address = server.address();
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestUrl(baseUrl, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const target = new URL(path, baseUrl);
    const req = http.request(target, { method, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { createSessionToken } from '../packages/core/src/identity.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

test('deployment history returns immutable recovery metadata over actual HTTP', async (t) => {
  // Given a failed deployment with an immutable source snapshot.
  const runtime = await historyRuntime(t);
  const digest = `sha256:${'a'.repeat(64)}`;
  await runtime.repository.createDeployment({
    id: 'history-failed', serviceId: runtime.service.id, projectId: runtime.project.id,
    status: 'BUILD_FAILED', deploymentType: 'production', triggerType: 'push',
    commitSha: 'b'.repeat(40), imageUrl: `registry.example/team/app@${digest}`, imageDigest: digest,
    requestedByUserId: runtime.user.id, snapshotVersion: 1,
  });

  // When deployment history is requested through its tenant API.
  const response = await fetch(`${runtime.baseUrl}/projects/${runtime.project.id}/deployments/history?status=BUILD_FAILED`, {
    headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(10_000),
  });

  // Then the server exposes the immutable source and one current eligible action.
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deployments[0].source.commitSha, 'b'.repeat(40));
  assert.equal(body.deployments[0].source.imageDigest, digest);
  assert.equal(body.deployments[0].source.snapshotVersion, 1);
  assert.equal(body.deployments[0].operation.requestedByUserId, runtime.user.id);
  assert.equal(body.deployments[0].health.rolloutStatus, 'BUILD_FAILED');
  assert.equal(body.deployments[0].health.publicHealthStatus, 'UNKNOWN');
  assert.equal(body.deployments[0].eligibleAction.type, 'retry');
  assert.equal(body.deployments[0].recovery.retryable, true);
  assert.equal(body.deployments[0].permissions.execute, true);
});

test('deployment retry preserves immutable history and returns stream continuity', async (t) => {
  // Given an immutable failed deployment advertised for retry.
  const runtime = await historyRuntime(t);
  const digest = `sha256:${'a'.repeat(64)}`;
  await runtime.repository.createDeployment({
    id: 'history-failed', serviceId: runtime.service.id, projectId: runtime.project.id,
    status: 'BUILD_FAILED', deploymentType: 'production', triggerType: 'push',
    commitSha: 'b'.repeat(40), imageUrl: `registry.example/team/app@${digest}`, imageDigest: digest,
    requestedByUserId: runtime.user.id, snapshotVersion: 1,
  });

  // When the existing retry contract is submitted once.
  const [retry, replay] = await Promise.all([
    post(runtime, `/deployments/history-failed/retry`, { requestIdempotencyKey: 'history-retry', snapshotVersion: 1 }),
    post(runtime, `/deployments/history-failed/retry`, { requestIdempotencyKey: 'history-retry', snapshotVersion: 1 }),
  ]);

  // Then the successor and stream are returned while the historical source stays unchanged.
  assert.equal(retry.status, 202);
  assert.notEqual(retry.body.deployment.id, 'history-failed');
  assert.equal(replay.body.deployment.id, retry.body.deployment.id);
  assert.equal(retry.body.deployment.sourceDeploymentId, 'history-failed');
  assert.equal(retry.body.streamHref, `/deployments/${retry.body.deployment.id}/stream`);
  const source = runtime.repository.store.deployments.get('history-failed');
  assert.equal(source.commitSha, 'b'.repeat(40));
  assert.equal(source.imageDigest, digest);
});

test('deployment history filters and scoped cursor are stable and tamper-evident', async (t) => {
  // Given same-timestamp deployment rows plus out-of-filter and foreign-tenant rows.
  const runtime = await historyRuntime(t);
  const createdAt = '2026-09-05T12:00:00.000Z';
  for (const id of ['history-c', 'history-b', 'history-a']) await runtime.repository.createDeployment({
    id, serviceId: runtime.service.id, projectId: runtime.project.id, status: 'READY', deploymentType: 'production', triggerType: 'push', createdAt, updatedAt: createdAt,
  });
  await runtime.repository.createDeployment({ id: 'history-preview', serviceId: runtime.service.id, projectId: runtime.project.id, status: 'READY', deploymentType: 'preview', triggerType: 'webhook', createdAt, updatedAt: createdAt });
  await runtime.repository.createDeployment({ id: 'history-foreign', serviceId: runtime.foreignService.id, projectId: runtime.foreignProject.id, status: 'READY', deploymentType: 'production', triggerType: 'push', createdAt, updatedAt: createdAt });

  // When two filtered cursor pages are requested.
  const query = `serviceId=${runtime.service.id}&environment=production&status=READY&trigger=push&from=2026-09-05T00%3A00%3A00.000Z&to=2026-09-06T00%3A00%3A00.000Z&limit=2`;
  const first = await get(runtime, `/projects/${runtime.project.id}/deployments/history?${query}`);
  const second = await get(runtime, `/projects/${runtime.project.id}/deployments/history?${query}&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);

  // Then keyset id tie-breaking has no gaps, duplicates, or foreign/filter leakage.
  assert.deepEqual(first.body.deployments.map((row) => row.id), ['history-c', 'history-b']);
  assert.deepEqual(second.body.deployments.map((row) => row.id), ['history-a']);
  assert.equal(second.body.page.nextCursor, null);
  assert.equal(JSON.stringify([first.body, second.body]).includes('history-foreign'), false);
  assert.equal(JSON.stringify([first.body, second.body]).includes('history-preview'), false);

  // When the cursor bytes, filter binding, or tenant scope are changed.
  const cursor = first.body.page.nextCursor;
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
  const [badBytes, badFilter, foreignCursor, forbidden] = await Promise.all([
    get(runtime, `/projects/${runtime.project.id}/deployments/history?${query}&cursor=${tampered}`),
    get(runtime, `/projects/${runtime.project.id}/deployments/history?limit=2&cursor=${encodeURIComponent(cursor)}`),
    get(runtime, `/projects/${runtime.foreignProject.id}/deployments/history?${query}&cursor=${encodeURIComponent(cursor)}`, runtime.foreignToken),
    get(runtime, `/projects/${runtime.project.id}/deployments/history`, runtime.foreignToken),
  ]);

  // Then all forged scopes fail without returning history rows.
  assert.equal(badBytes.status, 400);
  assert.equal(badFilter.status, 400);
  assert.equal(foreignCursor.status, 400);
  assert.equal(forbidden.status, 403);
});

test('deployment detail uses server-current action and permission metadata', async (t) => {
  // Given a cancellable deployment visible to both an owner and viewer.
  const runtime = await historyRuntime(t);
  await runtime.repository.createDeployment({ id: 'history-queued', serviceId: runtime.service.id, projectId: runtime.project.id, status: 'queued', requestedByUserId: runtime.user.id });

  // When both roles load the same detail and history resources.
  const [ownerDetail, viewerDetail, viewerHistory] = await Promise.all([
    get(runtime, '/deployments/history-queued'), get(runtime, '/deployments/history-queued', runtime.viewerToken),
    get(runtime, `/projects/${runtime.project.id}/deployments/history`, runtime.viewerToken),
  ]);

  // Then only the authorized actor receives the single cancel action from current state.
  assert.equal(ownerDetail.body.eligibleAction.type, 'cancel');
  assert.equal(ownerDetail.body.eligibleAction.confirmationRequired, true);
  assert.equal(viewerDetail.body.permissions.execute, false);
  assert.equal(viewerDetail.body.eligibleAction, null);
  assert.ok(viewerHistory.body.deployments.every((row) => row.permissions.execute === false && row.eligibleAction === null));
});

test('deployment history exposes one eligible action for each recoverable state', async (t) => {
  // Given independent services in failed, queued, rollback-ready, and redeploy-ready states.
  const runtime = await historyRuntime(t);
  const digest = `sha256:${'e'.repeat(64)}`;
  const services = {};
  for (const name of ['retry', 'cancel', 'rollback', 'redeploy']) services[name] = await runtime.repository.createService({ projectId: runtime.project.id, name, slug: name, type: 'web', sourceType: 'image', image: 'example/app:v1' });
  await runtime.repository.createDeployment({ id: 'action-retry', serviceId: services.retry.id, projectId: runtime.project.id, status: 'FAILED', imageUrl: `example/app@${digest}`, imageDigest: digest });
  await runtime.repository.createDeployment({ id: 'action-cancel', serviceId: services.cancel.id, projectId: runtime.project.id, status: 'queued' });
  await runtime.repository.createDeployment({ id: 'action-rollback-old', serviceId: services.rollback.id, projectId: runtime.project.id, status: 'READY', imageUrl: `example/app@${digest}`, imageDigest: digest, createdAt: '2026-09-04T00:00:00.000Z' });
  await runtime.repository.createDeployment({ id: 'action-rollback', serviceId: services.rollback.id, projectId: runtime.project.id, status: 'READY', imageUrl: `example/app@${digest}`, imageDigest: digest, createdAt: '2026-09-05T00:00:00.000Z' });
  await runtime.repository.createDeployment({ id: 'action-redeploy', serviceId: services.redeploy.id, projectId: runtime.project.id, status: 'READY', imageUrl: `example/app@${digest}`, imageDigest: digest });

  // When current action metadata is loaded once from the server.
  const response = await get(runtime, `/projects/${runtime.project.id}/deployments/history?limit=20`);

  // Then every target row has exactly its single safe existing operation.
  const actions = Object.fromEntries(response.body.deployments.map((row) => [row.id, row.eligibleAction?.type ?? null]));
  assert.deepEqual({ retry: actions['action-retry'], cancel: actions['action-cancel'], rollback: actions['action-rollback'], redeploy: actions['action-redeploy'] }, { retry: 'retry', cancel: 'cancel', rollback: 'rollback', redeploy: 'redeploy' });
});

test('typed deployment history client drives the actual HTTP contract', async (t) => {
  // Given the public SDK and a production deployment.
  const runtime = await historyRuntime(t);
  const { RAIBITSERVERClient } = await import('../packages/api-client/src/index.ts');
  const digest = `sha256:${'c'.repeat(64)}`;
  await runtime.repository.createDeployment({ id: 'history-sdk', serviceId: runtime.service.id, projectId: runtime.project.id, status: 'READY', deploymentType: 'production', triggerType: 'manual', imageUrl: `example/app@${digest}`, imageDigest: digest });
  const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: runtime.token });

  // When typed URL filters are sent through the generated operation binding.
  const history = await client.listDeploymentHistory(runtime.project.id, { serviceId: runtime.service.id, environment: 'production', status: 'READY', trigger: 'manual', limit: 1 });

  // Then the SDK parses the stable page, filter, and recovery metadata.
  assert.equal(history.deployments[0].id, 'history-sdk');
  assert.equal(history.filters.environment, 'production');
  assert.equal(history.page.limit, 1);
  assert.equal(history.deployments[0].eligibleAction.type, 'redeploy');
});

test('Prisma deployment history keeps tenant filters and actions set-based', async () => {
  // Given a typed Prisma boundary with one filtered row and one set-based action query.
  const calls = [];
  const createdAt = new Date('2026-09-05T12:00:00.000Z');
  const service = { id: 'service-db', name: 'Database API', slug: 'database-api' };
  const deployment = {
    id: 'history-db', serviceId: service.id, projectId: 'project-db', status: 'READY', deploymentType: 'production', triggerType: 'push',
    commitSha: 'd'.repeat(40), commitHash: 'd'.repeat(40), imageUrl: null, imageDigest: null, snapshotVersion: 1,
    desiredSpecSnapshot: { sourceType: 'git', repoUrl: 'club/app' }, createdAt, updatedAt: createdAt, service,
  };
  const prisma = {
    project: { findFirst: async (query) => { calls.push(['project', query]); return { id: 'project-db' }; } },
    deployment: { findMany: async (query) => { calls.push(['deployment', query]); return query.include ? [deployment] : [deployment]; } },
  };
  const repository = new PrismaControlPlaneRepository(prisma);

  // When a fully filtered page is read.
  const page = await repository.listDeploymentHistory({
    organizationId: 'organization-db', projectId: 'project-db', cursorSecret: 'cursor-secret', execute: true,
    query: { serviceId: service.id, environment: 'production', status: 'READY', trigger: 'push', from: '2026-09-05T00:00:00.000Z', to: '2026-09-06T00:00:00.000Z', limit: 25 },
  });

  // Then tenant scope, SQL filters, stable ordering, and bounded query count are explicit.
  assert.deepEqual(calls[0][1].where, { id: 'project-db', organizationId: 'organization-db' });
  assert.equal(calls[1][1].where.projectId, 'project-db');
  assert.equal(calls[1][1].where.serviceId, service.id);
  assert.deepEqual(calls[1][1].orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(calls[1][1].take, 26);
  assert.equal(calls.filter(([model]) => model === 'deployment').length, 2);
  assert.equal(page.deployments[0].source.commitSha, 'd'.repeat(40));
});

test('Nest deployment history route serves the typed project scope', async (t) => {
  // Given the actual Nest application and its in-memory repository.
  const { bootLineageApi } = await import('./fixtures/deployment-retry-runtime.mjs');
  const runtime = await bootLineageApi(t, 'nest');
  await runtime.repository.createDeployment({ id: 'history-nest', serviceId: runtime.service.id, projectId: runtime.project.id, status: 'BUILD_FAILED', triggerType: 'push' });

  // When the additive project history route is requested.
  const response = await fetch(`${runtime.baseUrl}/projects/${runtime.project.id}/deployments/history?status=BUILD_FAILED`, {
    headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(10_000),
  });

  // Then the independently registered Nest route returns the scoped row.
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deployments[0].id, 'history-nest');
});

async function historyRuntime(t) {
  const jwtSecret = 'deployment-history-local-test-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const repository = new InMemoryControlPlaneRepository(controlPlane.store);
  const organization = await repository.createOrganization({ name: 'History', slug: 'history' });
  const user = await repository.createUser({ email: 'history@example.test', approvalStatus: 'APPROVED' });
  const membership = await repository.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  const viewer = await repository.createUser({ email: 'history-viewer@example.test', approvalStatus: 'APPROVED' });
  const viewerMembership = await repository.addMember({ organizationId: organization.id, userId: viewer.id, role: 'VIEWER' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'History', slug: 'history' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', slug: 'web', type: 'web', sourceType: 'image', image: 'example/app:v1' });
  const foreignOrganization = await repository.createOrganization({ name: 'Foreign', slug: 'foreign' });
  const foreignUser = await repository.createUser({ email: 'history-foreign@example.test', approvalStatus: 'APPROVED' });
  const foreignMembership = await repository.addMember({ organizationId: foreignOrganization.id, userId: foreignUser.id, role: 'OWNER' });
  const foreignProject = await repository.createProject({ organizationId: foreignOrganization.id, name: 'Foreign', slug: 'foreign' });
  const foreignService = await repository.createService({ projectId: foreignProject.id, name: 'Foreign', slug: 'foreign', type: 'web', sourceType: 'image', image: 'example/foreign:v1' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret, issuer: 'raibitserver' } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return {
    repository, project, service, user, foreignProject, foreignService,
    token: createSessionToken(user, [membership], jwtSecret),
    viewerToken: createSessionToken(viewer, [viewerMembership], jwtSecret),
    foreignToken: createSessionToken(foreignUser, [foreignMembership], jwtSecret),
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function get(runtime, path, token = runtime.token) {
  const response = await fetch(`${runtime.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

async function post(runtime, path, body) {
  const response = await fetch(`${runtime.baseUrl}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

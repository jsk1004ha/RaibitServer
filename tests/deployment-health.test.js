import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { sanitizeTenantServiceInput } from '../packages/core/src/security.ts';
import { parseServiceMutation } from '../packages/core/src/desired-state-mutations.ts';
import { claimNextWorkflowJobFromList, createWorkflowJobRecord } from '../packages/core/src/workflows.ts';
import { bootLineageApi } from './fixtures/deployment-retry-runtime.mjs';
import { ServiceCreateSchema, ServiceUpdateSchema } from '../packages/schemas/src/index.ts';
import { ServiceInput, Deployment } from '../packages/schemas/src/api-models.ts';
import { serviceHealthProbes } from '../packages/core/src/deployment-health.ts';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';

const paths = { healthCheckPath: '/common', readinessPath: '/ready', livenessPath: '/live', publicHealthPath: '/public' };
const invalidPaths = ['//host', '/a b', '/a\\b', '/a?b', '/a#b', '/%', '/%xx', '/%2f', '/%5c', '/%00', '/%7f', '/%3f', '/%23', '/%25', '/%2e%2e/x', '/./x', '/../x', '/%c2%80', '/\u0080', '/\ud800', `/${'한'.repeat(342)}`];

test('health path create and mutation boundaries reject unsafe encodings without normalization', () => {
  // Given: unsafe raw paths that must not be silently normalized or discarded.
  for (const field of Object.keys(paths)) for (const path of invalidPaths) {
    // When / Then: both public boundaries reject each invalid input.
    assert.throws(() => sanitizeTenantServiceInput({ type: 'web', [field]: path }), { statusCode: 400 }, `${field}:${path}`);
    assert.throws(() => parseServiceMutation({ [field]: path }), { statusCode: 400 });
  }
});

test('health paths persist aliases and explicit clears without stale snapshot fallback', async () => {
  // Given: a service with compatibility alias and distinct probe paths.
  const repository = new InMemoryControlPlaneRepository();
  const service = await repository.createService({ projectId: 'p', name: 'web', type: 'web', sourceType: 'image', image: 'example/app:v1', ...paths, healthCheck: { path: '/common' } });
  // When: clear the common path and preserve other omitted paths.
  const updated = await repository.updateService(service.id, { healthCheckPath: null });
  // Then: explicit clear removes compatibility fallback in every captured representation.
  assert.equal(updated.healthCheckPath, null);
  assert.equal(updated.healthCheck, null);
  assert.equal(updated.readinessPath, '/ready');
  const deployment = await repository.createDeployment({ serviceId: service.id, status: 'FAILED' });
  assert.equal(deployment.desiredSpecSnapshot.healthCheckPath, null);
  assert.equal(deployment.desiredSpecSnapshot.healthCheck, null);
  assert.equal(deployment.publicHealthStatus, 'UNKNOWN');
  assert.equal(deployment.observedGeneration, null);
});

test('generic list claim leaves Go-owned health observations untouched', () => {
  // Given: health work precedes ordinary build work in the queue.
  const health = createWorkflowJobRecord({ id: 'health', type: 'public-health-observe', targetId: 'd', runAfter: '2020-01-01' });
  const build = createWorkflowJobRecord({ id: 'build', targetId: 'd', runAfter: '2020-01-02' });
  const jobs = [health, build];
  // When: the generic TS consumer claims work.
  const claimed = claimNextWorkflowJobFromList(jobs);
  // Then: only ordinary work is claimed, health remains byte-identical.
  assert.equal(claimed.id, 'build');
  assert.deepEqual(jobs[0], health);
});

for (const transport of ['core', 'nest']) test(`health paths and independent observations over ${transport} HTTP`, async t => {
  // Given: an actual authenticated API adapter and a scoped web service.
  const runtime = await bootLineageApi(t, transport);
  runtime.repository.store.setQuota({ userId: runtime.user.id, maxServices: 10 });
  const request = async (method, path, body) => {
    const response = await fetch(`${runtime.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  // When: public create / patch / read traverse the real routes.
  const created = await request('POST', `/projects/${runtime.project.id}/services`, { name: 'health-web', type: 'web', sourceType: 'image', image: 'example/app:v1', ...paths });
  assert.equal(created.status, 201);
  for (const [key, value] of Object.entries(paths)) assert.equal(created.body[key], value);
  const patched = await request('PATCH', `/services/${created.body.id}`, { healthCheckPath: null });
  assert.equal(patched.status, 200);
  const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: runtime.token });
  const read = { body: await client.getService(created.body.id) };
  assert.equal(read.body.healthCheckPath, null);
  assert.equal(read.body.healthCheck, null);
  assert.equal(read.body.publicHealthPath, '/public');
  // Then: client writes cannot forge runtime observation and unsafe settings fail closed.
  assert.equal((await request('PATCH', `/services/${created.body.id}`, { publicHealthPath: '/%2f' })).status, 400);
  assert.equal((await request('POST', `/projects/${runtime.project.id}/services`, { name: 'worker', type: 'worker', publicHealthPath: '/health' })).status, 400);
  const source = await runtime.repository.createDeployment({ id: 'health-source', serviceId: created.body.id, status: 'FAILED', imageUrl: `example/app@sha256:${'a'.repeat(64)}`, publicHealthStatus: 'HEALTHY', observedGeneration: 99 });
  assert.equal(source.publicHealthStatus, 'UNKNOWN');
  assert.equal(source.observedGeneration, null);
  const old = runtime.repository.store.deployments.get(source.id);
  Object.assign(old, { publicHealthStatus: 'DEGRADED', healthFailureCode: 'PUBLIC_HEALTH_TIMEOUT', healthCheckedAt: '2026-01-01T00:00:00.000Z', observedGeneration: 2 });
  const retry = await runtime.post(`/deployments/${source.id}/retry`, { requestIdempotencyKey: 'health-retry', snapshotVersion: 1 });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.deployment.publicHealthStatus, 'UNKNOWN');
  assert.equal(retry.body.deployment.healthCheckedAt, null);
  assert.equal(retry.body.deployment.desiredSpecSnapshot.publicHealthPath, '/public');
  assert.equal(Deployment.safeParse(retry.body.deployment).success, true);
  const observed = await client.getDeployment(source.id);
  assert.equal(observed.status, 'FAILED');
  assert.equal(observed.publicHealthStatus, 'DEGRADED');
  assert.equal(observed.observedGeneration, 2);
  old.publicHealthStatus = null;
  assert.equal((await client.listDeployments(created.body.id)).deployments.find(row => row.id === source.id).publicHealthStatus, 'UNKNOWN');
  t.diagnostic(JSON.stringify({ transport, create: 201, patch: 200, unsafe: 400, successorHealth: 'UNKNOWN', observedGeneration: null }));
});

test('health alias/null and schema boundary parity rejects conflicts and non-web public paths', () => {
  // Given: shared public create/update schemas and the builtin parser.
  const invalid = [{ healthCheckPath: '/a', healthCheck: { path: '/b' } }, { publicHealthPath: 9 }, { type: 'worker', publicHealthPath: '/p' }, { desiredSpec: { publicHealthPath: '/%2f' } }];
  // When / Then: none of the boundaries silently accepts invalid path values.
  for (const input of invalid) {
    assert.throws(() => sanitizeTenantServiceInput(input), { statusCode: 400 });
    assert.equal(ServiceInput.safeParse({ name: 'web', ...input }).success, false);
    assert.equal(ServiceCreateSchema.safeParse({ name: 'web', ...input }).success, false);
    assert.equal(ServiceUpdateSchema.safeParse(input).success, false);
  }
  for (const input of [{ healthCheck: { path: '/alias' } }, { healthCheckPath: null, healthCheck: { path: '/old' } }, { ...paths }, { readinessPath: null }]) {
    assert.equal(ServiceCreateSchema.safeParse({ name: 'web', ...input }).success, true);
    assert.equal(ServiceUpdateSchema.safeParse(input).success, true);
  }
});

test('web probe precedence and TCP fallback leave non-web contracts without new HTTP probes', () => {
  // Given / When: distinct paths resolve independently at the manifest seam.
  const probes = serviceHealthProbes({ type: 'web', ...paths }, 3000);
  // Then: common startup, dedicated readiness/liveness and bounded fallback are explicit.
  assert.equal(probes.startupProbe.httpGet.path, '/common');
  assert.equal(probes.readinessProbe.httpGet.path, '/ready');
  assert.equal(probes.livenessProbe.httpGet.path, '/live');
  assert.equal(serviceHealthProbes({ type: 'web', readinessPath: '/r' }, 3000).startupProbe.httpGet.path, '/r');
  assert.deepEqual(serviceHealthProbes({ type: 'web' }, 3000).livenessProbe.tcpSocket, { port: 3000 });
  for (const type of ['private', 'worker', 'cron', 'job']) assert.deepEqual(serviceHealthProbes({ type, healthCheckPath: '/ignored' }, 3000), {});
});

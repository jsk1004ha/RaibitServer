import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { bootLineageApi } from './fixtures/deployment-retry-runtime.mjs';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { apiOperations, createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';
import { deploymentSuccessor, parseDeploymentOperationBody } from '../packages/core/src/deployment-operations.ts';

async function fixture() {
  const repository = new InMemoryControlPlaneRepository();
  const org = await repository.createOrganization({ name: 'Lineage', slug: 'lineage' });
  const project = await repository.createProject({ organizationId: org.id, name: 'App', slug: 'app' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', type: 'web', sourceType: 'image', image: 'example/app:v1', desiredSpec: { image: 'example/app:v1', port: 3000 } });
  const source = await repository.createDeployment({ id: 'source', serviceId: service.id, projectId: project.id, commitSha: 'a'.repeat(40), imageUrl: 'example/app:v1', status: 'FAILED' });
  return { repository, service, source };
}

test('retry and redeploy immutable lineage', async () => {
  // Given: a failed deployment captured before the service changes.
  const { repository, service, source } = await fixture();
  const before = JSON.stringify(repository.store.getDeployment(source.id));
  const events = JSON.stringify(repository.store.listDeploymentEvents(source.id));
  repository.store.services.get(service.id).desiredSpec = { image: 'mutated:v9', port: 9999 };
  const input = { operation: 'retry', serviceId: service.id, sourceDeploymentId: source.id, requestedByUserId: 'system', requestIdempotencyKey: 'same-key', snapshotVersion: 1 };
  // When: identical requests race against the same immutable source.
  assert.equal(typeof repository.createDeploymentOperation, 'function');
  const results = await Promise.all(Array.from({ length: 20 }, () => repository.createDeploymentOperation(input)));
  // Then: one new queued successor and job, stable replay and untouched source.
  assert.equal(new Set(results.map(result => result.deployment.id)).size, 1);
  assert.equal(new Set(results.map(result => result.workflowJob.id)).size, 1);
  assert.equal(repository.store.deployments.size, 2);
  assert.equal(repository.store.workflowJobs.length, 1);
  assert.equal(JSON.stringify(repository.store.getDeployment(source.id)), before);
  assert.equal(JSON.stringify(repository.store.listDeploymentEvents(source.id)), events);
  assert.equal(results[0].deployment.status, 'queued');
  assert.equal(results[0].deployment.retryOfDeploymentId, source.id);
  assert.equal(results[0].deployment.commitSha, 'a'.repeat(40));
  assert.equal(results[0].deployment.desiredSpecSnapshot.port, 3000);
  assert.deepEqual(results[0].workflowJob.payload.desiredSpecSnapshot, results[0].deployment.desiredSpecSnapshot);
});

test('deployment retry adversarial matrix', async () => {
  // Given: failed and disallowed sources in an isolated repository.
  const { repository, service, source } = await fixture();
  const input = { operation: 'retry', serviceId: service.id, sourceDeploymentId: source.id, requestedByUserId: 'system', requestIdempotencyKey: 'key', snapshotVersion: 1 };
  assert.equal(typeof repository.createDeploymentOperation, 'function');
  // When / Then: scope, version and state mismatches have typed errors and no writes.
  for (const [drift, code] of [[{ serviceId: 'foreign' }, 'DEPLOYMENT_SOURCE_NOT_FOUND'], [{ snapshotVersion: 2 }, 'STALE_SNAPSHOT']]) {
    await assert.rejects(repository.createDeploymentOperation({ ...input, ...drift }), error => error.code === code);
  }
  for (const status of ['QUEUED', 'BUILDING', 'READY', 'CANCELLED', 'CLEANED_UP']) {
    repository.store.deployments.get(source.id).status = status;
    await assert.rejects(repository.createDeploymentOperation(input), error => error.statusCode === 409);
  }
  repository.store.deployments.get(source.id).status = 'FAILED';
  const enqueue = repository.store.enqueueWorkflowJob;
  repository.store.enqueueWorkflowJob = () => { throw new Error('injected job persistence failure'); };
  await assert.rejects(repository.createDeploymentOperation(input), /injected job persistence failure/);
  repository.store.enqueueWorkflowJob = enqueue;
  assert.equal(repository.store.deployments.size, 1);
  assert.equal(repository.store.workflowJobs.length, 0);
  await repository.createDeploymentOperation(input);
  await assert.rejects(repository.createDeploymentOperation({ ...input, snapshotVersion: 2 }), error => error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409);
});

for (const transport of ['core', 'nest']) {
  test(`retry and redeploy immutable lineage over ${transport} HTTP`, async t => {
    // Given: a captured failed source and a later mutable service configuration.
    const runtime = await bootLineageApi(t, transport);
    const { repository, service, project } = runtime;
    const source = await repository.createDeployment({ id: 'http-source', serviceId: service.id, projectId: project.id, status: 'FAILED', commitSha: 'b'.repeat(40), imageUrl: 'example/app:v1' });
    const before = JSON.stringify(repository.store.getDeployment(source.id));
    const events = JSON.stringify(repository.store.listDeploymentEvents(source.id));
    repository.store.services.get(service.id).port = 9999;
    const client = new RAIBITSERVERClient({ baseUrl: runtime.baseUrl, token: runtime.token });
    const request = { path: { deploymentId: source.id }, query: {}, body: { requestIdempotencyKey: 'http-key', snapshotVersion: 1 } };
    // When: the typed client sends a retry and its exact replay over real HTTP.
    const first = await client.operations['deployments-retry'](request);
    const replay = await client.operations['deployments-retry'](request);
    // Then: bound config and source bytes/events remain immutable across both adapters.
    assert.deepEqual(replay, first);
    assert.equal(first.deployment.desiredSpecSnapshot.port, 3000);
    assert.equal(first.deployment.requestedByUserId, runtime.user.id);
    assert.equal(JSON.stringify(repository.store.getDeployment(source.id)), before);
    assert.equal(JSON.stringify(repository.store.listDeploymentEvents(source.id)), events);
    assert.equal(apiOperations['deployments-retry'].response.safeParse(first).success, true);
    t.diagnostic(JSON.stringify({ transport, scenario: 'retry', status: 202, successors: 1, jobs: 1, replay: true, originalBytesUnchanged: true }));
  });

  test(`retry and redeploy immutable lineage latest eligible redeploy over ${transport} HTTP`, async t => {
    // Given: a terminal source; current service config differs from the capture.
    const runtime = await bootLineageApi(t, transport);
    const { repository, service, project } = runtime;
    const first = await repository.createDeployment({ id: 'old-ready', serviceId: service.id, projectId: project.id, status: 'READY', imageUrl: 'example/app:old' });
    repository.store.deployments.get(first.id).createdAt = '2020-01-01T00:00:00.000Z';
    const latest = await repository.createDeployment({ id: 'latest-ready', serviceId: service.id, projectId: project.id, status: 'READY', imageUrl: 'example/app:latest', imageDigest: `sha256:${'c'.repeat(64)}` });
    // When: redeploy resolves the latest eligible snapshot once.
    const result = await runtime.post(`/services/${service.id}/redeploy`, { requestIdempotencyKey: 'redeploy-key', snapshotVersion: 1 });
    // Then: a fresh queued deployment uses that image; replay remains bound after a newer source appears.
    assert.equal(result.status, 202);
    assert.equal(result.body.deployment.sourceDeploymentId, latest.id);
    assert.equal(result.body.deployment.retryOfDeploymentId, null);
    assert.equal(result.body.deployment.imageDigest, `sha256:${'c'.repeat(64)}`);
    await repository.createDeployment({ id: 'later-ready', serviceId: service.id, projectId: project.id, status: 'READY', imageUrl: 'example/app:later' });
    const replay = await runtime.post(`/services/${service.id}/redeploy`, { requestIdempotencyKey: 'redeploy-key', snapshotVersion: 1 });
    assert.deepEqual(replay, result);
    assert.equal(apiOperations['services-redeploy'].response.safeParse(result.body).success, true);
  });

  test(`deployment retry adversarial matrix over ${transport} HTTP`, async t => {
    // Given: scoped actors and a failed source on the actual HTTP adapter.
    const runtime = await bootLineageApi(t, transport);
    const { repository, service, project } = runtime;
    const source = await repository.createDeployment({ id: 'adversarial', serviceId: service.id, projectId: project.id, status: 'BUILD_FAILED', imageUrl: `example/app@sha256:${'c'.repeat(64)}`, imageDigest: `sha256:${'c'.repeat(64)}` });
    const path = `/deployments/${source.id}/retry`;
    const body = { requestIdempotencyKey: 'matrix-key', snapshotVersion: 1 };
    // When / Then: each untrusted request fails with no successor/job.
    for (const [target, input, token, status, code] of [
      [path, body, runtime.outsideToken, 404, 'DEPLOYMENT_SOURCE_NOT_FOUND'],
      [path, body, runtime.readerToken, 403, null],
      ['/deployments/missing/retry', body, runtime.token, 404, 'DEPLOYMENT_SOURCE_NOT_FOUND'],
      [path, { ...body, snapshotVersion: 2 }, runtime.token, 409, 'STALE_SNAPSHOT'],
      [path, { ...body, desiredSpecSnapshot: {} }, runtime.token, 400, 'INVALID_DEPLOYMENT_OPERATION'],
      [path, { ...body, requestIdempotencyKey: '' }, runtime.token, 400, 'INVALID_DEPLOYMENT_OPERATION'],
    ]) {
      const result = await runtime.post(target, input, token);
      assert.equal(result.status, status, JSON.stringify(result));
      if (code) assert.equal(result.body.code, code);
    }
    for (const status of ['QUEUED', 'BUILDING', 'IMAGE_READY', 'DEPLOYING', 'READY', 'CANCELLED', 'CLEANED_UP']) {
      repository.store.deployments.get(source.id).status = status;
      assert.equal((await runtime.post(path, body)).status, 409);
    }
    repository.store.deployments.get(source.id).status = 'BUILD_FAILED';
    repository.store.deployments.get(source.id).desiredSpecSnapshot = null;
    assert.equal((await runtime.post(path, body)).body.code, 'SNAPSHOT_UNAVAILABLE');
    repository.store.deployments.get(source.id).desiredSpecSnapshot = source.desiredSpecSnapshot;
    assert.equal(repository.store.deployments.size, 1);
    assert.equal(repository.store.workflowJobs.length, 0);
    await runtime.post(path, body);
    const conflict = await runtime.post(path, { ...body, snapshotVersion: 2 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await runtime.post(path, body, runtime.outsideToken)).status, 404, 'authorization precedes replay');
    assert.equal(repository.store.deployments.size, 2);
    assert.equal(repository.store.workflowJobs.length, 1);
    t.diagnostic(JSON.stringify({ transport, scenario: 'adversarial', typedScopeVersionKey: true, unauthorizedReplay: false, orphanJobs: 0 }));
  });
}

test('deployment retry request parsers and generated HTTP contract agree', () => {
  // Given / When: public schema and builtin core parser see identical boundary inputs.
  const values = [{ requestIdempotencyKey: 'key', snapshotVersion: 1 }, {}, null, { requestIdempotencyKey: 'x', snapshotVersion: 0 }, { requestIdempotencyKey: 'x', snapshotVersion: 1, commitSha: 'injected' }];
  for (const body of values) {
    let core = true;
    try { parseDeploymentOperationBody(body); } catch { core = false; }
    assert.equal(core, apiOperations['deployments-retry'].input.shape.body.safeParse(body).success);
  }
  // Then: only exact approved paths/verbs are published.
  const document = createOpenApiDocument();
  assert.equal(document.paths['/deployments/{deploymentId}/retry'].post['x-permission'], 'deploy:run');
  assert.equal(document.paths['/services/{serviceId}/redeploy'].post['x-permission'], 'deploy:run');
});

test('deployment retry adversarial matrix preserves secret refs and quota rejection', async () => {
  // Given: captured Kubernetes secret references and a zero-deployment quota.
  const { repository, service } = await fixture();
  const reference = { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'database-credentials', key: 'password' } } };
  repository.store.services.get(service.id).secretEnv = [reference];
  repository.store.services.get(service.id).environment = { API_TOKEN: 'fixture-raw-token' };
  const source = await repository.createDeployment({ id: 'secret-source', serviceId: service.id, status: 'FAILED', imageUrl: `example/app@sha256:${'c'.repeat(64)}`, imageDigest: `sha256:${'c'.repeat(64)}` });
  const user = await repository.createUser({ name: 'Quota', email: 'quota-lineage@example.test', approvalStatus: 'APPROVED' });
  const project = repository.store.projects.get(service.projectId);
  await repository.addMember({ userId: user.id, organizationId: project.organizationId, role: 'OWNER' });
  repository.store.setQuota({ userId: user.id, maxDeploymentsPerDay: 0 });
  const input = { operation: 'retry', serviceId: service.id, sourceDeploymentId: source.id, requestedByUserId: user.id, requestIdempotencyKey: 'quota', snapshotVersion: 1 };
  // When: quota refuses the operation before any deployment/job side effects.
  await assert.rejects(repository.createDeploymentOperation(input), error => error.statusCode === 403);
  // Then: references remain intact; material secrets do not enter snapshots; lineage is immutable.
  assert.deepEqual(source.desiredSpecSnapshot.secretEnv, [reference]);
  assert.equal(JSON.stringify(source).includes('fixture-raw-token'), false);
  assert.equal(repository.store.deployments.size, 2);
  assert.equal(repository.store.workflowJobs.length, 0);
  await assert.rejects(repository.updateDeployment(source.id, { desiredSpecSnapshot: {} }), error => error.statusCode === 409);
});

test('C15-1 Git lineage accepts only an unambiguous complete durable revision', () => {
  // Given: a v1 Git snapshot with no access to mutable Service or job state.
  const source = { id: 'git-source', serviceId: 'service', projectId: 'project', status: 'FAILED', snapshotVersion: 1, desiredSpecSnapshot: { sourceType: 'github', repoUrl: 'https://example.test/repo.git' } };
  for (const operation of ['retry', 'redeploy']) {
    const input = { operation, serviceId: source.serviceId, sourceDeploymentId: source.id, requestedByUserId: 'system', requestIdempotencyKey: operation, snapshotVersion: 1 };
    // When / Then: missing, mutable, abbreviated, zero and conflicting pins fail closed.
    for (const commitSha of [null, '', '  ', 'HEAD', 'main', 'refs/tags/v1', 'abc1234', 'g'.repeat(40), '0'.repeat(40), '0'.repeat(64)]) {
      assert.throws(() => deploymentSuccessor({ ...source, commitSha }, input), error => error.code === 'SOURCE_INELIGIBLE' && error.statusCode === 409, String(commitSha));
    }
    assert.throws(() => deploymentSuccessor({ ...source, commitSha: 'a'.repeat(40), commitHash: 'b'.repeat(40) }, input), error => error.code === 'SOURCE_INELIGIBLE');
    for (const pin of ['a'.repeat(40), 'b'.repeat(64)]) {
      const successor = deploymentSuccessor({ ...source, commitSha: ' ', commitHash: ` ${pin.toUpperCase()} ` }, input);
      assert.equal(successor.commitSha, pin);
      assert.equal(successor.commitHash, pin);
      assert.equal(deploymentSuccessor({ ...source, commitSha: pin, commitHash: pin.toUpperCase() }, input).commitSha, pin);
    }
    for (const desiredSpecSnapshot of [{ sourceType: 'image' }, { buildMode: 'prebuilt_image', repoUrl: 'ignored' }, { localPath: '/fixture', repoUrl: 'ignored' }, { sourceType: 'github' }]) {
      assert.equal(deploymentSuccessor({ ...source, desiredSpecSnapshot, imageUrl: `example/app@sha256:${'c'.repeat(64)}` }, input).status, 'queued');
    }
  }
});

for (const transport of ['core', 'nest']) {
  test(`C15-1 unresolved Git source rejects retry and selected latest redeploy before writes over ${transport} HTTP`, async t => {
    // Given: a pinned older Git source and newer sources whose initial clone never pinned a revision.
    const runtime = await bootLineageApi(t, transport);
    const { repository, service, project } = runtime;
    const spec = { sourceType: 'github', repoUrl: 'https://example.test/repo.git' };
    repository.store.services.get(service.id).desiredSpec = spec;
    const old = await repository.createDeployment({ id: 'pinned-old', serviceId: service.id, projectId: project.id, status: 'FAILED', commitSha: 'a'.repeat(40) });
    repository.store.deployments.get(old.id).createdAt = '2020-01-01T00:00:00.000Z';
    for (const [index, commitSha] of [null, '', 'HEAD'].entries()) {
      const source = await repository.createDeployment({ id: `unpinned-${index}`, serviceId: service.id, projectId: project.id, status: 'BUILD_FAILED', commitSha, desiredSpecSnapshot: spec, snapshotVersion: 1 });
      repository.store.deployments.get(source.id).createdAt = `2026-01-0${index + 1}T00:00:00.000Z`;
      const before = JSON.stringify([...repository.store.deployments]);
      const events = JSON.stringify(repository.store.listDeploymentEvents(source.id));
      // When / Then: both routes refuse the selected source; no fallback, successor, event or job writes.
      for (const path of [`/deployments/${source.id}/retry`, `/services/${service.id}/redeploy`]) {
        const result = await runtime.post(path, { requestIdempotencyKey: `invalid-${index}`, snapshotVersion: 1 });
        assert.equal(result.status, 409, JSON.stringify(result));
        assert.equal(result.body.code, 'SOURCE_INELIGIBLE');
        assert.equal(JSON.stringify([...repository.store.deployments]), before);
        assert.equal(JSON.stringify(repository.store.listDeploymentEvents(source.id)), events);
        assert.equal(repository.store.workflowJobs.length, 0);
      }
    }
    // Given / When: the latest source is durably pinned; an exact replay survives a later invalid source.
    const latest = await repository.createDeployment({ id: 'pinned-latest', serviceId: service.id, projectId: project.id, status: 'FAILED', commitHash: 'b'.repeat(64), desiredSpecSnapshot: spec, snapshotVersion: 1 });
    const body = { requestIdempotencyKey: 'pinned', snapshotVersion: 1 };
    const accepted = await runtime.post(`/services/${service.id}/redeploy`, body);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.deployment.sourceDeploymentId, latest.id);
    assert.equal(accepted.body.deployment.commitSha, 'b'.repeat(64));
    await repository.createDeployment({ id: 'new-unpinned', serviceId: service.id, projectId: project.id, status: 'FAILED', desiredSpecSnapshot: spec, snapshotVersion: 1 });
    assert.deepEqual(await runtime.post(`/services/${service.id}/redeploy`, body), accepted);
    t.diagnostic(JSON.stringify({ transport, rejectedRequests: 6, noWriteOnRejection: true, initialUnpinnedAllowed: true, pinnedLatestAccepted: true, replayStable: true }));
  });
}

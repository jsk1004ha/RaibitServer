import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import * as sse from '../packages/core/src/sse.ts';
import { createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';

test('Given deployment activity cursors, When a Last-Event-ID is resumed, Then all cursors round-trip within its deployment scope', () => {
  const scope = { projectId: 'project-a', deploymentId: 'deployment-a' };
  const cursors = {
    deploymentCursor: 'deployment-version',
    logCursor: Buffer.from(JSON.stringify({ v: 1, at: '2026-09-04T00:00:00.000Z', id: 'log-a' })).toString('base64url'),
    eventCursor: Buffer.from(JSON.stringify({ v: 1, at: '2026-09-04T00:00:00.000Z', id: 'event-a' })).toString('base64url'),
  };

  assert.equal(typeof sse.encodeDeploymentActivityResumeToken, 'function');
  assert.equal(typeof sse.decodeDeploymentActivityResumeToken, 'function');
  const token = sse.encodeDeploymentActivityResumeToken(scope, cursors);
  assert.deepEqual(sse.decodeDeploymentActivityResumeToken(token, scope), {
    deploymentCursor: cursors.deploymentCursor,
    logCursorToken: cursors.logCursor,
    eventCursorToken: cursors.eventCursor,
  });
  assert.throws(() => sse.decodeDeploymentActivityResumeToken(token, { ...scope, deploymentId: 'deployment-b' }), (error) => error.code === 'INVALID_DEPLOYMENT_RESUME_CURSOR' && error.statusCode === 400, 'a stale cursor from another deployment is terminal');
  assert.throws(() => sse.decodeDeploymentActivityResumeToken('malformed', scope), (error) => error.code === 'INVALID_DEPLOYMENT_RESUME_CURSOR' && error.statusCode === 400);
});

test('Given deployment logs and events, When the same SSE cursor reconnects, Then only strictly later rows are returned', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Resume', slug: 'resume' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'Web' });
  const deployment = controlPlane.store.createDeployment({ serviceId: service.id, projectId: project.id, status: 'BUILDING' });
  const timestamp = '2026-09-04T00:00:00.000Z';
  controlPlane.store.buildLogs = [{ id: 'log-a', deploymentId: deployment.id, line: 'first-log', timestamp }];
  controlPlane.store.deploymentEvents = [{ id: 'event-a', deploymentId: deployment.id, message: 'first-event', timestamp }];
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');

  try {
    const first = await request(server, `/deployments/${deployment.id}/stream`);
    const cursor = first.body.match(/^id: (\S+)$/m)?.[1];
    assert.ok(cursor);
    controlPlane.store.buildLogs.push({ id: 'log-b', deploymentId: deployment.id, line: 'second-log', timestamp });
    controlPlane.store.deploymentEvents.push({ id: 'event-b', deploymentId: deployment.id, message: 'second-event', timestamp });

    const resumed = await request(server, `/deployments/${deployment.id}/stream`, cursor);

    assert.equal(resumed.statusCode, 200);
    assert.doesNotMatch(resumed.body, /first-log|first-event/);
    assert.match(resumed.body, /log-b/);
    assert.match(resumed.body, /second-event/);
    const malformed = await request(server, `/deployments/${deployment.id}/stream`, 'malformed');
    assert.equal(malformed.statusCode, 400);
    assert.match(malformed.body, /INVALID_DEPLOYMENT_RESUME_CURSOR/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given an idempotent deployment retry, When the request is replayed, Then the server returns one stable operation ID', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Operations', slug: 'operations' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', sourceType: 'image', image: 'example/app:v1' });
  const source = await repository.createDeployment({ serviceId: service.id, projectId: project.id, status: 'FAILED', imageUrl: `example/app@sha256:${'a'.repeat(64)}` });
  const request = { operation: 'retry', serviceId: service.id, sourceDeploymentId: source.id, requestedByUserId: 'system', requestIdempotencyKey: 'stable-operation', snapshotVersion: 1 };

  const first = await repository.createDeploymentOperation(request);
  const replay = await repository.createDeploymentOperation(request);

  assert.equal(typeof first.operationId, 'string');
  assert.equal(replay.operationId, first.operationId);
  assert.equal(first.operationId, first.workflowJob.id);
  assert.equal(repository.store.workflowJobs.length, 1);
  await assert.rejects(repository.createDeploymentOperation({ ...request, snapshotVersion: 2 }), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
  repository.store.deployments.get(first.deployment.id).status = 'FAILED';
  const refreshed = await repository.createDeploymentOperation({ ...request, operation: 'redeploy', sourceDeploymentId: undefined, requestIdempotencyKey: 'fresh-render' });
  assert.notEqual(refreshed.operationId, first.operationId);
  assert.equal(repository.store.workflowJobs.length, 2);
});

test('Given a Task18 preview lineage, When explicit cleanup is replayed, Then one stable close operation is returned', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Cleanup', slug: 'cleanup' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'Web' });
  const lineageId = 'preview-lineage-a';
  const deployment = controlPlane.store.createDeployment({ serviceId: service.id, projectId: project.id, status: 'READY', deploymentType: 'preview', previewLineageId: lineageId });
  controlPlane.store.previewLineages.set(lineageId, {
    id: lineageId, organizationId: organization.id, projectId: project.id, serviceId: service.id, integrationId: 'integration',
    installationId: 'installation', repositoryId: 'repository', repository: 'owner/repo', pullRequestNumber: 7,
    stableHost: 'preview.example.test', namespace: 'preview-namespace', routeName: 'preview-route', state: 'OPEN', version: 1, generation: 1,
    eventUpdatedAt: '2026-09-04T00:00:00.000Z', eventAction: 'opened', headSha: 'a'.repeat(40), headRef: 'feature', baseRef: 'main', beforeSha: null,
    candidateDeploymentId: deployment.id, candidateGeneration: 1, currentDeploymentId: deployment.id, currentGeneration: 1,
  });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');

  try {
    const first = await request(server, `/deployments/${deployment.id}/preview-cleanup`, undefined, { method: 'POST', body: { confirmed: true } });
    const replay = await request(server, `/deployments/${deployment.id}/preview-cleanup`, undefined, { method: 'POST', body: { confirmed: true } });
    const firstBody = JSON.parse(first.body);
    const replayBody = JSON.parse(replay.body);

    assert.equal(first.statusCode, 202);
    assert.equal(replayBody.operationId, firstBody.operationId);
    assert.equal(firstBody.status, 'PREVIEW_CLEANUP_REQUESTED');
    assert.equal(controlPlane.store.getDeployment(deployment.id).status, 'PREVIEW_CLEANUP_REQUESTED');
    assert.equal(controlPlane.store.listDeploymentEvents(deployment.id).filter((event) => event.type === 'preview.cleanup.requested').length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Given the checked-in API artifact, When deployment stream and cleanup contracts are compared, Then generated and published shapes agree', async () => {
  const artifact = YAML.parse(await readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  const generated = JSON.parse(JSON.stringify(createOpenApiDocument()));

  for (const [path, method] of [['/deployments/{deploymentId}/stream', 'get'], ['/deployments/{deploymentId}/preview-cleanup', 'post']]) {
    assert.deepEqual(artifact.paths[path][method], generated.paths[path][method]);
  }
  assert.equal(artifact.paths['/deployments/{deploymentId}/stream'].get.parameters.find((parameter) => parameter.name === 'Last-Event-ID').schema.maxLength, 4096);
  assert.equal(artifact.components.schemas.DeploymentOperationResult.required.includes('operationId'), true);
  const typedError = artifact.components.schemas.ErrorBody.anyOf.find((variant) => variant.properties?.retryable);
  assert.equal(typedError?.properties.retryable.type, 'boolean');
});

function request(server, path, lastEventId, options = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const outgoing = http.request({ port: address.port, path, method: options.method || 'GET', headers: { ...(lastEventId ? { 'last-event-id': lastEventId } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

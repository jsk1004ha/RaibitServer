import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiHandler } from '../../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../../packages/core/src/control-plane.ts';
import { InMemoryControlPlaneRepository } from '../../packages/core/src/persistence.ts';
import { createSessionToken } from '../../packages/core/src/identity.ts';
import { bootParityApi } from './api-parity-runtime.mjs';

export async function bootLineageApi(t, transport) {
  const jwtSecret = 'local-semantic-parity-test-secret-only';
  let repository;
  let baseUrl;
  if (transport === 'nest') {
    const runtime = await bootParityApi();
    repository = runtime.repository;
    baseUrl = runtime.baseUrl;
    t.after(() => runtime.app.close());
  } else {
    const controlPlane = new RAIBITSERVERControlPlane();
    repository = new InMemoryControlPlaneRepository(controlPlane.store);
    const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret, issuer: 'raibitserver' } }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  }
  const organization = await repository.createOrganization({ name: 'HTTP lineage', slug: 'http-lineage' });
  const user = await repository.createUser({ email: 'lineage@example.test', name: 'Lineage', approvalStatus: 'APPROVED' });
  const membership = await repository.addMember({ userId: user.id, organizationId: organization.id, role: 'OWNER' });
  const outsider = await repository.createUser({ email: 'outside@example.test', name: 'Outside', approvalStatus: 'APPROVED' });
  const reader = await repository.createUser({ email: 'reader@example.test', name: 'Reader', approvalStatus: 'APPROVED' });
  const readerMembership = await repository.addMember({ userId: reader.id, organizationId: organization.id, role: 'VIEWER' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'App', slug: 'app' });
  const service = await repository.createService({ projectId: project.id, name: 'Web', type: 'web', sourceType: 'image', image: 'example/app:v1', port: 3000 });
  const token = createSessionToken(user, [membership], jwtSecret);
  const outsideToken = createSessionToken(outsider, [], jwtSecret);
  const readerToken = createSessionToken(reader, [readerMembership], jwtSecret);
  async function post(path, body, authorization = token) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  }
  return { repository, service, project, user, baseUrl, token, outsideToken, readerToken, post };
}

export async function imageIdentityRegression(t, transport) {
  // Given: an image service whose snapshot tag cannot authorize an immutable replay.
  const { repository, service, project, post } = await bootLineageApi(t, transport);
  const digest = `sha256:${'d'.repeat(64)}`;
  const source = await repository.createDeployment({ id: 'image-source', serviceId: service.id, projectId: project.id, status: 'FAILED', imageUrl: 'example/app:v1' });
  const row = repository.store.deployments.get(source.id);
  for (const identity of [{ imageUrl: 'example/app:v1', imageDigest: null }, { imageUrl: null, imageDigest: digest }, { imageUrl: 'example/app@sha256:bad', imageDigest: digest }, { imageUrl: `example/app@${digest}`, imageDigest: `sha256:${'c'.repeat(64)}` }]) {
    Object.assign(row, identity);
    const before = JSON.stringify([...repository.store.deployments]);
    const events = JSON.stringify(repository.store.listDeploymentEvents(source.id));
    // When / Then: both endpoints reject unbound identities before any write.
    for (const path of [`/deployments/${source.id}/retry`, `/services/${service.id}/redeploy`]) {
      const result = await post(path, { requestIdempotencyKey: 'image-invalid', snapshotVersion: 1 });
      assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(result.body.code, 'SOURCE_INELIGIBLE');
      assert.equal(JSON.stringify([...repository.store.deployments]), before);
      assert.equal(JSON.stringify(repository.store.listDeploymentEvents(source.id)), events);
      assert.equal(repository.store.workflowJobs.length, 0);
    }
  }
  Object.assign(row, { imageUrl: 'registry.example:5000/team/app:v1', imageDigest: digest });
  const before = JSON.stringify(row);
  const events = JSON.stringify(repository.store.listDeploymentEvents(source.id));
  // Given / When: a separate durable digest pins the repository independently of the snapshot tag.
  const body = { requestIdempotencyKey: 'image-valid', snapshotVersion: 1 };
  const accepted = await post(`/services/${service.id}/redeploy`, body);
  assert.equal(accepted.status, 202);
  for (const bound of [accepted.body.deployment, accepted.body.workflowJob.payload]) {
    assert.equal(bound.imageUrl, `registry.example:5000/team/app@${digest}`);
    assert.equal(bound.imageDigest, digest);
  }
  repository.store.services.get(service.id).image = 'changed:latest';
  assert.deepEqual(await post(`/services/${service.id}/redeploy`, body), accepted);
  assert.equal(JSON.stringify(row), before);
  assert.equal(JSON.stringify(repository.store.listDeploymentEvents(source.id)), events);
  t.diagnostic(JSON.stringify({ transport, imageRejects: 8, writesOnRejection: 0, canonicalSuccessorAndJob: true, sourceUnchanged: true, replayStable: true }));
}

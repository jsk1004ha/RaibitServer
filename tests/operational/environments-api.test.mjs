import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import '../../tests/fixtures/api-parity-runtime.mjs';
import {
  environmentNamespace,
  environmentPhysicalSlug,
  projectRuntimeEnvironment,
} from '../../packages/core/src/environments.ts';
import { ControlPlaneStore } from '../../packages/core/src/store.ts';
import { RAIBITSERVERClient } from '../../packages/api-client/src/index.ts';

const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { RAIBITSERVERService } = apiRequire('./src/raibitserver.service.ts');

process.env.RAIBITSERVER_PERSISTENCE = 'memory';
process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';

async function fixture() {
  const controlPlane = new RAIBITSERVERService();
  const repository = await controlPlane.repositoryPromise;
  const organization = await repository.createOrganization({ name: 'Environment Org', slug: 'environment-org' });
  const owner = await repository.createUser({ email: 'owner@environment.test', name: 'Owner', role: 'USER', accountType: 'NON_CLUB', approvalStatus: 'APPROVED' });
  await repository.addMember({ organizationId: organization.id, userId: owner.id, role: 'OWNER' });
  const subject = { id: owner.id, role: 'OWNER', organizationId: organization.id };
  const project = await controlPlane.createProject({ organizationId: organization.id, name: 'Environment App', slug: 'environment-app' }, subject);
  return { controlPlane, repository, organization, owner, subject, project };
}

test('environment identity projection preserves prod and deterministically namespaces dev', () => {
  assert.equal(environmentPhysicalSlug('prod', 'env-prod', 'api'), 'api');
  assert.match(environmentPhysicalSlug('dev', 'env-dev', 'api'), /^dev-[a-f0-9]{10}-api$/);
  assert.match(environmentNamespace('dev', 'env-dev'), /^rb-dev-[a-f0-9]{20}$/);
  assert.deepEqual(projectRuntimeEnvironment({
    environment: { id: 'env-prod', projectId: 'project', kind: 'prod' },
    services: [{ id: 'service', projectId: 'project', slug: 'api' }],
    resources: [{ id: 'resource', projectId: 'project', slug: 'database' }],
  }), {
    environment: { id: 'env-prod', projectId: 'project', kind: 'prod' },
    services: [{ serviceId: 'service', logicalSlug: 'api', physicalSlug: 'api' }],
    resources: [{ resourceId: 'resource', logicalSlug: 'database', physicalName: 'database' }],
  });
});

test('long project identities keep distinct dev service and resource primary IDs', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Long identity organization', slug: `organization-${'a'.repeat(49)}` });
  const project = store.createProject({ organizationId: organization.id, name: 'Long identity project', slug: `project-${'b'.repeat(49)}` });
  assert.equal(project.id.length, 63);
  const dev = store.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  const services = ['api', 'worker'].map((name) => store.createService({ projectId: project.id, environmentId: dev.id, name }));
  const resources = ['primary', 'cache'].map((name) => store.createResource({ projectId: project.id, environmentId: dev.id, name, engine: 'postgresql' }));
  assert.equal(new Set(services.map((row) => row.id)).size, 2);
  assert.equal(new Set(resources.map((row) => row.id)).size, 2);
  assert.equal(store.listServicesForEnvironment(project.id, dev.id).length, 2);
  assert.equal(store.listResourcesForEnvironment(project.id, dev.id).length, 2);
});

test('typed environment operations preserve exact public routes and bodies', async () => {
  const observed = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observed.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ statusCode: 400, message: 'probe', error: 'Bad Request' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(client.operations['projects-environments']({ path: { projectId: 'project /?' }, query: {}, body: {} }), (error) => error.status === 400);
    await assert.rejects(client.operations['projects-environments-post']({ path: { projectId: 'project' }, query: {}, body: { kind: 'dev', expectedVersion: 0 } }), (error) => error.status === 400);
    await assert.rejects(client.operations['projects-environments-delete']({ path: { projectId: 'project', environmentId: 'env /?' }, query: {}, body: { expectedVersion: 1, confirmation: 'delete dev env' } }), (error) => error.status === 400);
    assert.deepEqual(observed, [
      { method: 'GET', url: '/projects/project%20%2F%3F/environments', body: null },
      { method: 'POST', url: '/projects/project/environments', body: { kind: 'dev', expectedVersion: 0 } },
      { method: 'DELETE', url: '/projects/project/environments/env%20%2F%3F', body: { expectedVersion: 1, confirmation: 'delete dev env' } },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('project starts with prod only and environment lists isolate logical identities without double project quota', async () => {
  const runtime = await fixture();
  try {
    assert.deepEqual((await runtime.controlPlane.listEnvironments(runtime.project.id, runtime.subject)).environments.map((row) => row.kind), ['prod']);
    const dev = await runtime.controlPlane.createEnvironment(runtime.project.id, { kind: 'dev', expectedVersion: 0 }, runtime.subject);
    const prodService = await runtime.controlPlane.addService(runtime.project.id, { name: 'api', sourceType: 'image', image: `registry.test/api@sha256:${'a'.repeat(64)}` }, runtime.subject);
    const devService = await runtime.controlPlane.addService(runtime.project.id, { name: 'api', sourceType: 'image', image: `registry.test/api@sha256:${'b'.repeat(64)}`, environmentId: dev.id }, runtime.subject);
    const prodResource = await runtime.controlPlane.addResource(runtime.project.id, { name: 'database', engine: 'postgresql' }, runtime.subject);
    const devResource = await runtime.controlPlane.addResource(runtime.project.id, { name: 'database', engine: 'postgresql', environmentId: dev.id }, runtime.subject);

    assert.equal((await runtime.repository.snapshot()).projects.length, 1);
    assert.deepEqual((await runtime.controlPlane.listServices(runtime.project.id, runtime.subject)).services.map((row) => row.id), [prodService.id]);
    assert.deepEqual((await runtime.controlPlane.listServices(runtime.project.id, runtime.subject, { environmentId: dev.id })).services.map((row) => row.id), [devService.id]);
    assert.deepEqual((await runtime.controlPlane.listResources(runtime.project.id, runtime.subject)).resources.map((row) => row.id), [prodResource.id]);
    assert.deepEqual((await runtime.controlPlane.listResources(runtime.project.id, runtime.subject, { environmentId: dev.id })).resources.map((row) => row.id), [devResource.id]);
    assert.equal(devService.slug, 'api');
    assert.equal(devResource.slug, 'database');
  } finally {
    await runtime.controlPlane.onModuleDestroy();
  }
});

test('environment boundary returns 404 for foreign scope and cross-environment attachment', async () => {
  const runtime = await fixture();
  try {
    const dev = await runtime.controlPlane.createEnvironment(runtime.project.id, { kind: 'dev', expectedVersion: 0 }, runtime.subject);
    const service = await runtime.controlPlane.addService(runtime.project.id, { name: 'dev-api', sourceType: 'image', image: `registry.test/api@sha256:${'c'.repeat(64)}`, environmentId: dev.id }, runtime.subject);
    const resource = await runtime.controlPlane.addResource(runtime.project.id, { name: 'prod-db', engine: 'postgresql' }, runtime.subject);
    await assert.rejects(() => runtime.controlPlane.listServices(runtime.project.id, runtime.subject, { environmentId: 'env_dev_foreign' }), (error) => error.getStatus() === 404);
    await assert.rejects(() => runtime.controlPlane.attachResource(resource.id, { serviceId: service.id }, runtime.subject), (error) => error.getStatus() === 404);
  } finally {
    await runtime.controlPlane.onModuleDestroy();
  }
});

test('dev lifecycle requires admin role, feature activation, version, confirmation, and empty bindings', async () => {
  const runtime = await fixture();
  try {
    await assert.rejects(() => runtime.controlPlane.createEnvironment(runtime.project.id, { kind: 'dev', expectedVersion: 0 }, { ...runtime.subject, role: 'MAINTAINER' }), (error) => error.getStatus() === 403);
    process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '0';
    await assert.rejects(() => runtime.controlPlane.createEnvironment(runtime.project.id, { kind: 'dev', expectedVersion: 0 }, runtime.subject), (error) => error.getStatus() === 409);
    process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
    const dev = await runtime.controlPlane.createEnvironment(runtime.project.id, { kind: 'dev', expectedVersion: 0 }, runtime.subject);
    const service = await runtime.controlPlane.addService(runtime.project.id, { name: 'dev-api', sourceType: 'image', image: `registry.test/api@sha256:${'d'.repeat(64)}`, environmentId: dev.id }, runtime.subject);
    await assert.rejects(() => runtime.controlPlane.deleteEnvironment(runtime.project.id, dev.id, { expectedVersion: 1, confirmation: `delete dev ${dev.id}` }, runtime.subject), (error) => error.getStatus() === 409);
    await runtime.controlPlane.deleteService(service.id, runtime.subject, { environmentId: dev.id });
    await assert.rejects(() => runtime.controlPlane.deleteEnvironment(runtime.project.id, dev.id, { expectedVersion: 0, confirmation: `delete dev ${dev.id}` }, runtime.subject), (error) => error.getStatus() === 409);
    await assert.rejects(() => runtime.controlPlane.deleteEnvironment(runtime.project.id, dev.id, { expectedVersion: 1, confirmation: 'wrong' }, runtime.subject), (error) => error.getStatus() === 400);
    assert.deepEqual(await runtime.controlPlane.deleteEnvironment(runtime.project.id, dev.id, { expectedVersion: 1, confirmation: `delete dev ${dev.id}` }, runtime.subject), { deleted: true, environmentId: dev.id });
  } finally {
    process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
    await runtime.controlPlane.onModuleDestroy();
  }
});

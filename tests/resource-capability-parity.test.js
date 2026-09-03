import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { listCatalog } from '../packages/core/src/catalog.ts';
import { sanitizeTenantResourceApiInput } from '../packages/core/src/security.ts';
import { RESOURCE_CAPABILITIES, requireResourceCapability } from '../packages/core/src/resource-capabilities.ts';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';
import { compileResourceProvisioningPlan } from '../packages/core/src/provisioner.ts';
import { parse } from 'yaml';
import { buildResourceProviderPlan } from '../packages/core/src/resource-providers.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { assertCapabilityParity, capabilitySource, capabilityCopies } from '../scripts/generate-resource-capabilities.mjs';
import { apiOperations, createOpenApiDocument, z } from '../packages/schemas/src/api-contract.ts';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';

const supported = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'sqlite', 'redis', 'valkey'];
const canonicalBytes = await readFile(capabilitySource);
const canonical = JSON.parse(canonicalBytes);
const hash = createHash('sha256').update(canonicalBytes).digest('hex');
console.log(`RESOURCE_CAPABILITY_SHA256=${hash}`);

test('Given schema capability crossing, when canonical inputs are parsed, then generated OpenAPI and Zod accept only the seven local engines', () => {
  const document = createOpenApiDocument();
  for (const operationId of ['resources-create', 'resources-update']) {
    const contract = apiOperations[operationId];
    const schema = document.paths[contract.path][contract.method].requestBody.content['application/json'].schema;
    const wire = z.fromJSONSchema(JSON.parse(JSON.stringify({ ...schema, $defs: document.components.schemas }).replaceAll('#/components/schemas/', '#/$defs/')));
    for (const engine of [...supported, ...canonical.engines.filter(entry => !entry.local.provision).map(entry => entry.engine), 'pg', 'postgres', 'unknown']) {
      const body = { name: 'crossing', engine };
      const input = { path: operationId === 'resources-create' ? { projectId: 'crossing' } : { resourceId: 'crossing' }, query: {}, body };
      assert.equal(contract.input.safeParse(input).success, supported.includes(engine), `${operationId}: ${engine}`);
      assert.equal(wire.safeParse(body).success, supported.includes(engine), `OpenAPI ${operationId}: ${engine}`);
    }
  }
  assert.equal(apiOperations['resources-get'].response.safeParse({ id: 'legacy', projectId: 'crossing', name: 'legacy', engine: 'qdrant', status: 'FAILED' }).success, true);
});

test('Given schema capability crossing, when generated contracts are inspected, then the fifth mirror and create error are explicit', () => {
  const document = createOpenApiDocument();
  assert.deepEqual(Object.keys(capabilityCopies).sort(), ['CLI', 'Go', 'Helm', 'Schemas', 'TypeScript']);
  assert.deepEqual(document.components.schemas.LocalResourceEngine.enum, supported);
  assert.equal(document['x-resource-capability-source'], 'test-fixtures/contracts/resource-capabilities-v1.json');
  assert.equal(document.paths['/projects/{projectId}/resources'].post.responses['400'].content['application/json'].schema.$ref, '#/components/schemas/ErrorBody');
});

test('Given schema capability crossing, when the actual typed client submits engines, then unsupported and alias inputs never reach HTTP', async () => {
  const observed = [];
  const server = http.createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk;
    const body = JSON.parse(content);
    observed.push(body.engine);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'desired', projectId: 'crossing', ...body, status: 'PENDING' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    for (const engine of [...supported, ...canonical.engines.filter(entry => !entry.local.provision).map(entry => entry.engine), 'pg', 'postgres']) {
      const invoke = () => client.operations['resources-create']({ path: { projectId: 'crossing' }, query: {}, body: { name: 'crossing', engine } });
      if (supported.includes(engine)) assert.equal((await invoke()).status, 'PENDING');
      else await assert.rejects(invoke, error => error.name === 'ZodError', engine);
    }
    assert.deepEqual(observed, supported);
    console.log(`TYPED_CAPABILITY_WIRE=${JSON.stringify(observed)}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Given unsupported engines, when API input is parsed, then provisioning is rejected', () => {
  for (const engine of ['object-storage', 'qdrant', 'nats', 'vector-db', 'message-queue']) {
    assert.throws(() => sanitizeTenantResourceApiInput({ name: 'rejected', engine }),
      error => error.statusCode === 400 && error.code === 'RESOURCE_CAPABILITY_UNAVAILABLE', engine);
  }
});

test('Given one canonical matrix, when consumers load it, then generated bytes and catalog capabilities agree', async () => {
  assert.deepEqual(RESOURCE_CAPABILITIES.filter(entry => entry.local.provision).map(entry => entry.engine), supported);
  assert.deepEqual(listCatalog().map(entry => entry.capabilities), canonical.engines);
  for (const [consumer, path] of Object.entries(capabilityCopies)) assertCapabilityParity(canonicalBytes, await readFile(path), consumer);
  for (const entry of RESOURCE_CAPABILITIES) {
    for (const environment of ['local', 'release']) {
      assert.deepEqual(Object.keys(entry[environment]).sort(), ['provision', 'authenticatedHealth', 'attach', 'query', 'schema', 'backup', 'restore'].sort());
      for (const enabled of Object.values(entry[environment])) assert.equal(typeof enabled, 'boolean');
    }
    assert.equal(entry.liveEvidence.release, 'not-recorded');
    for (const operation of Object.keys(entry.release)) assert.throws(() => requireResourceCapability(entry.engine, operation, 'release'), { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
  }
});

test('Given capability drift mutation matrix, when qdrant-live or missing-MySQL-backup is introduced, then the divergent consumer is named', async () => {
  for (const [consumer, path] of Object.entries(capabilityCopies)) {
    for (const mutation of ['qdrant-live', 'missing-MySQL-backup']) {
      const actual = JSON.parse(await readFile(path, 'utf8'));
      if (mutation === 'qdrant-live') actual.engines.find(entry => entry.engine === 'qdrant').local.provision = true;
      else delete actual.engines.find(entry => entry.engine === 'mysql').local.backup;
      assert.throws(() => assertCapabilityParity(canonical, actual, consumer), error => error.message.startsWith(`${consumer}: resource capability drift`));
      console.log(`MUTATION_DETECTED consumer=${consumer} mutation=${mutation}`);
    }
  }
});

test('Given each engine, when TS compilers plan it, then unsupported engines reject and backup is never promised', () => {
  for (const entry of RESOURCE_CAPABILITIES) {
    const resource = { name: 'capability', engine: entry.engine };
    const compile = () => compileProject({ project: { slug: 'capability' }, resources: [resource] });
    const provider = () => buildResourceProviderPlan(resource);
    const provisioning = () => compileResourceProvisioningPlan(resource);
    if (!entry.local.provision) {
      assert.throws(compile, { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
      assert.throws(provider, { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
      assert.throws(provisioning, { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
    } else {
      const plan = compile().resourcePlans[0];
      assert.deepEqual(plan.capabilities, entry);
      assert.equal(plan.backup, undefined);
      assert.equal(plan.lifecycle.includes('backup'), false);
      assert.deepEqual(provider().capabilities, entry);
      assert.deepEqual(provisioning().capabilities, entry);
      assert.equal(provisioning().manifests[0].spec.backup, undefined);
    }
  }
});

test('Given OpenAPI and CLI help, when inspected as published contracts, then supported engine choices match the matrix', async () => {
  const openapi = parse(await readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  assert.deepEqual(openapi.components.schemas.LocalResourceEngine.enum, supported);
  assert.equal(openapi['x-resource-capability-source'], 'test-fixtures/contracts/resource-capabilities-v1.json');
  for (const cli of ['src/cli.js', 'apps/cli/src/index.ts']) {
    const result = spawnSync(process.execPath, [cli, 'help'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const entry of RESOURCE_CAPABILITIES) assert.equal(result.stdout.includes(`${entry.engine}: ${entry.reasonKo}`), true);
  }
});

test('Given HTTP create requests, when unsupported engines or backup workflows are submitted, then no resource is persisted', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Capability', slug: 'capability' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'Capability', slug: 'capability' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/projects/${project.id}/resources`;
  try {
    for (const entry of RESOURCE_CAPABILITIES.filter(entry => !entry.local.provision)) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: entry.engine, engine: entry.engine }) });
      const body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(body.error, /RESOURCE_CAPABILITY_UNAVAILABLE/);
      console.log(`HTTP_REJECT engine=${entry.engine} status=${response.status}`);
    }
    const backup = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'backup', engine: 'mysql', backup: { enabled: true } }) });
    assert.equal(backup.status, 400);
    assert.equal(controlPlane.store.snapshot().resources.length, 0);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'pg', engine: 'postgresql' }) });
    assert.equal(response.status, 201, await response.text());
    assert.equal(controlPlane.store.snapshot().resources.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Given CLI catalog, when invoked, then disabled engines retain their capability reasons', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'catalog'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).resources.map(entry => entry.capabilities), canonical.engines);
});

test('Given the catalog, when listed, then each entry exposes explicit local and release capabilities', () => {
  for (const entry of listCatalog()) {
    assert.equal(typeof entry.capabilities?.local?.provision, 'boolean', entry.key);
    assert.equal(entry.capabilities.release.provision, false, entry.key);
  }
});

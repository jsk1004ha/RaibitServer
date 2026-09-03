import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';
import { resolveBuildStrategy } from '../packages/core/src/build-strategy.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';
import { INTERNAL_SERVICE_MUTATION } from '../packages/core/src/desired-state-mutations.ts';
import { ProjectUpdateSchema, ServiceUpdateSchema } from '../packages/schemas/src/desired-state-mutations.ts';

const fixture = JSON.parse(await fs.readFile(new URL('../test-fixtures/contracts/service-settings-v1.json', import.meta.url), 'utf8'));
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function capture(name, value) {
  if (!process.env.RAIBIT_MUTATION_EVIDENCE) return;
  await fs.mkdir(process.env.RAIBIT_MUTATION_EVIDENCE, { recursive: true });
  await fs.writeFile(`${process.env.RAIBIT_MUTATION_EVIDENCE}/${name}.json`, JSON.stringify(value, null, 2));
}
function seed(store) {
  const organization = store.createOrganization({ name: 'Mutation', slug: 'mutation' });
  const project = store.createProject({ organizationId: organization.id, name: 'Before', slug: 'mutation' });
  const service = store.createService({ projectId: project.id, name: 'web', type: 'web', sourceType: 'github', repoUrl: 'https://github.com/fixture/original', ...fixture.editable });
  store.createDeployment({ projectId: project.id, serviceId: service.id, status: 'FAILED' });
  const resource = store.createResource({ projectId: project.id, name: 'db', engine: 'postgresql', status: 'READY' });
  return { organization, project, service, resource };
}
const invalidService = [
  { id: 'forged' }, { projectId: 'forged' }, { name: 'other' }, { type: 'private' },
  { sourceType: 'image' }, { repoUrl: 'https://github.com/fixture/other' }, { image: 'other:1' },
  { status: 'READY' }, { deletionRequestedAt: '2026-01-01' }, { desiredState: { status: 'READY' } },
  { desiredSpec: { repoUrl: 'https://github.com/fixture/other' } }, { githubRepositoryId: '42' },
  { mutation: 'internal' }, { allowGitHubBinding: true }, { environment: { SECRET: 'injected' } },
  { port: 0 }, { port: 65536 }, { port: 3.5 }, { port: '4200' },
  ...['../outside', '/etc/passwd', 'C:\\outside', '\\\\server\\share', 'a/../../b', 'bad\u0000path'].flatMap((value) => ['rootDirectory', 'buildContext', 'dockerfilePath', 'outputDirectory'].map((key) => ({ [key]: value }))),
  { healthCheck: { path: 'https://attacker.test/' } }, { healthCheck: { path: '/ok', exec: ['sh'] } },
  { resources: { limits: { cpu: '501m' } } }, { resources: { limits: { memory: '513Mi' } } },
  { resources: { limits: { cpu: '-1' } } }, { resources: { limits: { memory: 'NaN' } } },
  { resources: { requests: { cpu: '400m' }, limits: { cpu: '300m' } } },
  { resources: { limits: { cpu: '100m' } } }, { resources: { limits: { 'nvidia.com/gpu': '1' } } },
];

test('desired-state adversarial mutation matrix: repositories reject without partial writes', async () => {
  // Given: a deployed service, immutable resource and independent stored snapshot.
  const store = new ControlPlaneStore();
  const state = seed(store);
  const outcomes = [];
  for (const [target, id, updates] of [
    ...invalidService.map((input) => ['Service', state.service.id, { branch: 'should-not-write', ...input }]),
    ...['id', 'organizationId', 'slug', 'status', 'deletionRequestedAt', 'unknown'].map((key) => ['Project', state.project.id, { name: 'should-not-write', [key]: 'forged' }]),
    ...['engine', 'provider', 'region', 'plan', 'status'].map((key) => ['Resource', state.resource.id, { [key]: 'forged' }]),
  ]) {
    const before = digest(store.snapshot());
    // When / Then: one mixed forbidden mutation rejects and changes no rows/audit.
    assert.throws(() => store[`update${target}`](id, updates), (error) => [400, 409].includes(error.statusCode), JSON.stringify(updates));
    const after = digest(store.snapshot());
    assert.equal(after, before);
    outcomes.push({ target, updates, before, after, unchanged: true });
  }
  await capture('atomicity', outcomes);
});

test('desired-state editable happy path: five workload types compile deterministically', async () => {
  // Given
  const store = new ControlPlaneStore();
  const { project, organization } = seed(store);
  const services = [];
  for (const type of fixture.serviceTypes) {
    const created = store.createService({ projectId: project.id, name: `service-${type}`, type, sourceType: 'github', repoUrl: 'https://github.com/fixture/original', schedule: '0 * * * *' });
    store.createDeployment({ projectId: project.id, serviceId: created.id, status: 'FAILED' });
    // When
    const updated = store.updateService(created.id, fixture.editable);
    // Then
    for (const [key, value] of Object.entries(fixture.editable)) assert.deepEqual(updated[key], value, key);
    assert.equal(updated.type, type);
    services.push(updated);
  }
  const projectAfter = store.updateProject(project.id, { name: 'Display only', description: 'Task 12' });
  assert.equal(projectAfter.slug, project.slug);
  const input = { organization, project: projectAfter, services };
  const files = Object.fromEntries(services.map((service) => [service.name, fixture.files]));
  const first = compileProject(input, files);
  const second = compileProject(input, files);
  assert.equal(digest(first), digest(second));
  assert.ok(first.buildPlans.every((plan) => plan.mode === 'dockerfile'));
  const deployment = first.manifests.find((manifest) => manifest.kind === 'Deployment');
  const container = deployment.spec.template.spec.containers[0];
  assert.equal(container.ports[0].containerPort, 4200);
  assert.equal(container.readinessProbe.httpGet.path, '/health/ready');
  assert.equal(container.livenessProbe.httpGet.path, '/health/ready');
  assert.equal(container.resources.requests.cpu, '200m');
  assert.equal(container.resources.limits.memory, '512Mi');
  await capture('compiled-1', first); await capture('compiled-2', second);
  await capture('compile-digests', { first: digest(first), second: digest(second) });
  await capture('desired-state', input);
});

test('desired-state adversarial mutation matrix: repository Dockerfile cannot be bypassed', async () => {
  // Given / When / Then
  const decisions = [];
  for (const buildMode of ['auto', 'custom', 'buildpack', 'prebuilt-image']) {
    const plan = resolveBuildStrategy({ name: 'api', sourceType: 'github', buildMode, image: 'old:1', buildCommand: 'pnpm build', rootDirectory: 'apps/api' }, fixture.files);
    assert.equal(plan.mode, 'dockerfile');
    decisions.push({ buildMode, selected: plan.mode });
  }
  assert.equal(resolveBuildStrategy({ name: 'image', sourceType: 'image', image: 'app:1' }, fixture.files).mode, 'prebuilt-image');
  await capture('build-selection', decisions);
});

test('desired-state adversarial mutation matrix: real Nest and thin HTTP parity', async () => {
  const nest = await bootParityApi();
  const thinControl = new RAIBITSERVERControlPlane();
  const secret = 'local-semantic-parity-test-secret-only';
  const thin = http.createServer(createApiHandler(thinControl, { auth: { mode: 'jwt', jwtSecret: secret } }));
  thin.listen(0, '127.0.0.1'); await once(thin, 'listening');
  const outcomes = [];
  try {
    for (const [adapter, store, base] of [['nest', nest.repository.store, nest.baseUrl], ['thin', thinControl.store, `http://127.0.0.1:${thin.address().port}`]]) {
      const state = seed(store);
      const user = store.createUser({ email: `${adapter}@example.test`, approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER' });
      store.addMember({ organizationId: state.organization.id, userId: user.id, role: 'OWNER' });
      const token = signJwtHs256({ sub: user.id, role: 'OWNER', organizationId: state.organization.id }, secret);
      const request = async (route, body, bearer = token) => {
        const response = await fetch(`${base}${route}`, { method: body ? 'PATCH' : 'GET', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
      };
      for (const body of [{ name: 'no-partial', organizationId: 'forged' }, { name: 'no-partial', status: 'DELETED' }]) {
        const before = digest(store.getProject(state.project.id));
        const result = await request(`/projects/${state.project.id}`, body);
        assert.ok([400, 409].includes(result.status), `${adapter}: ${JSON.stringify(result)}`);
        assert.equal(digest(store.getProject(state.project.id)), before);
        outcomes.push({ adapter, body, result, unchanged: true });
      }
      for (const body of invalidService) {
        const before = digest(store.getService(state.service.id));
        const result = await request(`/services/${state.service.id}`, { branch: 'no-partial', ...body });
        assert.ok([400, 409].includes(result.status), `${adapter}: ${JSON.stringify(body)}: ${JSON.stringify(result)}`);
        assert.equal(digest(store.getService(state.service.id)), before);
        outcomes.push({ adapter, body, result, unchanged: true });
      }
      const happy = await request(`/services/${state.service.id}`, fixture.editable);
      assert.equal(happy.status, 200);
      const readback = await request(`/services/${state.service.id}`);
      for (const [key, value] of Object.entries(fixture.editable)) assert.deepEqual(readback.body[key], value, `${adapter}: ${key}`);
      outcomes.push({ adapter, happy, readback });
      store.setQuota({ userId: user.id, maxCpuMillicores: 2000, maxMemoryMb: 2048 });
      const high = await request(`/services/${state.service.id}`, { resources: { limits: { cpu: '2', memory: '2Gi' } } });
      assert.equal(high.status, 200, JSON.stringify(high));
      const low = store.createUser({ email: `${adapter}-low@example.test`, approvalStatus: 'APPROVED' });
      store.addMember({ organizationId: state.organization.id, userId: low.id, role: 'OWNER' });
      store.setQuota({ userId: low.id, maxCpuMillicores: 500, maxMemoryMb: 512 });
      const lowToken = signJwtHs256({ sub: low.id, role: 'OWNER', organizationId: state.organization.id }, secret);
      const denied = await request(`/services/${state.service.id}`, { resources: { requests: { cpu: '1' } } }, lowToken);
      assert.equal(denied.status, 400);
      outcomes.push({ adapter, highQuota: high, lowQuota: denied });
      const projectHappy = await request(`/projects/${state.project.id}`, { name: 'Visible name', description: 'Visible description' });
      assert.equal(projectHappy.status, 200);
      for (const key of ['engine', 'provider', 'region', 'plan', 'status', 'deletionRequestedAt']) {
        const before = digest(store.getResource(state.resource.id));
        const result = await request(`/resources/${state.resource.id}`, { [key]: 'forged' });
        assert.ok([400, 409].includes(result.status));
        assert.equal(digest(store.getResource(state.resource.id)), before);
        outcomes.push({ adapter, resourceField: key, result, unchanged: true });
      }
    }
  } finally { await nest.app.close(); await new Promise((resolve) => thin.close(resolve)); await capture('http', { outcomes, cleanup: !thin.listening }); }
});

test('desired-state adversarial mutation matrix: Prisma rejects deployed identity before update', async () => {
  // Given: adapter contract fake, not a live PostgreSQL claim.
  let row = { id: 'service', projectId: 'project', name: 'web', type: 'web', sourceType: 'github', status: 'FAILED', desiredState: fixture.editable };
  let writes = 0;
  const tx = { service: { findUnique: async () => structuredClone(row), update: async ({ data }) => { writes++; row = { ...row, ...data }; return row; } }, project: { findUnique: async () => ({ id: 'project', status: 'ACTIVE' }) }, deployment: { findFirst: async () => ({ id: 'first', status: 'FAILED' }) } };
  const repository = new PrismaControlPlaneRepository({ ...tx, $transaction: async (operation) => operation(tx) });
  // When / Then
  await assert.rejects(() => repository.updateService('service', { branch: 'no-partial', name: 'renamed' }), (error) => error.statusCode === 409);
  assert.equal(writes, 0);
  const updated = await repository.updateService('service', fixture.editable);
  for (const [key, value] of Object.entries(fixture.editable)) assert.deepEqual(updated.desiredState[key], value, key);
  await capture('prisma-contract', { writes, row, rejectedBeforeWrite: true, truth: 'L1 adapter fake' });
});

test('desired-state adversarial mutation matrix: upsert cannot reset a deployed source', async () => {
  // Given
  const store = new ControlPlaneStore();
  const { organization, project, service } = seed(store);
  const repository = new InMemoryControlPlaneRepository(store);
  const before = digest(store.snapshot());
  // When / Then
  assert.throws(() => store.createService({ projectId: project.id, name: service.name, sourceType: 'image', image: 'forged:1' }), (error) => error.statusCode === 409);
  await assert.rejects(() => repository.writeDesiredProject({ organizationId: organization.id, name: project.name, slug: project.slug, services: [{ name: service.name, sourceType: 'image', image: 'forged:1' }] }), (error) => error.statusCode === 409);
  assert.equal(digest(store.snapshot()), before);
  await capture('upsert-boundary', { before, after: digest(store.snapshot()) });
});

test('desired-state editable happy path: partial resources and trusted runtime remain distinct', async () => {
  // Given
  const store = new ControlPlaneStore(); const { service } = seed(store);
  // When / Then
  const changed = store.updateService(service.id, { resources: { requests: { cpu: '0.3' } } });
  assert.deepEqual(changed.resources, { requests: { cpu: '0.3', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } });
  assert.throws(() => store.updateService(service.id, { imageUrl: 'forged:1' }), (error) => error.statusCode === 409);
  const runtime = store.updateService(service.id, { status: 'ready', imageUrl: 'registry.test/app@sha256:verified' }, { mutation: INTERNAL_SERVICE_MUTATION });
  assert.equal(runtime.status, 'ready'); assert.equal(runtime.image, runtime.imageUrl);
  await capture('trusted-runtime', { resources: changed.resources, runtime });
});

test('desired-state public PATCH schemas reject hidden and invalid fields', () => {
  // Given / When / Then
  assert.equal(ProjectUpdateSchema.safeParse({ name: 'okay', organizationId: 'forged' }).success, false);
  assert.equal(ServiceUpdateSchema.safeParse(fixture.editable).success, true);
  for (const body of invalidService.filter((entry) => !('name' in entry) && !('type' in entry) && !('resources' in entry && /100m|501m|513Mi/.test(JSON.stringify(entry))))) assert.equal(ServiceUpdateSchema.safeParse(body).success, false, JSON.stringify(body));
});

test('desired-state editable happy path: actor quota and retained higher settings', async () => {
  // Given: two members of one project with different operator-set quotas.
  const store = new ControlPlaneStore(); const { organization, service } = seed(store);
  const high = store.createUser({ email: 'high@example.test', approvalStatus: 'APPROVED' });
  const low = store.createUser({ email: 'low@example.test', approvalStatus: 'APPROVED' });
  for (const user of [high, low]) store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  store.setQuota({ userId: high.id, maxCpuMillicores: 2000, maxMemoryMb: 2048 });
  store.setQuota({ userId: low.id, maxCpuMillicores: 500, maxMemoryMb: 512 });
  // When / Then
  const increased = store.updateService(service.id, { resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } } }, { actorUserId: high.id });
  const before = digest(store.snapshot());
  assert.throws(() => store.updateService(service.id, { resources: { requests: { cpu: '1.5' } } }, { actorUserId: low.id }), (error) => error.statusCode === 400);
  assert.equal(digest(store.snapshot()), before);
  const unrelated = store.updateService(service.id, { port: 8081 }, { actorUserId: low.id });
  assert.deepEqual(unrelated.resources, increased.resources);
  const reduced = store.updateService(service.id, { resources: { limits: { cpu: '1.5' } } }, { actorUserId: low.id });
  assert.equal(reduced.resources.limits.cpu, '1.5'); assert.equal(reduced.resources.limits.memory, '2Gi');
  for (const quota of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2000']) {
    store.setQuota({ userId: low.id, maxCpuMillicores: quota });
    const beforeInvalid = digest(store.snapshot());
    assert.throws(() => store.updateService(service.id, { resources: { requests: { cpu: '1.2' } } }, { actorUserId: low.id }), (error) => error.statusCode === 400);
    assert.equal(digest(store.snapshot()), beforeInvalid);
  }
  await capture('actor-quota', { increased, unrelated, reduced, lowActorRejected: true });
});

test('desired-state adversarial mutation matrix: explicit attach cannot replace deployed source', async () => {
  // Given: a deployed service without a verified repository binding.
  const store = new ControlPlaneStore(); const { organization, project, service } = seed(store);
  const integration = store.createGitHubIntegration({ organizationId: organization.id, accountLogin: 'fixture', installationId: 'installation' });
  store.verifyGitHubIntegration({ integrationId: integration.id, installationId: 'installation', accountLogin: 'fixture', verifiedBy: 'github-app-callback' });
  store.registerGitHubRepository({ installationId: 'installation', githubRepoId: '42', fullName: 'fixture/replacement', private: true });
  const before = digest(store.snapshot());
  // When / Then
  assert.throws(() => store.attachGitHubRepositoryToService({ projectId: project.id, serviceId: service.id, integrationId: integration.id, repositoryId: '42' }), (error) => error.statusCode === 409);
  assert.equal(digest(store.snapshot()), before);
  const verified = { ...integration, verifiedAt: '2026-01-01', installationId: 'installation' };
  const tx = {
    project: { findUnique: async () => project }, service: { findUnique: async () => ({ ...service, project }), upsert: async () => { throw new Error('unexpected write'); } },
    deployment: { findFirst: async () => ({ id: 'first' }) },
    gitHubIntegration: { findUnique: async () => verified },
    gitHubRepository: { findMany: async () => [{ installationId: 'installation', githubRepoId: '42', fullName: 'fixture/replacement', defaultBranch: 'main', private: true }] },
  };
  const prisma = new PrismaControlPlaneRepository({ ...tx, $transaction: async (callback) => callback(tx) });
  const input = { projectId: project.id, serviceId: service.id, serviceName: service.name, integrationId: integration.id, repositoryId: '42' };
  await assert.rejects(() => prisma.attachGitHubRepositoryToService(input), (error) => error.statusCode === 409);
  await assert.rejects(() => prisma.importGitHubRepository(input), (error) => error.statusCode === 409);
  await capture('source-replacement', { memoryAttach: 'rejected', prismaAttach: 'rejected', prismaImport: 'rejected', truth: 'L1 adapter fake' });
});

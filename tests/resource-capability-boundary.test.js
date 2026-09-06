import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { hashPassword } from '../packages/core/src/identity.ts';
import { bootParityApi } from './fixtures/api-parity-runtime.mjs';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { createRequire } from 'node:module';
import { providerOwnedSqlitePath } from '../packages/core/src/resource-sanitizer.ts';

const databaseUrl = process.env.RAIBITSERVER_TEST_DATABASE_URL;
if (process.env.RAIBITSERVER_REQUIRE_POSTGRES_TESTS === '1' && !databaseUrl) throw new Error('RAIBITSERVER_TEST_DATABASE_URL is required for task 13 PostgreSQL verification');

const engines = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey'];
const configuredKeys = ['RAIBITSERVER_RESOURCE_ENVIRONMENT', ...engines.map(engine => `RAIBITSERVER_PROVIDER_${engine.toUpperCase()}_IMAGE`)];
const original = Object.fromEntries(configuredKeys.map(key => [key, process.env[key]]));
test.beforeEach(() => {
  process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT = 'local';
  for (const engine of engines) process.env[`RAIBITSERVER_PROVIDER_${engine.toUpperCase()}_IMAGE`] = `registry.example.test/${engine}@sha256:${'a'.repeat(64)}`;
});
test.after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture() {
  const store = new ControlPlaneStore();
  const org = store.createOrganization({ name: 'Boundary', slug: 'boundary' });
  const project = store.createProject({ organizationId: org.id, name: 'Boundary', slug: 'boundary' });
  return { store, project };
}

test('resource-local fallback slugs keep distinct Korean names separate without changing existing identity', () => {
  const { store, project } = fixture();
  const first = store.createResource({ projectId: project.id, name: '프로비저닝 검증', engine: 'postgresql' });
  const second = store.createResource({ projectId: project.id, name: '브라우저 생성 검증', engine: 'mysql' });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.slug, second.slug);
  assert.match(first.slug, /^resource-[a-f0-9]{20}$/);
  assert.equal(store.createResource({ projectId: project.id, name: first.name, engine: first.engine }).slug, first.slug);
  store.resources.get(first.id).slug = 'historical-slug';
  assert.equal(store.createResource({ projectId: project.id, name: first.name, engine: first.engine }).slug, 'historical-slug');
  store.resources.set('historical-resource-id', { ...first, id: 'historical-resource-id', name: '이전 리소스', slug: 'historical-route' });
  const historical = store.createResource({ projectId: project.id, name: '이전 리소스', engine: 'postgresql' });
  assert.equal(historical.id, 'historical-resource-id');
  assert.equal(historical.slug, 'historical-route');
  assert.equal(store.createResource({ projectId: project.id, name: 'normal-resource', engine: 'postgresql' }).slug, 'normal-resource');
  assert.equal(store.createResource({ projectId: project.id, name: '명시 이름', slug: 'explicit-slug', engine: 'postgresql' }).slug, 'explicit-slug');
  const sqlite = store.createResource({ projectId: project.id, name: '이전 파일', engine: 'sqlite' });
  const customPath = providerOwnedSqlitePath('historical-custom-file');
  Object.assign(store.resources.get(sqlite.id), { sqlitePath: customPath, desiredSpec: { sqlitePath: customPath }, status: 'provisioning' });
  assert.equal(store.createResource({ projectId: project.id, name: sqlite.name, engine: 'sqlite' }).sqlitePath, customPath);
});

test('real PostgreSQL Korean resource names have distinct slugs matching memory', { skip: !databaseUrl }, async () => {
  const repository = await PrismaControlPlaneRepository.connect({ env: { ...process.env, DATABASE_URL: databaseUrl }, prismaOptions: { datasourceUrl: databaseUrl } });
  let org;
  try {
    org = await repository.createOrganization({ name: 'Task13 Korean names', slug: 'task13-korean-' + Date.now() });
    const project = await repository.createProject({ organizationId: org.id, name: 'Task13 Korean names', slug: 'task13-korean' });
    const memory = fixture();
    const rows = [];
    for (const name of ['프로비저닝 검증', '브라우저 생성 검증']) {
      const row = await repository.createResource({ projectId: project.id, name, engine: 'sqlite' });
      const local = memory.store.createResource({ projectId: memory.project.id, name, engine: 'sqlite' });
      assert.equal(row.slug, local.slug);
      rows.push(row);
    }
    assert.notEqual(rows[0].id, rows[1].id);
    assert.notEqual(rows[0].slug, rows[1].slug);
    assert.notEqual(rows[0].desiredSpec.sqlitePath, rows[1].desiredSpec.sqlitePath);
    assert.equal(await repository.prisma.resource.count({ where: { projectId: project.id } }), 2);
    const customPath = providerOwnedSqlitePath('historical-custom-pg-file');
    await repository.prisma.resource.update({ where: { id: rows[0].id }, data: { slug: 'historical-slug', desiredSpec: { ...rows[0].desiredSpec, sqlitePath: customPath } } });
    const repeated = await repository.createResource({ projectId: project.id, name: rows[0].name, engine: 'sqlite' });
    assert.equal(repeated.id, rows[0].id);
    assert.equal(repeated.slug, 'historical-slug');
    assert.equal(repeated.desiredSpec.sqlitePath, customPath);
    await repository.writeDesiredProject({ organizationId: org.id, project: { name: project.name, slug: project.slug }, resources: [{ name: rows[0].name, engine: 'sqlite' }] });
    const imported = await repository.getResource(rows[0].id);
    assert.equal(imported.id, rows[0].id);
    assert.equal(imported.slug, 'historical-slug');
    assert.equal(imported.desiredSpec.sqlitePath, customPath);
    console.log('KOREAN_RESOURCE_OUTCOME rows=2 distinctSlugs=true memoryParity=true existingIdentityPreserved=true');
  } finally { if (org) await repository.prisma.organization.delete({ where: { id: org.id } }); await repository.prisma.$disconnect(); }
});

test('authorized supported-resource boundary: preview returns a plan without mutating the resource or queue', async () => {
  // Given a persisted local live request.
  const { store, project } = fixture();
  const resource = store.createResource({ projectId: project.id, name: 'pg', engine: 'postgresql' });
  const before = store.snapshot();
  // When preview is explicitly selected.
  const response = await store.provisionResourceProvider({ resourceId: resource.id, intent: 'preview-plan' });
  // Then it is not an execution or a persistence operation.
  assert.deepEqual(store.snapshot(), before);
  assert.equal(response.result.intent, 'preview-plan');
  assert.equal(response.result.dryRun, true);
  assert.notEqual(response.result.status, 'READY');
  assert.ok(response.result.plan);
});

test('authorized supported-resource boundary: local live request records only server-owned execution intent', async () => {
  const { store, project } = fixture();
  const resource = store.createResource({ projectId: project.id, name: 'pg', engine: 'postgresql', desiredState: { resourceExecution: { intent: 'preview-plan', environment: 'release' } } });
  const response = await store.provisionResourceProvider({ resourceId: resource.id, intent: 'live-provision' });
  assert.equal(response.result.intent, 'live-provision');
  assert.equal(response.result.dryRun, false);
  assert.equal(response.resource.desiredState.resourceExecution.intent, 'live-provision');
  assert.equal(response.resource.desiredState.resourceExecution.environment, 'local');
  assert.notEqual(response.resource.status.toUpperCase(), 'READY');
  assert.equal(store.snapshot().workflowJobs.length, 0);
});

test('forged unsupported-resource matrix: direct persistence rejects unsupported engines before mutation', () => {
  const { store, project } = fixture();
  for (const engine of ['object-storage', 'qdrant', 'nats', 'vector-db', 'message-queue']) {
    const before = store.snapshot();
    assert.throws(() => store.createResource({ projectId: project.id, name: engine, engine }), { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
    assert.deepEqual(store.snapshot(), before);
  }
});

test('forged unsupported-resource matrix: trusted release and missing images reject before persistence', () => {
  const { store, project } = fixture();
  for (const environment of ['release', 'invalid', undefined]) {
    if (environment === undefined) delete process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT;
    else process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT = environment;
    for (const engine of [...engines, 'sqlite']) {
      assert.throws(() => store.createResource({ projectId: project.id, name: engine, engine, environment: 'local', region: 'local' }), { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
    }
  }
  process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT = 'local';
  for (const engine of engines) {
    delete process.env[`RAIBITSERVER_PROVIDER_${engine.toUpperCase()}_IMAGE`];
    assert.throws(() => store.createResource({ projectId: project.id, name: engine, engine }), { code: 'RESOURCE_CAPABILITY_UNAVAILABLE' });
  }
  assert.equal(store.snapshot().resources.length, 0);
  assert.equal(store.snapshot().workflowJobs.length, 0);
});

test('forged unsupported-resource matrix: ambiguous intent and caller READY never become a plan success', async () => {
  const { store, project } = fixture();
  const resource = store.createResource({ projectId: project.id, name: 'pg', engine: 'postgresql' });
  for (const input of [{}, { dryRun: 'false' }, { intent: ['preview-plan', 'live-provision'] }, { intent: 'preview-plan', dryRun: false }, { intent: 'preview-plan', status: 'READY' }]) {
    const before = store.snapshot();
    await assert.rejects(() => store.provisionResourceProvider({ resourceId: resource.id, ...input }));
    assert.deepEqual(store.snapshot(), before);
  }
});

test('forged unsupported-resource matrix: real Nest returns typed capability rejection without persisting', async () => {
  const runtime = await bootParityApi();
  try {
    const user = runtime.repository.store.createUser({ name: 'Boundary', email: 'boundary@example.test', passwordHash: hashPassword('boundary-password'), role: 'ADMIN', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER' });
    const org = runtime.repository.store.createOrganization({ name: 'Boundary', slug: 'boundary' });
    runtime.repository.store.addMember({ userId: user.id, organizationId: org.id, role: 'owner' });
    const project = runtime.repository.store.createProject({ organizationId: org.id, name: 'Boundary', slug: 'boundary' });
    const login = await fetch(`${runtime.baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'boundary-password' }) });
    assert.equal(login.status, 201);
    const { token } = await login.json();
    const response = await fetch(`${runtime.baseUrl}/projects/${project.id}/resources`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'forged', engine: 'qdrant' }) });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'RESOURCE_CAPABILITY_UNAVAILABLE');
    assert.equal(runtime.repository.store.snapshot().resources.length, 0);
    assert.equal(runtime.repository.store.snapshot().workflowJobs.length, 0);
  } finally {
    await runtime.app.close();
  }
});

test('real Nest and PostgreSQL enforce stateless preview and trusted live capability before writes', { skip: !databaseUrl }, async () => {
  const repository = await PrismaControlPlaneRepository.connect({ env: { ...process.env, DATABASE_URL: databaseUrl }, prismaOptions: { datasourceUrl: databaseUrl } });
  const runtime = await bootParityApi();
  const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { RAIBITSERVERService } = apiRequire('./src/raibitserver.service.ts');
  runtime.app.get(RAIBITSERVERService).repositoryPromise = Promise.resolve(repository);
  const suffix = `t13-${Date.now()}`;
  let org, user;
  try {
    user = await repository.createUser({ name: 'Task 13', email: `${suffix}@example.test`, passwordHash: hashPassword('task13-fixture-password'), role: 'ADMIN', approvalStatus: 'APPROVED', accountType: 'CLUB_MEMBER' });
    org = await repository.createOrganization({ name: 'Task 13', slug: suffix });
    await repository.addMember({ userId: user.id, organizationId: org.id, role: 'owner' });
    const project = await repository.createProject({ organizationId: org.id, name: 'Boundary', slug: suffix, actorUserId: user.id });
    const login = await fetch(`${runtime.baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'task13-fixture-password' }) });
    assert.equal(login.status, 201);
    const { token } = await login.json();
    const request = async (path, body) => {
      const response = await fetch(`${runtime.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const snapshot = async () => ({ resources: await repository.prisma.resource.findMany({ where: { projectId: project.id } }), audits: await repository.prisma.auditLog.findMany({ where: { actorUserId: user.id }, orderBy: { id: 'asc' } }), jobs: await repository.prisma.workflowJob.count() });
    for (const engine of [...engines, 'sqlite']) {
      const created = await request(`/projects/${project.id}/resources`, { name: engine, engine, desiredState: { resourceExecution: { intent: 'preview-plan', environment: 'release' } } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.desiredState.resourceExecution.intent, 'live-provision');
      assert.equal(created.body.desiredState.resourceExecution.environment, 'local');
      const before = await snapshot();
      const preview = await request(`/resources/${created.body.id}/provision`, { intent: 'preview-plan' });
      assert.equal(preview.status, 201, JSON.stringify(preview.body));
      assert.equal(preview.body.result.status, 'PLAN_ONLY');
      assert.deepEqual(await snapshot(), before);
      const live = await request(`/resources/${created.body.id}/provision`, { intent: 'live-provision' });
      assert.equal(live.status, 201, JSON.stringify(live.body));
      assert.equal(live.body.result.status, 'PROVISIONING');
      assert.notEqual(live.body.resource.status, 'READY');
    }
    for (const engine of ['object-storage', 'qdrant', 'nats', 'vector-db', 'message-queue']) {
      const before = await snapshot();
      const response = await request(`/projects/${project.id}/resources`, { name: engine, engine });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'RESOURCE_CAPABILITY_UNAVAILABLE');
      assert.deepEqual(await snapshot(), before);
    }
    for (const environment of ['release', 'invalid', undefined]) {
      if (environment === undefined) delete process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT;
      else process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT = environment;
      const before = await snapshot();
      const response = await request(`/projects/${project.id}/resources`, { name: 'denied', engine: 'postgresql', environment: 'local' });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'RESOURCE_CAPABILITY_UNAVAILABLE');
      assert.deepEqual(await snapshot(), before);
    }
    process.env.RAIBITSERVER_RESOURCE_ENVIRONMENT = 'local';
    delete process.env.RAIBITSERVER_PROVIDER_POSTGRESQL_IMAGE;
    const before = await snapshot();
    const missingImage = await request(`/projects/${project.id}/resources`, { name: 'missing-image', engine: 'postgresql' });
    assert.equal(missingImage.status, 400);
    assert.equal(missingImage.body.reasonCode, 'PROVIDER_IMAGE_UNAVAILABLE');
    assert.deepEqual(await snapshot(), before);
    console.log('TASK13_PG: seven local creates/live requests; seven stateless previews; unsupported/release/invalid/unset/missing-image zero writes; zero fake READY');
  } finally {
    await runtime.app.close();
    if (org) await repository.prisma.organization.delete({ where: { id: org.id } });
    if (user) await repository.prisma.user.delete({ where: { id: user.id } });
    await repository.prisma.$disconnect();
  }
});

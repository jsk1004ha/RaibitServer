import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../../packages/core/src/persistence.ts';

test('dev repository updates retain logical identity and enforce aggregate runtime quota', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Runtime refresh', slug: 'runtime-refresh' });
  const user = await repository.createUser({ email: 'runtime-refresh@example.test', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
  await repository.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  repository.store.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxProjects: 5, maxServices: 5, maxCpuMillicores: 300, maxMemoryMb: 1024, maxObjectStorageMb: 1024 });
  const project = await repository.createProject({ organizationId: organization.id, name: 'Trainer' });
  const dev = await repository.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  const service = await repository.createService({ projectId: project.id, environmentId: dev.id, actorUserId: user.id, name: 'Trainer', type: 'worker', persistence: { sizeGi: 1, mountPath: '/data' }, resources: { requests: { cpu: '250m' }, limits: { cpu: '500m' } } });
  const physicalSlug = repository.store.services.get(service.id).slug;
  await assert.rejects(repository.updateService(service.id, { resources: { requests: { cpu: '400m' } } }, { actorUserId: user.id }), /quota exceeded: maxCpuMillicores/);
  const result = await repository.updateService(service.id, { branch: 'develop' }, { actorUserId: user.id });
  assert.equal(result.environmentId, dev.id);
  assert.equal(result.slug, 'trainer');
  assert.equal(repository.store.services.get(service.id).slug, physicalSlug);
  assert.equal(result.updatedAt, repository.store.services.get(service.id).updatedAt);
  assert.deepEqual(result.desiredSpec.persistence, { sizeGi: 1, mountPath: '/data' });
  const renamed = await repository.updateService(service.id, { name: 'Training worker' }, { actorUserId: user.id });
  assert.equal(renamed.name, 'Training worker');
  assert.equal((await repository.getServiceSettings(service.id)).settings.name, 'Training worker');
  const preview = await repository.previewServiceSettings(service.id, { expectedUpdatedAt: renamed.updatedAt, changes: { name: 'Training worker v2' } });
  assert.deepEqual(preview.diff.find(change => change.field === 'name'), { field: 'name', before: 'Training worker', after: 'Training worker v2' });
  assert.equal((await repository.getService(service.id)).name, 'Training worker');
  const saved = await repository.updateServiceSettings(service.id, { expectedUpdatedAt: renamed.updatedAt, changes: { name: 'Training worker v2' } });
  assert.equal(saved.settings.name, 'Training worker v2');
  assert.equal(repository.store.services.get(service.id).name, 'Trainer');
  assert.equal(repository.store.services.get(service.id).slug, physicalSlug);
  await assert.rejects(repository.updateService(service.id, { name: 'Invalid rename', type: 'cron' }), /persistence/i);
  assert.equal((await repository.getService(service.id)).name, 'Training worker v2');
  await assert.rejects(repository.deleteService(service.id), /persistent service storage requires project deletion/);
});

test('resource environment projection preserves resource timestamps over binding timestamps', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Resource timestamp', slug: 'resource-timestamp' });
  const project = await repository.createProject({ organizationId: organization.id, name: 'Project' });
  const resource = await repository.createResource({ projectId: project.id, name: 'Database', engine: 'postgresql', provider: 'local', storageMb: 1024 });
  const stored = repository.store.resources.get(resource.id);
  stored.updatedAt = '2026-09-30T10:00:00.000Z';
  repository.store.environmentResources.get(resource.id).updatedAt = '2026-09-30T09:00:00.000Z';
  assert.equal((await repository.getResource(resource.id)).updatedAt, stored.updatedAt);
});

// These boundaries record actual Prisma method commands; they do not simulate
// PostgreSQL constraints, isolation, commit, or rollback.
function serviceCommands({ persistent = false } = {}) {
  const environment = { id: 'dev-environment', projectId: 'project', kind: 'dev' };
  const binding = { environmentId: environment.id, projectId: 'project', serviceId: 'service', logicalSlug: 'trainer', displayName: 'Trainer', environment };
  const persistence = persistent ? { persistence: { sizeGi: 1, mountPath: '/data' } } : {};
  let row = { id: 'service', projectId: 'project', name: 'Trainer', slug: 'dev-physical-trainer', type: 'worker', sourceType: 'image', image: 'example/trainer:v1', status: 'created', updatedAt: '2026-09-30T00:00:00.000Z', desiredSpec: { ...persistence }, desiredState: { ...persistence }, environmentBinding: binding };
  const commands = [];
  const tx = {
    async $executeRawUnsafe(sql) { commands.push({ operation: 'protocol', sql }); },
    project: { async findUnique() { return { id: 'project', status: 'ACTIVE' }; } },
    environment: { async findFirst() { return environment; } },
    environmentService: {
      async findUnique() { return binding; },
      async update({ data }) { commands.push({ operation: 'binding-update', data }); Object.assign(binding, data); },
    },
    service: {
      async findUnique() { return structuredClone(row); },
      async update({ data }) { commands.push({ operation: 'service-update', data }); row = { ...row, ...data }; return row; },
      async updateMany({ data }) { commands.push({ operation: 'service-update', data }); row = { ...row, ...data }; return { count: 1 }; },
    },
    deployment: { async findFirst() { return null; } },
    auditLog: { async create() {} },
  };
  const repository = new PrismaControlPlaneRepository({ ...tx, async $transaction(work, options) { commands.push({ operation: 'transaction', options }); return work(tx); } });
  return { repository, commands, environment, stored: () => row };
}

test('Prisma dev service re-admission preserves persistent desired state', async () => {
  const { repository, environment, stored } = serviceCommands({ persistent: true });
  const result = await repository.createService({ projectId: 'project', environmentId: environment.id, name: 'Trainer', type: 'worker', branch: 'develop' });
  assert.equal(result.slug, 'trainer');
  assert.equal(result.environmentId, environment.id);
  assert.deepEqual(result.desiredSpec.persistence, { sizeGi: 1, mountPath: '/data' });
  assert.deepEqual(stored().desiredState.persistence, { sizeGi: 1, mountPath: '/data' });
});

for (const method of ['updateService', 'updateServiceSettings']) test(`Prisma dev ${method} returns its display name and rejects invalid persistent mutations`, async () => {
  const { repository, commands, stored } = serviceCommands({ persistent: true });
  const beforeUpdatedAt = stored().updatedAt;
  const changes = { name: 'Renamed trainer' };
  const input = method === 'updateService' ? changes : { expectedUpdatedAt: stored().updatedAt, changes };
  const result = await repository[method]('service', input);
  assert.equal(method === 'updateService' ? result.name : result.settings.name, 'Renamed trainer');
  assert.equal(stored().slug, 'dev-physical-trainer');
  assert.equal(stored().name, 'Trainer');
  assert.ok(new Date(stored().updatedAt) > new Date(beforeUpdatedAt));
  assert.ok(commands.find(command => command.operation === 'service-update').data.updatedAt instanceof Date);
  assert.deepEqual(commands.find(command => command.operation === 'transaction').options, { isolationLevel: 'Serializable' });
  assert.ok(commands.some(command => command.operation === 'protocol' && command.sql === "SET LOCAL raibitserver.operational_protocol = '2'"));
  const persistent = serviceCommands({ persistent: true });
  const invalid = method === 'updateService' ? { type: 'cron' } : { expectedUpdatedAt: persistent.stored().updatedAt, changes: { type: 'cron' } };
  await assert.rejects(persistent.repository[method]('service', invalid), /persistence/i);
  assert.equal(persistent.commands.filter(command => command.operation === 'service-update' || command.operation === 'binding-update').length, 0);
});

test('Prisma desired-state writer creates prod environment bindings inside the protocol-2 transaction', async () => {
  const commands = [];
  const tx = {
    async $executeRawUnsafe() { commands.push('protocol'); },
    organization: { async findUnique() { return { id: 'organization' }; } },
    project: {
      async findUnique() { return null; },
      async upsert({ create }) { return { id: 'project', ...create }; },
    },
    environment: { async upsert(input) { commands.push(['environment', input]); return input.create; } },
    service: {
      async findUnique() { return null; },
      async upsert({ create }) { return { id: 'service', ...create }; },
    },
    resource: {
      async findUnique() { return null; },
      async upsert({ create }) { return { id: 'resource', ...create }; },
    },
    environmentService: { async upsert(input) { commands.push(['service-binding', input]); } },
    environmentResource: { async upsert(input) { commands.push(['resource-binding', input]); } },
    auditLog: { async create() {} },
  };
  const repository = new PrismaControlPlaneRepository({ async $transaction(work) { const result = await work(tx); commands.push('return'); return result; } });
  const result = await repository.writeDesiredProject({ organizationId: 'organization', name: 'Project', services: [{ name: 'Web', sourceType: 'image', image: 'example/web:v1' }], resources: [{ name: 'Database', engine: 'postgresql', provider: 'local', storageMb: 1024 }] });
  assert.deepEqual(commands.map(command => Array.isArray(command) ? command[0] : command), ['protocol', 'environment', 'service-binding', 'resource-binding', 'return']);
  assert.deepEqual(commands[1][1].create, { id: 'env_prod_project', projectId: 'project', kind: 'prod', status: 'active' });
  assert.deepEqual(commands[2][1], { where: { serviceId: result.services[0].id }, update: {}, create: { environmentId: 'env_prod_project', projectId: 'project', serviceId: result.services[0].id, logicalSlug: result.services[0].slug, displayName: result.services[0].name } });
  assert.deepEqual(commands[3][1], { where: { resourceId: result.resources[0].id }, update: {}, create: { environmentId: 'env_prod_project', projectId: 'project', resourceId: result.resources[0].id, logicalSlug: result.resources[0].slug, displayName: result.resources[0].name } });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { serviceStorageMb } from '../packages/core/src/store-helpers.ts';

function approvedRepository(limits = {}) {
  const repository = new InMemoryControlPlaneRepository();
  const organization = repository.store.createOrganization({ name: 'Runtime Quota', slug: 'runtime-quota' });
  const user = repository.store.createUser({
    email: 'runtime-quota@example.test',
    name: 'Runtime Quota',
    approvalStatus: 'APPROVED',
    accountType: 'NON_CLUB',
  });
  repository.store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
  repository.store.setQuota({
    userId: user.id,
    accountType: 'NON_CLUB',
    maxProjects: 5,
    maxServices: 5,
    maxCpuMillicores: 500,
    maxMemoryMb: 512,
    maxObjectStorageMb: 1024,
    ...limits,
  });
  const project = repository.store.createProject({ organizationId: organization.id, name: 'Trainer', slug: 'trainer' });
  return { repository, user, project };
}

test('persistent service storage is charged to object storage quota before creation', async () => {
  const { repository, user, project } = approvedRepository({ maxObjectStorageMb: 1024 });

  await assert.rejects(
    repository.createService({
      projectId: project.id,
      actorUserId: user.id,
      name: 'too-large',
      type: 'worker',
      persistence: { sizeGi: 2, mountPath: '/data/checkpoints' },
    }),
    /quota exceeded: maxObjectStorageMb/,
  );
  assert.equal(repository.store.services.size, 0);

  const service = await repository.createService({
    projectId: project.id,
    actorUserId: user.id,
    name: 'trainer',
    type: 'worker',
    persistence: { sizeGi: 1, mountPath: '/data/checkpoints' },
  });
  assert.deepEqual(service.desiredSpec.persistence, { sizeGi: 1, mountPath: '/data/checkpoints' });
  assert.deepEqual(service.desiredState.persistence, { sizeGi: 1, mountPath: '/data/checkpoints' });
  assert.equal(repository.store.quotaUsageForUser(user.id).maxObjectStorageMb, 1024);
});

test('service storage accounting reads effective persisted runtime state', () => {
  assert.equal(serviceStorageMb({ desiredSpec: { persistence: { sizeGi: 3, mountPath: '/data/model' } } }), 3072);
  assert.equal(serviceStorageMb({ desiredState: { persistence: { sizeGi: 4, mountPath: '/data/model' } } }), 4096);
  assert.equal(serviceStorageMb({}), 0);
});

test('actor service updates enforce aggregate CPU quota atomically', async () => {
  const { repository, user, project } = approvedRepository({ maxCpuMillicores: 300 });
  const service = await repository.createService({
    projectId: project.id,
    actorUserId: user.id,
    name: 'trainer',
    type: 'worker',
    resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } },
  });

  await assert.rejects(
    repository.updateService(service.id, {
      resources: { requests: { cpu: '400m' }, limits: { cpu: '400m' } },
    }, { actorUserId: user.id }),
    /quota exceeded: maxCpuMillicores/,
  );
  assert.equal(repository.store.quotaUsageForUser(user.id).maxCpuMillicores, 250);
  assert.equal(repository.store.getService(service.id).desiredSpec.resources.requests.cpu, '250m');
});

test('partial updates cannot invalidate or replace persistent service storage', async () => {
  const { repository, user, project } = approvedRepository({ maxObjectStorageMb: 4096 });
  const service = await repository.createService({
    projectId: project.id,
    actorUserId: user.id,
    name: 'trainer',
    type: 'worker',
    persistence: { sizeGi: 1, mountPath: '/data/checkpoints' },
  });

  await assert.rejects(repository.updateService(service.id, { type: 'cron' }, { actorUserId: user.id }), /persistence/i);
  await assert.rejects(repository.updateService(service.id, { persistence: null }, { actorUserId: user.id }), /cannot be changed/i);
  assert.equal(repository.store.getService(service.id).type, 'worker');
  assert.equal(repository.store.quotaUsageForUser(user.id).maxObjectStorageMb, 1024);
});

test('updates without an actor preserve internal mutation behavior while remaining runtime-valid', async () => {
  const { repository, user, project } = approvedRepository({ maxCpuMillicores: 300 });
  const service = await repository.createService({
    projectId: project.id,
    actorUserId: user.id,
    name: 'trainer',
    type: 'worker',
    resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } },
  });

  const updated = await repository.updateService(service.id, {
    resources: { requests: { cpu: '400m' }, limits: { cpu: '400m' } },
  });
  assert.equal(updated.desiredSpec.resources.requests.cpu, '400m');
});

test('persistent services require project deletion or explicit migration before direct deletion', async () => {
  const { repository, user, project } = approvedRepository({ maxObjectStorageMb: 4096 });
  const service = await repository.createService({
    projectId: project.id,
    actorUserId: user.id,
    name: 'trainer',
    type: 'worker',
    persistence: { sizeGi: 1, mountPath: '/data/checkpoints' },
  });

  await assert.rejects(repository.deleteService(service.id), /persistent service storage requires project deletion/i);
  assert.ok(repository.store.getService(service.id));
  assert.equal(repository.store.quotaUsageForUser(user.id).maxObjectStorageMb, 1024);

  assert.ok(repository.store.deleteProject(project.id));
  assert.equal(repository.store.getService(service.id), null);
  assert.equal(repository.store.quotaUsageForUser(user.id).maxObjectStorageMb, 0);
});

test('Prisma direct deletion rejects persistent services before lifecycle mutation', async () => {
  let mutated = false;
  const prisma = {
    $transaction: async (work) => work(prisma),
    service: {
      findUnique: async () => ({
        id: 'service-1',
        projectId: 'project-1',
        desiredSpec: { persistence: { sizeGi: 1, mountPath: '/data/checkpoints' } },
      }),
      updateMany: async () => { mutated = true; },
      findUniqueOrThrow: async () => null,
    },
    deployment: { findMany: async () => { mutated = true; return []; } },
  };
  const repository = new PrismaControlPlaneRepository(prisma);

  await assert.rejects(repository.deleteService('service-1'), /persistent service storage requires project deletion/i);
  assert.equal(mutated, false);
});

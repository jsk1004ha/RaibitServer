import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERNAL_SERVICE_MUTATION } from '../packages/core/src/desired-state-mutations.ts';

import {
  ControlPlaneStore,
  PrismaControlPlaneRepository,
  resourceStorageMb,
  sanitizeTenantResourceApiInput,
} from '../packages/core/src/index.ts';

test('managed resource API canonicalizes provider fields and storage into MiB', () => {
  const safe = sanitizeTenantResourceApiInput({
    projectId: 'project-1',
    name: 'primary',
    type: 'database',
    engine: 'postgresql',
    provider: 'shared-provider',
    plan: 'shared-small',
    region: 'local',
    storageGb: 2,
    database: 'app',
    username: 'app_user',
  });

  assert.deepEqual(safe.desiredSpec, { storageMb: 2048, databaseName: 'app', username: 'app_user' });
  assert.equal(safe.storageGb, undefined);
  assert.equal(safe.database, undefined);
  assert.equal(safe.username, undefined);
  assert.equal(resourceStorageMb(safe, { includeDesiredState: true }), 2048);
});

test('managed resource API rejects ambiguous, unsupported, and unsafe provider contracts', () => {
  const invalid = [
    { storageMb: 512, storageGb: 1 },
    { storageGb: 0 },
    { storageGb: 1.5 },
    { storageGb: 1025 },
    { database: 'app', databaseName: 'other' },
    { desiredSpec: { arbitrary: true } },
    { backup: { enabled: true } },
    { engine: 'oracle' },
    { type: 'filesystem' },
    { plan: 'enterprise' },
    { region: 'external' },
    { version: 'latest' },
    { provider: 'attacker-cloud' },
  ];

  for (const input of invalid) {
    assert.throws(
      () => sanitizeTenantResourceApiInput({ name: 'primary', engine: 'postgresql', ...input }),
      (error) => error?.statusCode === 400,
      JSON.stringify(input),
    );
  }
});

test('local SQLite compatibility ignores caller paths and delegates path ownership to the store', () => {
  const safe = sanitizeTenantResourceApiInput({
    name: 'local-sqlite',
    type: 'database',
    engine: 'sqlite',
    provider: 'local-pvc',
    desiredSpec: { sqlitePath: 'C:\\attacker-controlled\\database.sqlite' },
  });

  assert.deepEqual(safe.desiredSpec, {});
  assert.equal(safe.provider, 'local-pvc');
  assert.throws(
    () => sanitizeTenantResourceApiInput({ name: 'db', engine: 'postgresql', provider: 'local-pvc' }),
    (error) => error?.statusCode === 400,
  );
});

test('in-memory resource persistence consumes canonical provider fields and keeps project slugs immutable', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Club', slug: 'club' });
  const project = store.createProject({ organizationId: organization.id, name: 'Demo', slug: 'demo' });
  const resource = store.createResource({
    projectId: project.id,
    name: 'primary',
    engine: 'postgresql',
    storageGb: 1,
    database: 'app',
    username: 'app_user',
  });

  assert.deepEqual(resource.desiredSpec, { storageMb: 1024, databaseName: 'app', username: 'app_user' });
  assert.equal(resource.desiredState.desiredSpec.storageMb, 1024);
  assert.throws(() => store.updateProject(project.id, { slug: 'Demo' }), (error) => error.statusCode === 409);
  assert.throws(
    () => store.updateProject(project.id, { slug: 'renamed' }),
    (error) => error?.statusCode === 409 && /immutable/i.test(error.message),
  );
});

test('in-memory project updates persist only tenant-editable fields', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Club', slug: 'project-update-club' });
  const project = store.createProject({ organizationId: organization.id, name: 'Demo', slug: 'project-update-demo', description: 'before' });

  assert.throws(() => store.updateProject(project.id, {
    name: 'Renamed',
    description: 'after',
    id: 'attacker-project',
    organizationId: 'attacker-organization',
    status: 'DELETE_REQUESTED',
    slug: project.slug,
    unknown: 'attacker-controlled',
  }), (error) => error.statusCode === 409);
  const updated = store.getProject(project.id);
  assert.equal(updated.name, 'Demo');
  assert.equal(updated.description, 'before');
  assert.equal(updated.id, project.id);
  assert.equal(updated.organizationId, project.organizationId);
  assert.equal(updated.status, project.status);
  assert.equal(updated.slug, project.slug);
  assert.equal(updated.unknown, undefined);
  assert.equal(store.getProject(project.id).id, project.id);
});

test('Prisma resource updates preserve provisioner-owned state while replacing the provider contract', async () => {
  const fixture = resourcePrisma('FAILED');
  const repository = new PrismaControlPlaneRepository(fixture.prisma);

  const updated = await repository.updateResource('resource-1', {
    storageGb: 1,
    desiredSpec: { username: 'next_user' },
  });

  assert.deepEqual(updated.desiredSpec, { storageMb: 1024, databaseName: 'app', username: 'next_user' });
  assert.deepEqual(updated.desiredState.providerIdentity, fixture.systemState.providerIdentity);
  assert.equal(updated.desiredState.credentialSecretUID, fixture.systemState.credentialSecretUID);
  assert.deepEqual(updated.desiredState.healthManaged, fixture.systemState.healthManaged);
  assert.deepEqual(updated.desiredState.reconcileClaim, fixture.systemState.reconcileClaim);
  assert.deepEqual(updated.desiredState.desiredSpec, updated.desiredSpec);
});

test('Prisma rejects tenant mutation while a provisioner claim is active', async () => {
  const fixture = resourcePrisma('RECONCILING');
  const repository = new PrismaControlPlaneRepository(fixture.prisma);

  await assert.rejects(
    () => repository.updateResource('resource-1', { plan: 'dedicated-local' }),
    (error) => error?.statusCode === 409 && /RECONCILING/.test(error.message),
  );
  assert.equal(fixture.updateCalls, 0);
});

test('Prisma rejects project slug fields including equivalent identities', async () => {
  const fixture = projectPrisma();
  const repository = new PrismaControlPlaneRepository(fixture.prisma);

  await assert.rejects(() => repository.updateProject('project-1', { slug: 'Demo' }), (error) => error.statusCode === 409);
  await assert.rejects(
    () => repository.updateProject('project-1', { slug: 'renamed' }),
    (error) => error?.statusCode === 409 && /immutable/i.test(error.message),
  );
});

test('Prisma project updates persist only tenant-editable fields', async () => {
  const fixture = projectPrisma();
  const repository = new PrismaControlPlaneRepository(fixture.prisma);

  await assert.rejects(() => repository.updateProject('project-1', {
    name: 'Renamed',
    description: 'after',
    id: 'attacker-project',
    organizationId: 'attacker-organization',
    status: 'ATTACKER_CONTROLLED',
    slug: 'demo',
    unknown: 'attacker-controlled',
  }), (error) => error.statusCode === 409);
  const updated = await fixture.prisma.project.findUnique({ where: { id: 'project-1' } });
  assert.equal(updated.name, 'Demo');
  assert.equal(updated.description, undefined);
  assert.equal(updated.id, 'project-1');
  assert.equal(updated.organizationId, 'org-1');
  assert.equal(updated.status, 'ACTIVE');
  assert.equal(updated.slug, 'demo');
  assert.equal(updated.unknown, undefined);
});

test('Prisma service updates preserve desired-state metadata and keep image aliases aligned', async () => {
  let updateData = null;
  let current = {
    id: 'service-1',
    projectId: 'project-1',
    name: 'web',
    status: 'CREATED',
    image: 'registry.example.test/web:old',
    imageUrl: 'registry.example.test/web:old',
    desiredState: { providerMetadata: { owner: 'builder' }, branch: 'old' },
  };
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    project: { findUnique: async () => ({ id: 'project-1', status: 'ACTIVE', deletionRequestedAt: null }) },
    service: {
      findUnique: async () => current,
      update: async ({ data }) => {
        updateData = data;
        current = { ...current, ...data };
        return current;
      },
    },
  };
  const repository = new PrismaControlPlaneRepository(prisma);

  const updated = await repository.updateService('service-1', { branch: 'main', imageUrl: '' }, { mutation: INTERNAL_SERVICE_MUTATION });

  assert.deepEqual(updateData.desiredState.providerMetadata, { owner: 'builder' });
  assert.equal(updateData.desiredState.branch, 'main');
  assert.equal(updated.image, null);
  assert.equal(updated.imageUrl, null);
});

function resourcePrisma(status) {
  const systemState = {
    providerIdentity: { namespace: 'org-1--demo', name: 'resource-1', secretName: 'resource-1-credentials', pvcName: 'resource-1-data' },
    credentialSecretUID: 'secret-uid-1',
    healthManaged: { ready: false, checkedAt: '2026-07-14T00:00:00.000Z' },
    reconcileClaim: { owner: 'provisioner-1', heartbeatAt: '2026-07-14T00:00:01.000Z' },
  };
  let row = {
    id: 'resource-1',
    projectId: 'project-1',
    name: 'primary',
    slug: 'primary',
    type: 'database',
    engine: 'postgresql',
    provider: 'shared-provider',
    plan: 'shared-small',
    region: 'local',
    version: null,
    status,
    connectionSecretName: 'resource-1-connection',
    desiredSpec: { storageMb: 512, databaseName: 'app', username: 'old_user' },
    desiredState: { ...systemState, desiredSpec: { storageMb: 512, databaseName: 'app', username: 'old_user' } },
  };
  const fixture = { systemState, updateCalls: 0 };
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    project: { findUnique: async () => ({ id: 'project-1', status: 'ACTIVE' }) },
    resource: {
      findUnique: async () => row,
      update: async ({ data }) => {
        fixture.updateCalls += 1;
        row = { ...row, ...data };
        return row;
      },
    },
    auditLog: { create: async ({ data }) => data },
  };
  fixture.prisma = prisma;
  return fixture;
}

function projectPrisma() {
  let row = { id: 'project-1', organizationId: 'org-1', name: 'Demo', slug: 'demo', status: 'ACTIVE' };
  const prisma = {
    $transaction: async (callback) => callback(prisma),
    project: {
      findUnique: async () => row,
      update: async ({ data }) => {
        row = { ...row, ...data };
        return row;
      },
    },
  };
  return { prisma };
}

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { signJwtHs256 } from '../packages/core/src/auth.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

test('project settings happy path exposes the rendered snapshot', async () => {
  // Given an owned project rendered through the real in-memory HTTP surface.
  const secret = 'project-settings-red-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Settings Org', slug: 'settings-org' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'Before', slug: 'before', description: 'before' });
  const user = controlPlane.store.createUser({ email: 'settings-owner@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  const token = signJwtHs256({ sub: user.id, role: 'OWNER', organizationId: organization.id }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    // When the settings snapshot is requested.
    const response = await request(address.port, 'GET', `/projects/${project.id}/settings`, null, token);

    // Then the endpoint returns the exact concurrency token shown to the editor.
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.snapshot.updatedAt, project.updatedAt);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('project settings conditional update rejects stale and immutable input without partial writes', async () => {
  // Given a maintainer editing the latest rendered snapshot.
  const fixture = await projectFixture('MAINTAINER');
  try {
    const snapshot = await request(fixture.port, 'GET', `/projects/${fixture.project.id}/settings`, null, fixture.token);
    const originalSlug = snapshot.body.project.slug;
    const originalStatus = snapshot.body.project.status;
    const auditCount = fixture.controlPlane.store.auditLogs.length;

    // When the current snapshot is updated and then replayed with stale and forged inputs.
    const saved = await request(fixture.port, 'PATCH', `/projects/${fixture.project.id}/settings`, {
      name: '변경된 프로젝트', description: 'saved', expectedUpdatedAt: snapshot.body.snapshot.updatedAt,
    }, fixture.token);
    const stale = await request(fixture.port, 'PATCH', `/projects/${fixture.project.id}/settings`, {
      name: 'stale overwrite', expectedUpdatedAt: snapshot.body.snapshot.updatedAt,
    }, fixture.token);
    const forged = await request(fixture.port, 'PATCH', `/projects/${fixture.project.id}/settings`, {
      name: 'forged overwrite', slug: 'forged', status: 'DELETED', expectedUpdatedAt: saved.body.snapshot.updatedAt,
    }, fixture.token);

    // Then only mutable fields from the first conditional write persist with one audit record.
    assert.equal(saved.statusCode, 200);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, 'STALE_PROJECT');
    assert.equal(forged.statusCode, 400);
    assert.equal(fixture.controlPlane.store.projects.get(fixture.project.id).name, '변경된 프로젝트');
    assert.equal(fixture.controlPlane.store.projects.get(fixture.project.id).slug, originalSlug);
    assert.equal(fixture.controlPlane.store.projects.get(fixture.project.id).status, originalStatus);
    assert.equal(fixture.controlPlane.store.auditLogs.length, auditCount + 1);
  } finally {
    await fixture.close();
  }
});

test('project settings tenant and role boundaries expose no foreign impact metadata', async () => {
  // Given viewer, maintainer, and foreign-owner credentials for one project.
  const fixture = await projectFixture('VIEWER');
  const maintainer = fixture.tokenFor('MAINTAINER');
  const foreign = fixture.tokenFor('OWNER', fixture.foreignOrganization.id);
  try {
    const snapshot = await request(fixture.port, 'GET', `/projects/${fixture.project.id}/settings`, null, maintainer);

    // When each role attempts its allowed or forbidden operation.
    const viewerUpdate = await request(fixture.port, 'PATCH', `/projects/${fixture.project.id}/settings`, {
      name: 'viewer overwrite', expectedUpdatedAt: snapshot.body.snapshot.updatedAt,
    }, fixture.token);
    const foreignRead = await request(fixture.port, 'GET', `/projects/${fixture.project.id}/settings`, null, foreign);
    const maintainerDelete = await request(fixture.port, 'POST', `/projects/${fixture.project.id}/settings/deletion`, { confirmed: true }, maintainer);

    // Then existing project permissions apply and foreign responses contain no dependency counts.
    assert.equal(snapshot.statusCode, 200);
    assert.deepEqual(snapshot.body.deletionImpact, { services: 1, resources: 1, previews: 1 });
    assert.equal(viewerUpdate.statusCode, 403);
    assert.equal(foreignRead.statusCode, 403);
    assert.equal('deletionImpact' in foreignRead.body, false);
    assert.equal(maintainerDelete.statusCode, 403);
  } finally {
    await fixture.close();
  }
});

test('explicit project deletion confirmation schedules one recoverable reconciliation', async () => {
  // Given an owner and a project with dependent runtime records.
  const fixture = await projectFixture('ADMIN');
  const beforeAudit = fixture.controlPlane.store.auditLogs.length;
  try {
    // When deletion is confirmed twice after an invalid confirmation attempt.
    const invalid = await request(fixture.port, 'POST', `/projects/${fixture.project.id}/settings/deletion`, { confirmed: false }, fixture.token);
    const first = await request(fixture.port, 'POST', `/projects/${fixture.project.id}/settings/deletion`, { confirmed: true }, fixture.token);
    const second = await request(fixture.port, 'POST', `/projects/${fixture.project.id}/settings/deletion`, { confirmed: true }, fixture.token);

    // Then the request is idempotent and records remain visible for existing reconcilers.
    assert.equal(invalid.statusCode, 400);
    assert.equal(first.statusCode, 202);
    assert.deepEqual(second.body, first.body);
    assert.equal(first.body.scheduled, true);
    assert.equal(first.body.status, 'DELETE_REQUESTED');
    assert.equal(fixture.controlPlane.store.projects.has(fixture.project.id), true);
    assert.equal(fixture.controlPlane.store.services.has(fixture.service.id), true);
    assert.equal(fixture.controlPlane.store.resources.has(fixture.resource.id), true);
    assert.equal(fixture.controlPlane.store.auditLogs.length, beforeAudit + 1);
  } finally {
    await fixture.close();
  }
});

test('Prisma project settings update uses the tenant and snapshot in one conditional write', async () => {
  // Given a Prisma-shaped transaction with a current tenant-owned project snapshot.
  const updatedAt = new Date('2026-09-06T00:00:00.000Z');
  const state = { project: { id: 'project-1', organizationId: 'org-1', name: 'Before', slug: 'before', description: 'before', status: 'ACTIVE', deletionRequestedAt: null, updatedAt }, audits: [] };
  const prisma = projectSettingsPrisma(state);
  const repository = new PrismaControlPlaneRepository(prisma);

  // When the matching update succeeds and its original token is replayed.
  const saved = await repository.updateProjectSettings({ projectId: 'project-1', organizationId: 'org-1', actorUserId: 'user-1', name: 'After', expectedUpdatedAt: updatedAt.toISOString() });
  await assert.rejects(
    repository.updateProjectSettings({ projectId: 'project-1', organizationId: 'org-1', actorUserId: 'user-1', name: 'Stale', expectedUpdatedAt: updatedAt.toISOString() }),
    (error) => error?.code === 'STALE_PROJECT' && error?.statusCode === 409,
  );

  // Then the stale write changes neither the row nor its single audit record.
  assert.equal(saved.project.name, 'After');
  assert.equal(state.project.name, 'After');
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].actorUserId, 'user-1');
});

test('typed project settings client drives the real HTTP contract', async () => {
  const { RAIBITSERVERClient } = await import('../packages/api-client/src/index.ts');
  // Given the public SDK connected to the local in-memory API.
  const fixture = await projectFixture('OWNER');
  const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${fixture.port}`, token: fixture.token });
  try {
    const snapshot = await client.getProjectSettings(fixture.project.id);

    // When the SDK saves settings and schedules confirmed deletion.
    const saved = await client.updateProjectSettings(fixture.project.id, { name: 'SDK update', expectedUpdatedAt: snapshot.snapshot.updatedAt });
    const scheduled = await client.scheduleProjectDeletion(fixture.project.id, true);

    // Then response parsing preserves the snapshot and asynchronous deletion types.
    assert.equal(saved.project.name, 'SDK update');
    assert.equal(scheduled.projectId, fixture.project.id);
    assert.equal(scheduled.scheduled, true);
  } finally {
    await fixture.close();
  }
});

async function projectFixture(role) {
  const secret = `project-settings-${role.toLowerCase()}-secret`;
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Settings Org', slug: `settings-${role.toLowerCase()}` });
  const foreignOrganization = controlPlane.store.createOrganization({ name: 'Foreign Org', slug: `foreign-${role.toLowerCase()}` });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'Before', slug: `before-${role.toLowerCase()}`, description: 'before' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1' });
  const resource = { id: `resource-${role.toLowerCase()}`, projectId: project.id, name: 'data', engine: 'postgresql', status: 'READY', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  controlPlane.store.resources.set(resource.id, resource);
  controlPlane.store.createDeployment({ projectId: project.id, serviceId: service.id, deploymentType: 'preview', pullRequestNumber: 7 });
  const user = controlPlane.store.createUser({ email: `${role.toLowerCase()}@settings.example`, approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const tokenFor = (tokenRole, organizationId = organization.id) => signJwtHs256({ sub: user.id, role: tokenRole, organizationId }, secret);
  return {
    controlPlane, organization, foreignOrganization, project, service, resource,
    port: address.port,
    token: tokenFor(role),
    tokenFor,
    close: async () => { server.close(); await once(server, 'close'); },
  };
}

function projectSettingsPrisma(state) {
  const matches = (where) => state.project.id === where.id
    && state.project.organizationId === where.organizationId
    && (where.updatedAt === undefined || state.project.updatedAt.getTime() === where.updatedAt.getTime());
  const prisma = {
    project: {
      findFirst: async ({ where }) => matches(where) ? state.project : null,
      findUnique: async ({ where }) => state.project.id === where.id ? state.project : null,
      updateMany: async ({ where, data }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(state.project, data, { updatedAt: new Date(state.project.updatedAt.getTime() + 1) });
        return { count: 1 };
      },
    },
    service: { count: async () => 2 },
    resource: { count: async () => 1 },
    deployment: { count: async () => 1 },
    auditLog: { create: async ({ data }) => (state.audits.push(data), data) },
  };
  prisma.$transaction = async (operation) => operation(prisma);
  return prisma;
}

function request(port, method, requestPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const headers = payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (token) headers.authorization = `Bearer ${token}`;
    const outgoing = http.request({ port, path: requestPath, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject);
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
}

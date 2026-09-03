import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { organizationScopeFromProjectInput } from '../packages/core/src/scope.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { authorizeRequest, signJwtHs256 } from '../packages/core/src/auth.ts';
import { sessionPayloadForUser } from '../packages/core/src/identity.ts';

test('session subjects retain each organization membership role', () => {
  const payload = sessionPayloadForUser({
    id: 'multi-org-user',
    email: 'multi-org@example.com',
    approvalStatus: 'APPROVED',
    sessionVersion: 4,
  }, [
    { organizationId: 'org-a', role: 'OWNER' },
    { organizationId: 'org-b', role: 'VIEWER' },
  ]);

  assert.deepEqual(payload.organizationIds, ['org-a', 'org-b']);
  assert.deepEqual(payload.rolesByOrganization, { 'org-a': 'OWNER', 'org-b': 'VIEWER' });
  assert.equal(payload.sessionVersion, 4);
});

test('authorization resolves the role for the target organization', () => {
  const secret = 'organization-role-secret';
  const token = signJwtHs256({
    sub: 'multi-org-user',
    role: 'OWNER',
    organizationId: 'org-a',
    organizationIds: ['org-a', 'org-b'],
    rolesByOrganization: { 'org-a': 'OWNER', 'org-b': 'VIEWER' },
    approvalStatus: 'APPROVED',
    sessionVersion: 4,
  }, secret);
  const req = { headers: { authorization: `Bearer ${token}` }, params: {} };
  const auth = { mode: 'jwt', jwtSecret: secret };

  const viewerSubject = authorizeRequest(req, 'project:read', auth, { organizationId: 'org-b' });
  assert.equal(viewerSubject.role, 'VIEWER');
  assert.deepEqual(viewerSubject.organizationIds, ['org-a', 'org-b']);
  assert.deepEqual(viewerSubject.rolesByOrganization, { 'org-a': 'OWNER', 'org-b': 'VIEWER' });
  assert.equal(viewerSubject.sessionVersion, 4);
  assert.throws(
    () => authorizeRequest(req, 'project:create', auth, { organizationId: 'org-b' }),
    (error) => error.statusCode === 403 && /VIEWER/.test(error.message),
  );

  const ownerSubject = authorizeRequest(req, 'project:create', auth, { organizationId: 'org-a' });
  assert.equal(ownerSubject.role, 'OWNER');
});

test('thin API resolves projectIds-scoped update and delete against the project organization role', async () => {
  const secret = 'project-id-organization-role-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const orgA = controlPlane.store.createOrganization({ name: 'Owner Org', slug: 'project-scope-owner-org' });
  const orgB = controlPlane.store.createOrganization({ name: 'Viewer Org', slug: 'project-scope-viewer-org' });
  const projectB = controlPlane.store.createProject({ organizationId: orgB.id, name: 'Protected', slug: 'project-scope-protected' });
  const user = controlPlane.store.createUser({ email: 'project-scope-mixed@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: orgA.id, userId: user.id, role: 'OWNER' });
  controlPlane.store.addMember({ organizationId: orgB.id, userId: user.id, role: 'VIEWER' });
  const token = signJwtHs256({
    sub: user.id,
    role: 'OWNER',
    organizationId: orgA.id,
    organizationIds: [orgA.id, orgB.id],
    rolesByOrganization: { [orgA.id]: 'OWNER', [orgB.id]: 'VIEWER' },
    projectIds: [projectB.id],
  }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const denied = await request(port, 'PATCH', `/projects/${projectB.id}`, { name: 'Taken Over' }, token);
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /VIEWER.*project:update/);
    assert.equal(controlPlane.store.projects.get(projectB.id).name, 'Protected');

    const deleteDenied = await request(port, 'DELETE', `/projects/${projectB.id}`, null, token);
    assert.equal(deleteDenied.statusCode, 403);
    assert.match(deleteDenied.body.error, /VIEWER.*project:delete/);
    assert.equal(controlPlane.store.projects.has(projectB.id), true);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('maintainer project updates cannot mutate deletion state or project identity', async () => {
  const secret = 'maintainer-project-update-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Maintainer Org', slug: 'maintainer-update-org' });
  const project = controlPlane.store.createProject({ organizationId: organization.id, name: 'Before', slug: 'maintainer-update-project', description: 'before' });
  const user = controlPlane.store.createUser({ email: 'maintainer-update@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'MAINTAINER' });
  const token = signJwtHs256({ sub: user.id, role: 'MAINTAINER', organizationId: organization.id }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const updated = await request(port, 'PATCH', `/projects/${project.id}`, {
      name: 'After',
      description: 'after',
      id: 'attacker-project',
      organizationId: 'attacker-organization',
      status: 'DELETE_REQUESTED',
      slug: project.slug,
      unknown: 'attacker-controlled',
    }, token);
    assert.equal(updated.statusCode, 409);
    assert.deepEqual(controlPlane.store.getProject(project.id), { ...project, organizationSlug: organization.slug, organization: { id: organization.id, name: organization.name, slug: organization.slug } });

    const renamedSlug = await request(port, 'PATCH', `/projects/${project.id}`, { slug: 'attacker-slug' }, token);
    assert.equal(renamedSlug.statusCode, 409);
    assert.equal(controlPlane.store.getProject(project.id).slug, project.slug);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Nest project access guard cannot bypass organization action scope through projectIds', async () => {
  const source = await fs.readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function assertProjectAccess(');
  const end = source.indexOf('async function assertServiceInProject(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const guard = source.slice(start, end);

  assert.doesNotMatch(guard, /requireScope\(subject, \{ projectId \}\);\s*return;/);
  assert.match(guard, /subject\.projectId\s*\|\|\s*Array\.isArray\(subject\.projectIds\)/);
  const projectLookup = guard.indexOf('const project =');
  const organizationScope = guard.indexOf('enforceScope(subject, { organizationId: project.organizationId })');
  assert.ok(projectLookup >= 0 && organizationScope > projectLookup);
});

test('project create derives scope from nested organization before persistence', async () => {
  assert.equal(organizationScopeFromProjectInput({ organization: { slug: 'org-b' } }, { organizationId: 'org-a' }), 'org-b');

  const secret = 'scope-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const user = controlPlane.store.createUser({ email: 'admin-1@example.com', approvalStatus: 'APPROVED' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const scopedToken = signJwtHs256({ sub: user.id, role: 'admin', organizationId: 'org-a' }, secret);
    const denied = await request(port, 'POST', '/projects', { organization: { slug: 'org-b' }, name: 'demo', slug: 'demo' }, scopedToken);
    assert.equal(denied.statusCode, 403);

    const created = await request(port, 'POST', '/projects', { organizationId: 'org-a', name: 'demo', slug: 'demo' }, scopedToken);
    assert.equal(created.statusCode, 201);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('nested organization project creation requires project:create, not project:update', async () => {
  const secret = 'nested-project-create-rbac-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const maintainerUser = controlPlane.store.createUser({ email: 'maintainer-1@example.com', approvalStatus: 'APPROVED' });
  const ownerUser = controlPlane.store.createUser({ email: 'owner-1@example.com', approvalStatus: 'APPROVED' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const maintainerToken = signJwtHs256({ sub: maintainerUser.id, role: 'maintainer', organizationId: 'org-victim' }, secret);
    const denied = await request(port, 'POST', '/organizations/org-victim/projects', { name: 'nested-created', slug: 'nested-created' }, maintainerToken);
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /project:create/);

    const ownerToken = signJwtHs256({ sub: ownerUser.id, role: 'owner', organizationId: 'org-victim' }, secret);
    const created = await request(port, 'POST', '/organizations/org-victim/projects', { name: 'nested-created', slug: 'nested-created' }, ownerToken);
    assert.equal(created.statusCode, 201);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('log snapshot endpoints enforce the same tenant scope as streams', async () => {
  const secret = 'log-scope-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const orgA = controlPlane.store.createOrganization({ name: 'Org A', slug: 'org-a-logs' });
  const orgB = controlPlane.store.createOrganization({ name: 'Org B', slug: 'org-b-logs' });
  const projectB = controlPlane.store.createProject({ organizationId: orgB.id, name: 'Private', slug: 'private-logs' });
  const serviceB = controlPlane.store.createService({ projectId: projectB.id, name: 'web', type: 'web', sourceType: 'image', image: 'example/web:1' });
  const deploymentB = controlPlane.store.createDeployment({ projectId: projectB.id, serviceId: serviceB.id });
  controlPlane.store.appendBuildLog({ deploymentId: deploymentB.id, step: 'build', line: 'tenant-b-secret-log' });
  controlPlane.store.appendRuntimeLog({ serviceId: serviceB.id, deploymentId: deploymentB.id, podName: 'web-0', containerName: 'web', line: 'tenant-b-runtime-log' });
  const userA = controlPlane.store.createUser({ email: 'tenant-a-user@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: orgA.id, userId: userA.id, role: 'viewer' });

  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const tokenA = signJwtHs256({ sub: userA.id, role: 'viewer', organizationId: orgA.id }, secret);
    const deploymentLogs = await request(port, 'GET', `/deployments/${deploymentB.id}/logs`, null, tokenA);
    assert.equal(deploymentLogs.statusCode, 403);
    const deploymentEvents = await request(port, 'GET', `/deployments/${deploymentB.id}/events`, null, tokenA);
    assert.equal(deploymentEvents.statusCode, 403);
    const runtimeLogs = await request(port, 'GET', `/services/${serviceB.id}/logs`, null, tokenA);
    assert.equal(runtimeLogs.statusCode, 403);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

function request(port, method, requestPath, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

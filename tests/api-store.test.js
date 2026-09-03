import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { signJwtHs256 } from '../packages/core/src/auth.ts';

test('HTTP API serves health, catalog, and manifest planning', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 'ok');

    const catalog = await request(port, 'GET', '/catalog');
    assert.equal(catalog.resources.some((resource) => resource.key === 'postgresql'), true);

    const org = await request(port, 'POST', '/organizations', { name: 'GDG Seoul', plan: 'club' });
    assert.equal(org.slug, 'gdg-seoul');

    const manifest = await request(port, 'POST', '/plan/manifests', {
      organization: { slug: 'gdg-seoul', plan: 'club' },
      project: { name: 'demo' },
      services: [{ name: 'web', type: 'web', sourceType: 'image', image: 'ghcr.io/demo/web:1', port: 3000 }],
      resources: [],
    });
    assert.equal(manifest.manifests.some((m) => m.kind === 'Ingress'), true);

    const project = controlPlane.store.createProject({ organizationId: org.id, name: 'demo', slug: 'demo' });
    const service = controlPlane.store.createService({ projectId: project.id, name: 'api', type: 'web', status: 'image-ready' });
    controlPlane.store.attachDomain({ projectId: project.id, serviceId: service.id, domain: 'demo.apps.raibit.kr', verified: true });
    controlPlane.store.createDeployment({ serviceId: service.id, status: 'READY', deploymentType: 'production' });
    const publicSites = await request(port, 'GET', '/public/sites?limit=5');
    assert.deepEqual(publicSites.sites, [{ id: project.id, name: 'demo', owner: 'GDG Seoul', status: 'LIVE', url: 'https://demo.apps.raibit.kr' }]);
    const deployment = controlPlane.store.createDeployment({ serviceId: service.id });
    const job = controlPlane.store.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id } });
    assert.equal(job.status, 'queued');
    assert.equal(controlPlane.store.snapshot().workflowJobs.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ port, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestWithStatus(port, method, path, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestRaw(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ port, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}


test('repository creates deployment and workflow job as one operation', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject({ organizationId: 'org-1', name: 'demo', slug: 'demo' });
  const service = await repository.createService({ projectId: project.id, name: 'api' });
  const { deployment, workflowJob } = await repository.createDeploymentWorkflow({ deployment: { serviceId: service.id }, workflow: { payload: { serviceId: service.id } } });
  assert.equal(workflowJob.targetId, deployment.id);
  assert.equal((await repository.snapshot()).workflowJobs.length, 1);
});

test('project lookups expose the public organization slug used by runtime hostnames', async () => {
  const memory = new InMemoryControlPlaneRepository();
  const organization = await memory.createOrganization({ name: 'Public Owner', slug: 'public-owner' });
  const created = await memory.createProject({ organizationId: organization.id, name: 'Demo', slug: 'demo' });
  const inMemoryProject = await memory.getProject(created.id);
  assert.equal(inMemoryProject.organizationSlug, 'public-owner');
  assert.deepEqual(inMemoryProject.organization, { id: organization.id, name: 'Public Owner', slug: 'public-owner' });

  let query;
  const prisma = new PrismaControlPlaneRepository({
    project: {
      findUnique: async (input) => {
        query = input;
        return { id: 'project-id', organizationId: 'organization-id', name: 'Demo', slug: 'demo', organization: { id: 'organization-id', name: 'Public Owner', slug: 'public-owner' } };
      },
    },
  });
  const prismaProject = await prisma.getProject('project-id');
  assert.deepEqual(query.include.organization.select, { id: true, name: true, slug: true });
  assert.equal(prismaProject.organizationSlug, 'public-owner');
});

test('HTTP API exposes deployment detail, status transition, cancel, and rollback lifecycle routes', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const org = controlPlane.store.createOrganization({ name: 'Deploy Org', slug: 'deploy-org' });
    const project = controlPlane.store.createProject({ organizationId: org.id, name: 'demo', slug: 'demo' });
    const service = controlPlane.store.createService({ projectId: project.id, name: 'api', sourceType: 'image', imageUrl: 'registry.local/demo/api:new' });
    const previous = controlPlane.store.createDeployment({ serviceId: service.id, status: 'READY', imageUrl: 'registry.local/demo/api:old', imageDigest: 'sha256:old' });
    const queued = controlPlane.store.createDeployment({ serviceId: service.id, status: 'queued', imageUrl: 'registry.local/demo/api:new' });

    const detail = await requestWithStatus(port, 'GET', `/deployments/${queued.id}`);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.id, queued.id);

    const building = await requestWithStatus(port, 'POST', `/deployments/${queued.id}/status`, { status: 'BUILDING' });
    assert.equal(building.statusCode, 200);
    assert.equal(building.body.status, 'BUILDING');
    assert.ok(building.body.buildStartedAt);

    const imageReady = await requestWithStatus(port, 'POST', `/deployments/${queued.id}/status`, { status: 'IMAGE_READY', imageDigest: 'sha256:new' });
    assert.equal(imageReady.statusCode, 200);
    assert.equal(imageReady.body.status, 'IMAGE_READY');
    assert.equal(imageReady.body.imageDigest, 'sha256:new');
    assert.ok(imageReady.body.buildFinishedAt);

    const cancelled = await requestWithStatus(port, 'POST', `/deployments/${queued.id}/cancel`, { reason: 'user requested' });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.body.deployment.status, 'CANCELLED');
    assert.ok(cancelled.body.deployment.finishedAt);
    assert.equal(cancelled.body.workflowJob, undefined);
    assert.equal(controlPlane.store.workflowJobs.some((job) => job.type === 'deployment-cancel'), false);
    assert.equal(controlPlane.store.listDeploymentEvents(queued.id).some((event) => event.type === 'deployment.cancelled'), true);

    const deploying = controlPlane.store.createDeployment({ serviceId: service.id, status: 'DEPLOYING', imageUrl: 'registry.local/demo/api:deploying' });
    const deployingCancel = await requestWithStatus(port, 'POST', `/deployments/${deploying.id}/cancel`, { reason: 'too late' });
    assert.equal(deployingCancel.statusCode, 409);
    assert.equal(controlPlane.store.getDeployment(deploying.id).status, 'DEPLOYING');
    const readyCancel = await requestWithStatus(port, 'POST', `/deployments/${previous.id}/cancel`, { reason: 'too late' });
    assert.equal(readyCancel.statusCode, 409);
    assert.equal(controlPlane.store.getDeployment(previous.id).status, 'READY');

    const unconfirmedRollback = await requestWithStatus(port, 'POST', `/deployments/${queued.id}/rollback`, {});
    assert.equal(unconfirmedRollback.statusCode, 400);
    assert.equal(unconfirmedRollback.body.error, 'confirmation_required');

    const rollback = await requestWithStatus(port, 'POST', `/deployments/${queued.id}/rollback`, { confirmed: true });
    assert.equal(rollback.statusCode, 202);
    assert.equal(rollback.body.deployment.status, 'IMAGE_READY');
    assert.equal(rollback.body.deployment.imageUrl, previous.imageUrl);
    assert.equal(rollback.body.workflowJob.type, 'rollback-deploy');
    assert.equal(controlPlane.store.listDeploymentEvents(queued.id).some((event) => event.type === 'deployment.rollback.requested'), true);

    controlPlane.store.appendRuntimeLog({ serviceId: service.id, deploymentId: queued.id, line: 'ready' });
    const deploymentStream = await requestRaw(port, 'GET', `/deployments/${queued.id}/stream`);
    assert.equal(deploymentStream.statusCode, 200);
    assert.match(deploymentStream.headers['content-type'], /text\/event-stream/);
    assert.match(deploymentStream.body, /event: deployment\.snapshot/);
    const runtimeStream = await requestRaw(port, 'GET', `/services/${service.id}/logs/stream`);
    assert.match(runtimeStream.body, /event: service\.logs\.snapshot/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('rollback cannot use unscoped deployments or bypass deployment quotas', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const orgA = controlPlane.store.createOrganization({ name: 'Org A', slug: 'org-a' });
  const orgB = controlPlane.store.createOrganization({ name: 'Org B', slug: 'org-b' });
  const projectA = controlPlane.store.createProject({ organizationId: orgA.id, name: 'attacker', slug: 'attacker' });
  const projectB = controlPlane.store.createProject({ organizationId: orgB.id, name: 'victim', slug: 'victim' });
  const serviceA = controlPlane.store.createService({ projectId: projectA.id, name: 'api', sourceType: 'image', imageUrl: 'registry.local/attacker/api:new' });
  const serviceB = controlPlane.store.createService({ projectId: projectB.id, name: 'api', sourceType: 'image', imageUrl: 'registry.local/victim/api:secret' });
  const previousA = controlPlane.store.createDeployment({ serviceId: serviceA.id, projectId: projectA.id, status: 'READY', imageUrl: 'registry.local/attacker/api:old' });
  const currentA = controlPlane.store.createDeployment({ serviceId: serviceA.id, projectId: projectA.id, status: 'READY', imageUrl: 'registry.local/attacker/api:new' });
  const previousB = controlPlane.store.createDeployment({ serviceId: serviceB.id, projectId: projectB.id, status: 'READY', imageUrl: 'registry.local/victim/api:secret', commitSha: 'victim-private-commit' });

  assert.throws(
    () => controlPlane.store.rollbackDeployment(currentA.id, { previousDeploymentId: previousB.id }),
    /same service/,
  );
  assert.equal(controlPlane.store.rollbackDeployment(currentA.id, { previousDeploymentId: previousA.id }).previousDeployment.projectId, projectA.id);

  const secret = 'rollback-quota-secret';
  const user = controlPlane.store.createUser({ email: 'deployer@example.com', name: 'Deployer', role: 'USER', accountType: 'NON_CLUB', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: orgA.id, userId: user.id, role: 'maintainer' });
  controlPlane.store.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxDeploymentsPerDay: 2 });

  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const token = signJwtHs256({ sub: user.id, role: 'maintainer', organizationId: orgA.id }, secret);
    const denied = await requestWithStatus(port, 'POST', `/deployments/${currentA.id}/rollback`, { previousDeploymentId: previousA.id, confirmed: true }, token);
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /maxDeploymentsPerDay/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP deployment queue rejects workloads blocked by security policy', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const org = controlPlane.store.createOrganization({ name: 'Security Org', slug: 'security-org' });
    const project = controlPlane.store.createProject({ organizationId: org.id, name: 'demo', slug: 'demo' });
    const service = controlPlane.store.createService({ projectId: project.id, name: 'unsafe', desiredSpec: { privileged: true } });

    const response = await requestWithStatus(port, 'POST', `/services/${service.id}/deployments`, {});
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error, 'security_policy_violation');
    assert.equal(controlPlane.store.snapshot().workflowJobs.length, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP resource create strips tenant-supplied provider connection fields', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const org = controlPlane.store.createOrganization({ name: 'Resource Org', slug: 'resource-org' });
    const project = controlPlane.store.createProject({ organizationId: org.id, name: 'demo', slug: 'demo' });
    const response = await requestWithStatus(port, 'POST', `/projects/${project.id}/resources`, {
      name: 'pg',
      engine: 'postgresql',
      providerConnection: { databaseUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil' },
      connectionUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil',
      desiredSpec: { providerConnection: { databaseUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil' }, storageGb: 1 },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.providerConnection, undefined);
    assert.equal(response.body.connectionUrl, undefined);
    assert.equal(response.body.desiredSpec.providerConnection, undefined);
    assert.equal(response.body.desiredSpec.storageMb, 1024);
    assert.equal(response.body.desiredSpec.storageGb, undefined);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

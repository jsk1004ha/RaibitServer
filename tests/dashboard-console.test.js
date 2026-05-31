import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';

test('dashboard project detail is API-backed instead of hardcoded prototype arrays', async () => {
  const detail = await fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(detail, /const\s+services\s*=\s*\[/);
  assert.doesNotMatch(detail, /const\s+resources\s*=\s*\[/);
  for (const marker of ['loadProjectConsole', '/deployments', '/console/schema', '/console/query', 'Create service', 'sourceType', 'imageUrl', 'dockerfilePath', 'Create resource', 'Deploy production', 'Preview deployment list', 'Build logs', 'Runtime logs']) {
    assert.ok(detail.includes(marker), `${marker} missing from project console page`);
  }
});

test('dashboard exposes auth, admin, GitHub, deployment log, and resource console pages wired to API routes', async () => {
  const files = await Promise.all([
    fs.readFile(new URL('../apps/dashboard/app/login/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/admin/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/github/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx', import.meta.url), 'utf8'),
  ]);
  const combined = files.join('\n');
  for (const marker of ['/auth/login', '/auth/signup', '/auth/email/verify', '/auth/email/resend', '/auth/github/login', '/auth/github/callback', '/admin/users/', '/github/repositories/import', '/github/repositories/:repositoryId/sync', '/projects/:projectId/services/:serviceId/github', '/integrations/github', 'Webhook / Preview contract', '/deployments/', '/status', '/cancel', '/rollback', 'Image digest', 'errorCode', '/console/command', '/console/tables', '/console/keys']) {
    assert.ok(combined.includes(marker), `${marker} missing from dashboard routes`);
  }
});

test('dashboard avoids default workspace link and aggregates logs across deployments/services', async () => {
  const home = await fs.readFile(new URL('../apps/dashboard/app/page.tsx', import.meta.url), 'utf8');
  const api = await fs.readFile(new URL('../apps/dashboard/lib/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(home, /href="\/org\/default\/projects\/new"/);
  for (const marker of ['createOrgSlug', 'buildLogResults', 'deploymentEventResults', 'runtimeLogResults']) {
    assert.ok(`${home}\n${api}`.includes(marker), `${marker} missing from dashboard API-backed log aggregation`);
  }
});

test('prototype API accepts dashboard HTML form posts for create and deploy actions', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Form Org', slug: 'form-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'Form Project', slug: 'form-project' });
  const handler = createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' } });
  const serviceReq = formRequest(`/projects/${project.id}/services`, { name: 'web', type: 'web', repoUrl: 'https://github.com/alice/web.git' });
  const serviceRes = captureResponse();
  await handler(serviceReq, serviceRes);
  assert.equal(serviceRes.statusCode, 201);
  const service = JSON.parse(serviceRes.body);
  assert.equal(service.name, 'web');

  const deploymentReq = formRequest(`/projects/${project.id}/services/${service.id}/deployments`, { deploymentType: 'preview' });
  const deploymentRes = captureResponse();
  await handler(deploymentReq, deploymentRes);
  assert.equal(deploymentRes.statusCode, 202);
  const deployment = JSON.parse(deploymentRes.body);
  assert.equal(deployment.deploymentType, 'preview');
});

function formRequest(path, values) {
  const body = new URLSearchParams(values).toString();
  return {
    url: path,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

function captureResponse() {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}

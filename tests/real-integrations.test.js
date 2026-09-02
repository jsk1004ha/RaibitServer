import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { commandExists, runCommand } from '../packages/core/src/command-runner.ts';
import { cloneRepository, sourceCheckoutPlan } from '../packages/core/src/source-control.ts';
import { buildExecutionPlan, executeBuildWorkflow } from '../packages/core/src/build-executor.ts';
import { parseImageReference, registryPushPlan } from '../packages/core/src/registry.ts';
import { applyProject } from '../packages/core/src/kubernetes.ts';
import { compileProjectProvisioning, provisionProjectResources } from '../packages/core/src/provisioner.ts';
import { signJwtHs256, verifyJwtHs256 } from '../packages/core/src/auth.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { RESOURCE_CAPABILITIES } from '../packages/core/src/resource-capabilities.ts';

const service = {
  name: 'web',
  projectSlug: 'demo',
  sourceType: 'github',
  repoUrl: 'https://github.com/acme/demo-web',
  branch: 'main',
  dockerfilePath: 'Dockerfile',
  buildContext: '.',
  registry: 'ghcr.io/acme',
};

const project = {
  organization: { slug: 'gdg-hongik', plan: 'club' },
  project: { slug: 'festival-2026' },
  registry: 'ghcr.io/acme',
  services: [{ ...service, name: 'web', type: 'web', port: 3000, image: undefined }],
  resources: [{ name: 'postgres', engine: 'postgresql', databaseName: 'festival', username: 'festival_app', password: 'secret' }],
};

test('source checkout plans real git clone without leaking tokens', () => {
  const plan = sourceCheckoutPlan(service, { token: 'ghp_secret', workspaceDir: '/tmp/work' });
  assert.equal(plan.required, true);
  assert.equal(plan.provider, 'github');
  assert.match(plan.command, /^git clone/);
  assert.doesNotMatch(plan.command, /ghp_secret/);
  assert.throws(() => sourceCheckoutPlan({ ...service, repoUrl: 'https://token@github.com/acme/demo-web' }), /credentialed git URLs/);
});

test('git clone adapter can execute a real local clone when git is available', async (t) => {
  if (!(await commandExists('git'))) return t.skip('git executable unavailable');
  const root = path.join(os.tmpdir(), `raibitserver-git-${randomUUID()}`);
  console.log(`INTEGRATION_TEMP ${root}`);
  await fs.mkdir(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const dest = path.join(root, 'clone');
  await fs.mkdir(repo, { recursive: true });
  await runCommand({ executable: 'git', args: ['init', '--initial-branch', 'main'], cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), 'hello raibitserver\n');
  await runCommand({ executable: 'git', args: ['add', 'README.md'], cwd: repo });
  await runCommand({
    executable: 'git',
    args: ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init'],
    cwd: repo,
  });

  const result = await cloneRepository({ repoUrl: repo, branch: 'main', destination: dest, dryRun: false });
  assert.equal(result.dryRun, false);
  assert.match(await fs.readFile(path.join(dest, 'README.md'), 'utf8'), /^hello raibitserver\r?\n$/);
});

test('BuildKit/Docker and registry execution plans are real commands but dry-run by default', async () => {
  assert.throws(
    () => buildExecutionPlan(service, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', push: true, buildArgs: { SECRET_TOKEN: 'super-secret-value' }, metadataFile: '/tmp/build-metadata.json' }),
    /secret-looking build arg.*BuildKit secret mount/i,
  );
  const plan = buildExecutionPlan(service, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', push: true, buildArgs: { PUBLIC_VERSION: '2026.07' }, metadataFile: '/tmp/build-metadata.json' });
  assert.match(plan.buildCommand, /docker buildx build/);
  assert.match(plan.buildCommand, /--push/);
  assert.match(plan.buildCommand, /--metadata-file/);
  assert.doesNotMatch(plan.buildCommand, /super-secret-value/);
  assert.equal(plan.push, true);

  const result = await executeBuildWorkflow(service, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', push: true, buildArgs: { PUBLIC_VERSION: '2026.07' }, metadataFile: '/tmp/build-metadata.json' });
  assert.equal(result.dryRun, true);
  assert.match(result.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.steps.some((step) => step.type === 'git-clone'), true);
  const buildStep = result.steps.find((step) => step.type === 'buildkit-build');
  assert.equal(Boolean(buildStep), true);
  assert.equal('stdout' in buildStep, false);

  const push = registryPushPlan('ghcr.io/acme/demo-web:abc123');
  assert.equal(push.registry, 'ghcr.io');
  assert.equal(push.command, 'docker push ghcr.io/acme/demo-web:abc123');
  assert.equal(parseImageReference('localhost:5000/acme/demo-web:abc123').registry, 'localhost:5000');
  assert.equal(parseImageReference('ghcr.io/acme/demo-web@sha256:abc123').digest, 'sha256:abc123');
});


test('build execution plan rejects escaping build context and Dockerfile paths', () => {
  assert.throws(() => buildExecutionPlan({ ...service, buildContext: '../../..' }, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo' }), /buildContext must stay within source directory/);
  assert.throws(() => buildExecutionPlan({ ...service, dockerfilePath: '../Dockerfile' }, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo' }), /dockerfilePath must stay within source directory/);
});

test('tenant service metadataFile is ignored by the TypeScript build executor', async () => {
  const untrusted = { ...service, metadataFile: '/tmp/attacker-controlled-buildx-metadata.json' };
  const plan = buildExecutionPlan(untrusted, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', push: true });
  assert.match(plan.buildCommand, /docker buildx build/);
  assert.doesNotMatch(plan.buildCommand, /attacker-controlled-buildx-metadata/);
  assert.doesNotMatch(plan.buildCommand, /--metadata-file/);

  const trusted = buildExecutionPlan(untrusted, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', push: true, metadataFile: '/tmp/executor-owned-metadata.json' });
  assert.match(trusted.buildCommand, /--metadata-file/);
  assert.match(trusted.buildCommand, /executor-owned-metadata/);

  const result = await executeBuildWorkflow(untrusted, { Dockerfile: 'FROM scratch' }, { sourceDir: '/workspace/demo', push: true });
  const buildStep = result.steps.find((step) => step.type === 'buildkit-build');
  assert.doesNotMatch(buildStep.command, /attacker-controlled-buildx-metadata/);
});

test('kubectl apply and DB provisioning paths create executable dry-run artifacts', async (t) => {
  const outputDir = path.join(os.tmpdir(), `raibit-H1-integration-${randomUUID()}`);
  console.log(`INTEGRATION_TEMP ${outputDir}`);
  await fs.mkdir(outputDir);
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const apply = await applyProject(project, { web: { Dockerfile: 'FROM scratch' } }, { outputDir, fileName: 'project.json' });
  assert.equal(apply.apply.dryRun, true);
  assert.match(apply.apply.command, /kubectl apply/);
  const written = JSON.parse(await fs.readFile(apply.apply.manifestFile, 'utf8'));
  assert.equal(written.kind, 'List');
  assert.equal(written.items.some((item) => item.kind === 'Deployment'), true);
  assert.equal(JSON.stringify(written).includes('festival_app:secret'), false);

  const provisioning = compileProjectProvisioning(project);
  assert.equal(provisioning.manifests.some((manifest) => manifest.kind === 'ManagedDatabase'), true);
  for (const entry of RESOURCE_CAPABILITIES) {
    const compile = () => compileProjectProvisioning({ ...project, resources: [{ name: 'resource', engine: entry.engine }] });
    if (entry.local.provision) assert.equal(compile().manifests[0].spec.engine, entry.engine);
    else assert.throws(compile, error => error.statusCode === 400 && error.code === 'RESOURCE_CAPABILITY_UNAVAILABLE' && error.reasonCode === entry.reasonCode);
  }
  const provision = await provisionProjectResources(project, { outputDir, fileName: 'resources.json' });
  assert.equal(provision.apply.dryRun, true);
  assert.match(provision.apply.command, /kubectl apply/);
});

test('HS256 JWT auth enforces RBAC on protected API routes', async () => {
  const secret = 'unit-test-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const viewerUser = controlPlane.store.createUser({ email: 'viewer-1@example.com', approvalStatus: 'APPROVED' });
  const developerUser = controlPlane.store.createUser({ email: 'dev-1@example.com', approvalStatus: 'APPROVED' });
  const scopedViewerUser = controlPlane.store.createUser({ email: 'viewer-a@example.com', approvalStatus: 'APPROVED' });
  const scopedDeveloperUser = controlPlane.store.createUser({ email: 'dev-a@example.com', approvalStatus: 'APPROVED' });
  const scopedMaintainerUser = controlPlane.store.createUser({ email: 'maint-a@example.com', approvalStatus: 'APPROVED' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const unauth = await request(port, 'POST', '/projects', { organizationId: 'org-1', name: 'demo' });
    assert.equal(unauth.statusCode, 401);

    const malformed = await request(port, 'POST', '/projects', { organizationId: 'org-1', name: 'demo' }, 'not.a.jwt');
    assert.equal(malformed.statusCode, 401);

    const viewerToken = signJwtHs256({ sub: viewerUser.id, role: 'viewer' }, secret);
    const denied = await request(port, 'POST', '/projects', { organizationId: 'org-1', name: 'demo' }, viewerToken);
    assert.equal(denied.statusCode, 403);

    const ownerToken = signJwtHs256({ sub: 'owner-1', role: 'owner', global: true }, secret);
    const created = await request(port, 'POST', '/projects', { organizationId: 'org-1', name: 'demo' }, ownerToken);
    assert.equal(created.statusCode, 201);

    const developerToken = signJwtHs256({ sub: developerUser.id, role: 'developer', projectIds: ['project-1'] }, secret);
    const deniedScope = await request(port, 'POST', '/services', { projectId: 'project-2', name: 'api' }, developerToken);
    assert.equal(deniedScope.statusCode, 403);

    const orgA = controlPlane.store.createOrganization({ name: 'Org A', slug: 'org-a' });
    const orgB = controlPlane.store.createOrganization({ name: 'Org B', slug: 'org-b' });
    const projectA = controlPlane.store.createProject({ organizationId: orgA.id, name: 'alpha', slug: 'alpha' });
    const projectB = controlPlane.store.createProject({ organizationId: orgB.id, name: 'beta', slug: 'beta' });
    controlPlane.store.addMember({ organizationId: orgA.id, userId: scopedViewerUser.id, role: 'viewer' });
    controlPlane.store.addMember({ organizationId: orgA.id, userId: scopedDeveloperUser.id, role: 'developer' });
    controlPlane.store.addMember({ organizationId: orgA.id, userId: scopedMaintainerUser.id, role: 'maintainer' });
    const ownResource = controlPlane.store.createResource({ projectId: projectA.id, name: 'pg', engine: 'postgresql' });
    const otherResource = controlPlane.store.createResource({ projectId: projectB.id, name: 'pg', engine: 'postgresql' });
    const scopedViewer = signJwtHs256({ sub: scopedViewerUser.id, role: 'viewer', organizationId: orgA.id }, secret);
    const viewerConsole = await request(port, 'POST', `/resources/${ownResource.id}/console/query`, { query: 'SELECT 1' }, scopedViewer);
    assert.equal(viewerConsole.statusCode, 403);
    const scopedDeveloper = signJwtHs256({ sub: scopedDeveloperUser.id, role: 'developer', organizationId: orgA.id }, secret);
    const developerConsole = await request(port, 'POST', `/resources/${ownResource.id}/console/query`, { query: 'SELECT 1' }, scopedDeveloper);
    assert.equal(developerConsole.statusCode, 403);
    const scopedMaintainer = signJwtHs256({ sub: scopedMaintainerUser.id, role: 'maintainer', organizationId: orgA.id }, secret);
    const ownConsole = await request(port, 'POST', `/resources/${ownResource.id}/console/query`, { query: 'SELECT 1', connectionUrl: 'postgresql://attacker:secret@127.0.0.1:1/evil' }, scopedMaintainer);
    assert.equal(ownConsole.statusCode, 200);
    assert.equal(ownConsole.body.mode, 'connection-info');
    assert.match(ownConsole.body.warning, /provider-owned connection URL/);
    const deniedConsole = await request(port, 'POST', `/resources/${otherResource.id}/console/query`, { query: 'SELECT 1' }, scopedMaintainer);
    assert.equal(deniedConsole.statusCode, 403);

    const executeRemoved = await request(port, 'POST', '/execute/kubernetes-apply', project, ownerToken);
    assert.equal(executeRemoved.statusCode, 404);
  } finally {
    server.close();
  }
});

test('Prisma persistence contract and CI workflow are present', async () => {
  const schema = await fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /model Organization/);
  assert.match(schema, /model Deployment/);
  assert.match(schema, /provider = "postgresql"/);
  const ci = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /pnpm test/);
  assert.match(ci, /actions\/setup-go@v5/);
  assert.match(ci, /go test/);
  assert.match(ci, /go build \.\/\.\.\./);
  assert.match(ci, /pnpm prisma:validate/);

  const token = signJwtHs256({ sub: 'user-1', role: 'owner' }, 'secret');
  assert.equal(verifyJwtHs256(token, 'secret').role, 'owner');
  const cliToken = await runCommand({ executable: process.execPath, args: ['src/cli.js', 'auth-token', '--role', 'owner', '--sub', 'user-1'], env: { RAIBITSERVER_AUTH_JWT_SECRET: 'secret' } });
  const parsed = JSON.parse(cliToken.stdout);
  assert.equal(Boolean(parsed.token), true);
  assert.doesNotMatch(parsed.token, /\*/);
  assert.equal(verifyJwtHs256(parsed.token, 'secret').role, 'owner');
});

function request(port, method, requestPath, body, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, path: requestPath, method, headers }, (res) => {
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

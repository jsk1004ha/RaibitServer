import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { PrismaControlPlaneRepository, resolveControlPlaneRepositoryConfig } from '../packages/core/src/persistence.ts';

test('api client uses project-scoped deployment route and keeps legacy fallback', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    const payload = req.method === 'GET' ? { deployments: [] } : { id: 'dep_1', serviceId: 'service 1', status: 'queued' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    await client.createDeployment('project 1', 'service 1', { deploymentType: 'preview', branch: 'feat/api' });
    await client.listDeployments('project 1', 'service 1');
    await client.createDeployment('service 1', { deploymentType: 'manual' });
  } finally {
    server.close();
  }
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/projects/project%201/services/service%201/deployments');
  assert.equal(JSON.parse(requests[0].body).deploymentType, 'preview');
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].url, '/projects/project%201/services/service%201/deployments');
  assert.equal(requests[2].url, '/services/service%201/deployments');
});

test('security-sensitive persistence and auth boundary regressions remain enforced', async () => {
  const githubController = await fs.readFile(new URL('../apps/api/src/modules/integrations/github.controller.ts', import.meta.url), 'utf8');
  const authController = await fs.readFile(new URL('../apps/api/src/modules/auth/auth.controller.ts', import.meta.url), 'utf8');
  const rbacGuard = await fs.readFile(new URL('../apps/api/src/auth/rbac.guard.ts', import.meta.url), 'utf8');
  const apiMain = await fs.readFile(new URL('../apps/api/src/main.ts', import.meta.url), 'utf8');
  const raibitserverService = await fs.readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  const coreApi = await fs.readFile(new URL('../packages/core/src/api.ts', import.meta.url), 'utf8');
  const envPolicy = await fs.readFile(new URL('../packages/core/src/env-policy.ts', import.meta.url), 'utf8');
  const persistence = await fs.readFile(new URL('../packages/core/src/persistence.ts', import.meta.url), 'utf8');
  assert.ok(apiMain.includes('rawBody: true'), 'Nest bootstrap must keep raw webhook bytes for GitHub HMAC verification');
  assert.ok(githubController.includes('req.rawBody'), 'GitHub webhook controller must verify the original raw payload bytes');
  assert.ok(raibitserverService.includes('user: publicUser(result.user)'), 'Nest email verification response must not expose passwordHash');
  assert.ok(raibitserverService.includes('normalizeEnvEntries'), 'Nest env writes must normalize entries before persistence');
  assert.ok(raibitserverService.includes('parseDotEnv'), 'Nest env-file writes must parse dotenv content before persistence');
  assert.ok(envPolicy.includes('assertEnvironmentWriteAllowed'), 'limited-secret env write policy must be centralized in core');
  assert.ok(coreApi.includes('assertEnvironmentWriteAllowed(subject, entries)'), 'core env writes must use the shared limited-secret write guard');
  assert.ok(coreApi.includes('assertEnvironmentWriteAllowed(subject, parsed.entries)'), 'core env-file writes must use the shared limited-secret write guard');
  assert.ok(raibitserverService.includes('assertNestEnvironmentWriteAllowed(subject, entries)'), 'Nest env writes must use the shared limited-secret write guard');
  assert.ok(raibitserverService.includes('assertNestEnvironmentWriteAllowed(subject, parsed.entries)'), 'Nest env-file writes must use the shared limited-secret write guard');
  const loginMethod = raibitserverService.slice(raibitserverService.indexOf('async login'), raibitserverService.indexOf('  async createProject'));
  assert.doesNotMatch(loginMethod, /assertRateLimit\(authLimiter,\s*`login:\$\{email\}`\)/, 'Nest login limiter must not use a global email-only key');
  assert.ok(loginMethod.indexOf('enforceAuthAbuseLimits') >= 0 && loginMethod.indexOf('enforceAuthAbuseLimits') < loginMethod.indexOf('verifyPassword'), 'Nest login must durably charge IP+email abuse-limit keys before expensive password verification');
  assert.match(authController, /login\(@Body\(\) input: Record<string, any>, @Req\(\) req: any\)/, 'Nest auth controller must pass request context for auth rate-limit source keys');
  assert.match(rbacGuard, /await this\.controlPlane\.validateSessionSubject\(req\.raibitSubject\)/, 'Nest RBAC guard must validate current approval and session version on every protected request');
  assert.match(persistence, /if \(integrations\.length === 0\) return \{[^}]*repositories: \[\][^}]*\};/, 'Prisma GitHub installation repository listing must not leak all repos when scope filters out integrations');
  assert.ok(persistence.includes('return redactUser(user);'), 'Prisma user creation/update surfaces must redact passwordHash');
  assert.ok(!persistence.includes('integrations.length === 0 ||'), 'Prisma GitHub installation repository listing must not use broad fallback matching');
  assert.ok(persistence.includes('servicesForPrismaGitHubRepository'), 'Prisma GitHub webhook must map deliveries to attached services');
  assert.ok(persistence.includes("type: 'preview-deploy'"), 'Prisma GitHub webhook must enqueue preview deploy jobs');
  assert.ok(persistence.includes("type: 'preview-cleanup'"), 'Prisma GitHub webhook must enqueue preview cleanup jobs');
  assert.ok(persistence.includes('previewRuntimePlan'), 'GitHub preview jobs must carry deterministic Kubernetes preview workload plans');
});

test('production persistence defaults to Prisma and rejects unsafe memory/secret gaps', () => {
  assert.deepEqual(resolveControlPlaneRepositoryConfig({}, {}), { kind: 'memory', production: false });
  assert.deepEqual(resolveControlPlaneRepositoryConfig({}, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/raibitserver',
    RAIBITSERVER_SECRET_ENCRYPTION_KEY: 'x'.repeat(32),
  }), { kind: 'prisma', production: true });
  assert.throws(() => resolveControlPlaneRepositoryConfig({ kind: 'memory' }, { NODE_ENV: 'production' }), /in-memory persistence is disabled in production/);
  assert.throws(() => resolveControlPlaneRepositoryConfig({}, { NODE_ENV: 'production', RAIBITSERVER_SECRET_ENCRYPTION_KEY: 'x'.repeat(32) }), /DATABASE_URL is required/);
  assert.throws(() => resolveControlPlaneRepositoryConfig({}, { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db' }), /RAIBITSERVER_SECRET_ENCRYPTION_KEY/);
  assert.equal(resolveControlPlaneRepositoryConfig({ kind: 'memory' }, { NODE_ENV: 'production', RAIBITSERVER_ALLOW_MEMORY_PERSISTENCE: '1' }).kind, 'memory');
});

test('Prisma desired-state writer uses the authenticated organization id instead of default memory semantics', async () => {
  const calls = [];
  const tx = {
    organization: {
      findUnique: async ({ where }) => {
        calls.push({ model: 'organization', op: 'findUnique', where });
        return where.id === 'org_123' ? { id: 'org_123', slug: 'tenant-org', name: 'Tenant Org' } : null;
      },
      upsert: async (args) => {
        calls.push({ model: 'organization', op: 'upsert', args });
        return { id: 'unexpected', slug: args.where.slug };
      },
    },
    project: {
      upsert: async (args) => {
        calls.push({ model: 'project', op: 'upsert', args });
        return { id: 'prj_123', organizationId: args.where.organizationId_slug.organizationId, slug: args.where.organizationId_slug.slug, name: args.create.name };
      },
    },
    service: { upsert: async (args) => ({ id: 'svc_123', projectId: args.create.projectId, slug: args.create.slug }) },
    resource: { upsert: async (args) => ({ id: 'res_123', projectId: args.create.projectId, name: args.create.name }) },
    auditLog: { create: async (args) => calls.push({ model: 'auditLog', op: 'create', args }) },
  };
  const repo = new PrismaControlPlaneRepository({ $transaction: (callback) => callback(tx) });
  const result = await repo.writeDesiredProject({ organizationId: 'org_123', name: 'Tenant App', services: [{ name: 'web' }], resources: [{ name: 'data', engine: 'postgresql' }] });

  assert.equal(result.organization.id, 'org_123');
  assert.equal(result.project.organizationId, 'org_123');
  assert.equal(calls.some((call) => call.model === 'organization' && call.op === 'upsert'), false);
  const projectUpsert = calls.find((call) => call.model === 'project' && call.op === 'upsert');
  assert.equal(projectUpsert.args.where.organizationId_slug.organizationId, 'org_123');
});

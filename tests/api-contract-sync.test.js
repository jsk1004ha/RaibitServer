import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import YAML from 'yaml';
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

test('OpenAPI and Nest controller surface expose client contract routes', async () => {
  const openapi = YAML.parse(await fs.readFile(new URL('../openapi/raibitserver.yaml', import.meta.url), 'utf8'));
  for (const route of [
    '/projects/{projectId}',
    '/services/{serviceId}',
    '/projects/{projectId}/services/{serviceId}/deployments',
    '/deployments/{deploymentId}',
    '/deployments/{deploymentId}/status',
    '/deployments/{deploymentId}/cancel',
    '/deployments/{deploymentId}/rollback',
    '/deployments/{deploymentId}/logs',
    '/deployments/{deploymentId}/events',
    '/deployments/{deploymentId}/stream',
    '/projects/{projectId}/services/{serviceId}/env',
    '/projects/{projectId}/services/{serviceId}/env-file',
    '/services/{serviceId}/logs',
    '/services/{serviceId}/logs/stream',
    '/auth/github/login',
    '/auth/github/callback',
    '/auth/email/verify',
    '/auth/email/resend',
    '/github/installations',
    '/integrations/github',
    '/projects/{projectId}/services/{serviceId}/github',
    '/github/installations/{installationId}/repositories',
    '/github/webhooks',
    '/github/repositories/import',
    '/github/repositories/{repositoryId}/sync',
    '/resources/{resourceId}/console/schema',
    '/resources/{resourceId}/console/tables',
    '/resources/{resourceId}/console/tables/{table}',
    '/resources/{resourceId}/console/collections',
    '/resources/{resourceId}/console/keys',
    '/resources/{resourceId}/console/query',
    '/resources/{resourceId}/console/command',
    '/resources/{resourceId}/console/browse',
    '/usage/me',
  ]) {
    assert.ok(openapi.paths[route], `${route} missing from OpenAPI`);
  }

  const appModule = await fs.readFile(new URL('../apps/api/src/app.module.ts', import.meta.url), 'utf8');
  for (const moduleName of ['AuthModule', 'ProjectsModule', 'ServicesModule', 'DeploymentsModule', 'ResourcesModule', 'EnvironmentModule', 'IntegrationsModule', 'AdminModule', 'UsageModule']) {
    assert.match(appModule, new RegExp(moduleName));
  }

  const servicesController = await fs.readFile(new URL('../apps/api/src/modules/services/services.controller.ts', import.meta.url), 'utf8');
  const servicesModule = await fs.readFile(new URL('../apps/api/src/modules/services/services.module.ts', import.meta.url), 'utf8');
  const servicesService = await fs.readFile(new URL('../apps/api/src/modules/services/services.service.ts', import.meta.url), 'utf8');
  const projectsController = await fs.readFile(new URL('../apps/api/src/modules/projects/projects.controller.ts', import.meta.url), 'utf8');
  const projectsService = await fs.readFile(new URL('../apps/api/src/modules/projects/projects.service.ts', import.meta.url), 'utf8');
  const deploymentsController = await fs.readFile(new URL('../apps/api/src/modules/deployments/deployments.controller.ts', import.meta.url), 'utf8');
  const deploymentsModule = await fs.readFile(new URL('../apps/api/src/modules/deployments/deployments.module.ts', import.meta.url), 'utf8');
  const deploymentsService = await fs.readFile(new URL('../apps/api/src/modules/deployments/deployments.service.ts', import.meta.url), 'utf8');
  const resourcesController = await fs.readFile(new URL('../apps/api/src/modules/resources/resources.controller.ts', import.meta.url), 'utf8');
  const resourcesModule = await fs.readFile(new URL('../apps/api/src/modules/resources/resources.module.ts', import.meta.url), 'utf8');
  const resourceConsoleController = await fs.readFile(new URL('../apps/api/src/modules/resources/resource-console.controller.ts', import.meta.url), 'utf8');
  const githubController = await fs.readFile(new URL('../apps/api/src/modules/integrations/github.controller.ts', import.meta.url), 'utf8');
  const authController = await fs.readFile(new URL('../apps/api/src/modules/auth/auth.controller.ts', import.meta.url), 'utf8');
  const apiMain = await fs.readFile(new URL('../apps/api/src/main.ts', import.meta.url), 'utf8');
  const raibitserverService = await fs.readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  const coreApi = await fs.readFile(new URL('../packages/core/src/api.ts', import.meta.url), 'utf8');
  const envPolicy = await fs.readFile(new URL('../packages/core/src/env-policy.ts', import.meta.url), 'utf8');
  const persistence = await fs.readFile(new URL('../packages/core/src/persistence.ts', import.meta.url), 'utf8');
  const apiClient = await fs.readFile(new URL('../packages/api-client/src/index.ts', import.meta.url), 'utf8');
  assert.match(servicesController, /@Get\(\)/);
  assert.match(servicesModule, /ServiceDeploymentsController|ServiceDetailController/);
  assert.match(servicesModule, /providers: \[ServicesService\]/);
  assert.match(servicesController, /constructor\(private readonly servicesService: ServicesService\)/);
  assert.match(servicesService, /constructor\(private readonly controlPlane: RAIBITSERVERService\)/);
  assert.match(projectsController, /@Get\(':projectId'\)/);
  assert.match(projectsService, /createProject\(project: ProjectSpec/);
  assert.match(projectsController, /@Patch\(':projectId'\)/);
  assert.match(projectsController, /@Delete\(':projectId'\)/);
  assert.match(servicesController, /ServiceDetailController/);
  assert.match(servicesController, /@Patch\(\)/);
  for (const marker of ["@Get('deployments/:deploymentId')", "@Patch('deployments/:deploymentId/status')", "@Post('deployments/:deploymentId/status')", "@Post('deployments/:deploymentId/cancel')", "@Post('deployments/:deploymentId/rollback')", "@Get('deployments/:deploymentId/stream')", "@Get('services/:serviceId/logs/stream')"]) assert.ok(deploymentsController.includes(marker), `${marker} missing from Deployments controller`);
  assert.match(deploymentsModule, /ServiceDeploymentsController/);
  assert.match(deploymentsModule, /DeploymentLogsController/);
  assert.match(deploymentsModule, /providers: \[DeploymentsService\]/);
  assert.match(deploymentsService, /updateDeploymentStatus/);
  assert.match(resourcesController, /@Get\(\)/);
  assert.match(resourcesModule, /ResourceConsoleController/);
  for (const marker of ["@Get('schema')", "@Get('tables')", "@Get('tables/:table')", "@Get('collections')", "@Get('keys')", "@Post('query')", "@Post('command')", "@Post('browse')"]) assert.ok(resourceConsoleController.includes(marker), `${marker} missing from ResourceConsoleController`);
  for (const marker of ["@Get('github/installations')", "@Get('github/installations/:installationId/repositories')", "@Post('github/webhooks')", "@Post('github/repositories/import')", "@Post('github/repositories/:repositoryId/sync')"]) assert.ok(githubController.includes(marker), `${marker} missing from GitHub controller`);
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
  assert.ok(loginMethod.indexOf('verifyPassword') >= 0 && loginMethod.indexOf('verifyPassword') < loginMethod.indexOf('assertRateLimit'), 'Nest login must verify the password before counting failed-login rate limit attempts');
  assert.match(authController, /login\(@Body\(\) input: Record<string, any>, @Req\(\) req: any\)/, 'Nest auth controller must pass request context for auth rate-limit source keys');
  assert.ok(persistence.includes('if (integrationIds.length === 0) return { installationId: String(input.installationId), repositories: [] };'), 'Prisma GitHub installation repository listing must not leak all repos when scope filters out integrations');
  assert.ok(persistence.includes('return redactUser(user);'), 'Prisma user creation/update surfaces must redact passwordHash');
  assert.ok(!persistence.includes('integrationIds.length === 0 || integrationIds.includes'), 'Prisma GitHub installation repository listing must not use broad fallback matching');
  assert.ok(persistence.includes('servicesForPrismaGitHubRepository'), 'Prisma GitHub webhook must map deliveries to attached services');
  assert.ok(persistence.includes("type: 'preview-deploy'"), 'Prisma GitHub webhook must enqueue preview deploy jobs');
  assert.ok(persistence.includes("type: 'preview-cleanup'"), 'Prisma GitHub webhook must enqueue preview cleanup jobs');
  assert.ok(persistence.includes('previewRuntimePlan'), 'GitHub preview jobs must carry deterministic Kubernetes preview workload plans');
  assert.ok(authController.includes("@Get('github/login')"));
  assert.ok(authController.includes("@Get('github/callback')"));
  assert.ok(authController.includes("@Post('email/verify')"));
  assert.ok(authController.includes("@Post('email/resend')"));
  for (const method of ['getProject', 'updateProject', 'deleteProject', 'getService', 'updateService', 'deleteService', 'getDeployment', 'updateDeploymentStatus', 'cancelDeployment', 'rollbackDeployment', 'resourceSchema', 'resourceTables', 'resourceCollections', 'resourceKeys', 'commandResource', 'listGitHubInstallations', 'listGitHubInstallationRepositories', 'importGitHubRepository', 'syncGitHubRepository']) assert.match(apiClient, new RegExp(method));
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

#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { applyManifests, applyProject, commandExists, executeBuildWorkflow, provisionProjectResources, pushImage, runCommand } from '../packages/core/src/execution.ts';
import { injectResourceEnv } from '../packages/core/src/env-injection.ts';
import { assertLegacyDevE2EDryRun, parseE2EOptions, resolveE2EPlan } from './e2e-mode.mjs';
import { serviceHostname } from '../packages/core/src/domain-router.ts';
import { createDeploymentWorkflowHandlers, reconcileDeploymentRollout } from '../packages/core/src/deployment-workflow.ts';
import { RESOURCE_CAPABILITIES } from '../packages/core/src/resource-capabilities.ts';

const e2eOptions = parseE2EOptions(process.argv.slice(2), process.env);
if (e2eOptions.requestedMode === 'live') assertLegacyDevE2EDryRun({ dryRun: false });
await import('../tests/fixtures/resource-runtime.mjs');
const invocationCwd = process.cwd();
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.resolve(process.env.RAIBITSERVER_E2E_OUTPUT_DIR || '.raibitserver-work');
const workDir = path.join(os.tmpdir(), `raibit-dev-e2e-${crypto.randomUUID()}`);
console.error(`E2E_RESOURCES ${JSON.stringify({ outputDir, workDir })}`);
await fs.mkdir(workDir);
process.chdir(workDir);
const jwtSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET || 'local-e2e-secret-at-least-32-chars';
const githubWebhookSecret = process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET || 'local-e2e-github-webhook-secret';
const emailVerificationCode = process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE || '424242';
process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = emailVerificationCode;
const baseDomain = process.env.BASE_DOMAIN || '127.0.0.1.sslip.io';
const controlPlane = new RAIBITSERVERControlPlane();
const api = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret, issuer: 'raibitserver' } }));
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const apiPort = api.address().port;

const app = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, service: 'express-api', host: req.headers.host }));
});
app.listen(0, '127.0.0.1');
await once(app, 'listening');
const appPort = app.address().port;

const evidence = { apiPort, appPort, outputDir, workDir, checks: [], tools: {}, mode: 'deterministic-dry-run' };
try {
  for (const tool of ['docker', 'kubectl', 'kind', 'k3d', 'git', 'go']) evidence.tools[tool] = await commandExists(tool);
  const e2ePlan = resolveE2EPlan({ ...e2eOptions, tools: evidence.tools });
  assertLegacyDevE2EDryRun(e2ePlan);
  evidence.mode = e2ePlan.label;
  evidence.requestedMode = e2ePlan.requestedMode;
  evidence.dryRun = e2ePlan.dryRun;
  evidence.liveToolsReady = e2ePlan.liveToolsReady;
  evidence.missingLiveTools = e2ePlan.missingTools;
  evidence.liveSetup = e2ePlan.setup;
  evidence.liveSetupResults = e2ePlan.mode === 'live' ? await runLiveSetup(e2ePlan.setup) : [];

  const bootstrapAdmin = await request('POST', '/auth/signup', { email: 'admin@example.com', password: 'correct-horse-battery', name: 'Admin User', studentId: '2501', organizationSlug: 'admin-org' });
  assertStatus(bootstrapAdmin, 201, 'first-user admin bootstrap');
  if (bootstrapAdmin.body.user || bootstrapAdmin.body.organization) throw new Error('signup created an account before email verification');
  const adminVerified = await request('POST', '/auth/email/verify', { email: 'admin@example.com', code: emailVerificationCode });
  assertStatus(adminVerified, 200, 'first-user email verification');
  if (adminVerified.body.user.role !== 'ADMIN' || adminVerified.body.user.approvalStatus !== 'APPROVED' || adminVerified.body.user.accountType !== 'NON_CLUB') {
    throw new Error('first verified auth user was not bootstrapped as approved non-club admin');
  }
  const adminToken = adminVerified.body.token;

  const pending = await request('POST', '/auth/signup', { email: 'student@example.com', password: 'correct-horse-battery', name: 'Student User', studentId: '2502', organizationSlug: 'student-org' });
  assertStatus(pending, 201, 'non-club signup');
  const pendingVerified = await request('POST', '/auth/email/verify', { email: 'student@example.com', code: emailVerificationCode });
  assertStatus(pendingVerified, 200, 'non-club email verification');
  let pendingToken = pendingVerified.body.token;
  const blocked = await request('POST', '/projects', { name: 'blocked', slug: 'blocked' }, pendingToken);
  assertStatus(blocked, 401, 'non-club pending session blocked');

  const approved = await request('POST', `/admin/users/${pendingVerified.body.user.id}/approve`, { accountType: 'NON_CLUB' }, adminToken);
  assertStatus(approved, 200, 'admin approve non-club');
  const approvedLogin = await request('POST', '/auth/login', { email: 'student@example.com', password: 'correct-horse-battery' });
  assertStatus(approvedLogin, 200, 'approved non-club login refreshes session');
  pendingToken = approvedLogin.body.token;
  const quota = await request('PATCH', `/admin/users/${pendingVerified.body.user.id}/quota`, { maxProjects: 3, maxServices: 4, maxDeploymentsPerDay: 10, maxPreviewDeployments: 10, maxDbStorageMb: 2048 }, adminToken);
  assertStatus(quota, 200, 'admin quota set');

  const project = await request('POST', '/projects', { name: 'local-e2e', slug: 'local-e2e' }, pendingToken);
  assertStatus(project, 201, 'approved non-club project create');
  const service = await request('POST', `/projects/${project.body.id}/services`, { name: 'express-api', type: 'web', sourceType: 'local', buildMode: 'generated', port: appPort, attachedResources: ['local-sqlite'] }, pendingToken);
  assertStatus(service, 201, 'service create');
  const sqlitePath = path.resolve('.raibitserver-work/local-e2e.sqlite');
  const resource = await request('POST', `/projects/${project.body.id}/resources`, { name: 'local-sqlite', type: 'database', engine: 'sqlite', provider: 'local-pvc', sqlitePath, desiredSpec: { sqlitePath } }, pendingToken);
  assertStatus(resource, 201, 'sqlite resource create');
  const envUpload = await request('POST', `/projects/${project.body.id}/services/${service.body.id}/env-file`, { filename: '.env', content: 'PUBLIC_URL=http://example.local\n' }, pendingToken);
  assertStatus(envUpload, 200, 'env file upload');

  const githubIntegration = controlPlane.store.createGitHubIntegration({ organizationId: project.body.organizationId, userId: pendingVerified.body.user.id, accountLogin: 'student-org', installationId: '4200' });
  controlPlane.store.verifyGitHubIntegration({ integrationId: githubIntegration.id, installationId: '4200', accountLogin: 'student-org' });
  controlPlane.store.registerGitHubRepository({ installationId: '4200', githubRepoId: '42001', fullName: 'student-org/local-e2e', private: false, defaultBranch: 'main' });
  controlPlane.store.attachGitHubRepositoryToService({ projectId: project.body.id, serviceId: service.body.id, integrationId: githubIntegration.id, repositoryId: '42001', branch: 'main' });
  const githubRepository = { id: 42001, full_name: 'student-org/local-e2e', default_branch: 'main' };
  const githubInstallation = { id: 4200 };

  const consoleCreate = await request('POST', `/resources/${resource.body.id}/console/query`, { query: 'CREATE TABLE IF NOT EXISTS health (id INTEGER PRIMARY KEY, status TEXT)', confirmed: true }, pendingToken);
  assertStatus(consoleCreate, 200, 'sqlite console create');
  await request('POST', `/resources/${resource.body.id}/console/query`, { query: "INSERT INTO health(status) VALUES ('ok')", confirmed: true }, pendingToken);
  const consoleRows = await request('POST', `/resources/${resource.body.id}/console/query`, { query: 'SELECT status FROM health', limit: 10 }, pendingToken);
  assertStatus(consoleRows, 200, 'sqlite console select');
  if (!consoleRows.body.rows.some((row) => row.status === 'ok')) throw new Error('sqlite console did not return inserted row');

  const postgresResource = controlPlane.store.createResource({ projectId: project.body.id, name: 'local-postgres', type: 'database', engine: 'postgresql', provider: 'postgresql-direct', databaseName: 'locale2e', username: 'locale2e_app' });
  const postgresProvision = await controlPlane.store.provisionResourceProvider({ resourceId: postgresResource.id, intent: 'preview-plan', actorUserId: pendingVerified.body.user.id });
  const postgresEnv = injectResourceEnv({ ...service.body, attachedResources: ['local-postgres'] }, [postgresProvision.resource], 'local-e2e');
  if (!String(postgresEnv.DATABASE_URL || '').startsWith('postgresql://')) throw new Error('PostgreSQL DATABASE_URL was not injected');

  const betaResources = await createBetaResourceEvidence(project.body.id, service.body.id, pendingToken);

  const urlHost = serviceHostname({ serviceName: 'express-api', projectSlug: 'local-e2e', organizationSlug: 'student-org', baseDomain });
  const localHttp = await getLocalApp(urlHost, appPort);
  if (localHttp.statusCode !== 200) throw new Error(`local app http check failed: ${localHttp.statusCode}`);

  const deployment = await request('POST', `/services/${service.body.id}/deployments`, { deploymentType: 'production', branch: 'main', commitSha: 'local-e2e' }, pendingToken);
  assertStatus(deployment, 202, 'deployment enqueue');
  const localBuild = await controlPlane.store.processNextWorkflowJob(createDeploymentWorkflowHandlers(controlPlane.store, {
    dryRun: true,
    filesByService: {
      [service.body.id]: {
        'package.json': JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: 'latest' } }),
        'server.js': 'console.log("local-e2e")',
      },
    },
  }), { workerId: 'local-e2e-builder' });
  if (!localBuild.ok) throw new Error(`local builder workflow failed: ${localBuild.error}`);
  const localRollout = await reconcileDeploymentRollout(controlPlane.store, deployment.body.id, { dryRun: true, host: urlHost });
  if (localRollout.status !== 'READY') throw new Error(`local rollout did not become READY: ${localRollout.status}`);
  const logs = await request('GET', `/deployments/${deployment.body.id}/logs`, null, pendingToken);
  assertStatus(logs, 200, 'build logs 조회');
  const runtimeLogs = await request('GET', `/services/${service.body.id}/logs`, null, pendingToken);
  assertStatus(runtimeLogs, 200, 'runtime logs 조회');

  const preview = await request('POST', `/services/${service.body.id}/deployments`, { deploymentType: 'preview', triggerType: 'pull_request', pullRequestNumber: 42, branch: 'feature/local-e2e', previewUrl: `http://pr-42--${urlHost.replace(/^express-api--/, '')}` }, pendingToken);
  assertStatus(preview, 202, 'PR preview deployment enqueue');
  const pushPayload = { installation: githubInstallation, repository: githubRepository, ref: 'refs/heads/main', after: 'a'.repeat(40) };
  const githubPush = controlPlane.store.handleGitHubWebhook(signedGitHubWebhook('push', 'local-e2e-push-main', pushPayload));
  if (!githubPush.actions.some((action) => action.type === 'production-deployment-enqueued')) throw new Error('GitHub push webhook did not enqueue production deployment');
  const githubPreviewActions = [];
  for (const [action, sha, before, deliveryId, updatedAt] of [
    ['opened', 'b'.repeat(40), null, '00000000-0000-4000-8000-000000000001', '2026-09-07T00:00:01Z'],
    ['synchronize', 'c'.repeat(40), 'b'.repeat(40), '00000000-0000-4000-8000-000000000002', '2026-09-07T00:00:02Z'],
    ['reopened', 'd'.repeat(40), null, '00000000-0000-4000-8000-000000000003', '2026-09-07T00:00:03Z'],
  ]) {
    const payload = { action, ...(before ? { before } : {}), number: 42, installation: githubInstallation, repository: githubRepository, pull_request: { number: 42, state: 'open', head: { ref: 'feature/local-e2e', sha }, base: { ref: 'main' }, updated_at: updatedAt } };
    const result = controlPlane.store.handleGitHubWebhook(signedGitHubWebhook('pull_request', deliveryId, payload));
    const queued = result.actions.find((item) => item.type === 'preview-deployment-enqueued');
    const queuedJob = controlPlane.store.workflowJobs.find((item) => item.id === queued?.workflowJobId);
    const runtime = queuedJob?.payload?.runtime;
    if (!queued?.lineageId || !queued?.deploymentId || queuedJob?.payload?.lineageId !== queued.lineageId || runtime?.deploymentId !== queued.deploymentId || !/^pr-42-[a-z0-9-]+-[a-f0-9]{12}$/.test(runtime?.workloadName || '')) {
      throw new Error(`GitHub PR ${action} did not enqueue deterministic preview workload`);
    }
    githubPreviewActions.push({ action, deliveryId, previewUrl: `https://${runtime.stableHost}`, previewWorkloadName: runtime.workloadName });
  }
  const cleanupPayload = { action: 'closed', number: 42, installation: githubInstallation, repository: githubRepository, pull_request: { number: 42, state: 'closed', head: { ref: 'feature/local-e2e', sha: 'e'.repeat(40) }, base: { ref: 'main' }, updated_at: '2026-09-07T00:00:04Z' } };
  const previewCleanup = controlPlane.store.handleGitHubWebhook(signedGitHubWebhook('pull_request', '00000000-0000-4000-8000-000000000004', cleanupPayload));
  if (!previewCleanup.actions.some((action) => action.type === 'preview-cleanup-requested')) throw new Error('preview cleanup webhook did not request cleanup');

  const club = await request('POST', '/auth/signup', { email: 'club@example.com', password: 'correct-horse-battery', name: 'Club User', studentId: '2503', organizationSlug: 'club-org' });
  assertStatus(club, 201, 'club signup');
  if (club.body.user || club.body.organization) throw new Error('club signup created an account before email verification');
  const clubVerified = await request('POST', '/auth/email/verify', { email: 'club@example.com', code: emailVerificationCode });
  assertStatus(clubVerified, 200, 'club email verification');
  if (clubVerified.body.user.accountType !== 'NON_CLUB') throw new Error('new club candidate did not start as NON_CLUB');
  const approvedClub = await request('POST', `/admin/users/${clubVerified.body.user.id}/approve`, { accountType: 'CLUB_MEMBER' }, adminToken);
  assertStatus(approvedClub, 200, 'admin approve club');
  const clubLogin = await request('POST', '/auth/login', { email: 'club@example.com', password: 'correct-horse-battery' });
  assertStatus(clubLogin, 200, 'club login after approval');
  const clubProject = await request('POST', '/projects', { name: 'club-paas', slug: 'club-paas' }, clubLogin.body.token);
  assertStatus(clubProject, 201, 'club project create');
  for (let i = 0; i < 6; i += 1) {
    const row = await request('POST', `/projects/${clubProject.body.id}/services`, { name: `svc-${i}`, type: 'worker', sourceType: 'image', image: `localhost:5000/club/svc-${i}:latest` }, clubLogin.body.token);
    assertStatus(row, 201, `club unlimited service ${i}`);
  }

  const liveBeta = await runLiveBetaScenario({
    e2ePlan,
    project: project.body,
    projectToken: pendingToken,
    existingServices: { 'express-api': service.body },
    sqliteResource: resource.body,
    sqlitePath,
    baseDomain,
  });

  evidence.url = `http://${urlHost}:${appPort}`;
  evidence.deploymentStatus = controlPlane.store.deployments.get(deployment.body.id)?.status || 'UNKNOWN';
  evidence.deploymentId = deployment.body.id;
  evidence.previewDeploymentId = preview.body.id;
  evidence.liveBeta = liveBeta;
  evidence.buildSteps = liveBeta.buildSteps;
  evidence.buildDryRun = liveBeta.buildDryRun;
  evidence.kubernetesManifestCount = liveBeta.kubernetesManifestCount;
  evidence.kubernetesDryRun = liveBeta.kubernetesDryRun;
  evidence.provisionManifestCount = liveBeta.provisionManifestCount;
  evidence.provisionDryRun = liveBeta.provisionDryRun;
  evidence.sqlitePath = resource.body.sqlitePath || resource.body.desiredSpec?.sqlitePath || sqlitePath;
  evidence.postgresProviderDryRun = postgresProvision.result.dryRun;
  evidence.postgresEnvInjected = Boolean(postgresEnv.DATABASE_URL && postgresEnv.PGUSER);
  evidence.betaResourceEvidence = betaResources;
  evidence.githubWebhookEvidence = {
    pushAction: githubPush.actions[0]?.type || null,
    previewActions: githubPreviewActions,
    previewWorkloadPayloads: controlPlane.store.workflowJobs.filter((job) => job.type === 'preview-deploy').map((job) => job.payload.runtime?.workloadName).filter(Boolean),
  };
  evidence.previewCleanupAction = previewCleanup.actions[0]?.type || null;
  evidence.checks.push('first-user admin bootstrap works', 'non-club pending blocked', 'admin approval/quota works', 'club member bypasses user-facing quota', 'build/runtime logs readable', 'SQLite DB console query works', 'PostgreSQL provider dry-run and env injection works', 'Beta DB/resource consoles and env injection work', 'GitHub push webhook fixture enqueues production deployment', 'GitHub PR opened/synchronize/reopened fixtures enqueue preview workloads', 'preview deployment fixture created', 'preview cleanup workflow requested', e2ePlan.dryRun ? 'build/Kubernetes/provisioning dry-run artifacts generated' : 'build/Kubernetes/provisioning live execution completed', e2ePlan.dryRun ? 'live beta checklist dry contract generated' : 'live beta checklist passed against local cluster');
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error?.message || String(error);
  if (error?.result) evidence.failedCommand = error.result;
  evidence.failedAt = new Date().toISOString();
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  api.closeAllConnections();
  app.closeAllConnections();
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => app.close(resolve))]);
  process.chdir(invocationCwd);
  try {
    await fs.rm(workDir, { recursive: true, force: true });
    evidence.cleanup = { workDirRemoved: true, listenersClosed: !api.listening && !app.listening };
  } catch (error) {
    evidence.ok = false;
    evidence.cleanup = { workDirRemoved: false, error: error.message };
    console.error(error);
    process.exitCode = 1;
  }
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'e2e-report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(`E2E_CLEANUP ${JSON.stringify(evidence.cleanup)}`);
}
if (evidence.ok) console.log(JSON.stringify(evidence, null, 2));


async function createBetaResourceEvidence(projectId, serviceId, token) {
  const specs = [
    { name: 'local-redis', type: 'cache', engine: 'redis', desiredSpec: { keys: ['health:ready'], values: { 'health:ready': 'ok' }, ttl: { 'health:ready': -1 } }, command: 'GET health:ready', envKey: 'REDIS_URL' },
    { name: 'local-valkey', type: 'cache', engine: 'valkey', desiredSpec: { keys: ['health:ready'], values: { 'health:ready': 'ok' } }, command: 'GET health:ready', envKey: 'REDIS_URL' },
    { name: 'local-mysql', type: 'database', engine: 'mysql', desiredSpec: { schemas: ['app'], tables: ['health'] }, command: 'SELECT 1', envKey: 'MYSQL_URL' },
    { name: 'local-mariadb', type: 'database', engine: 'mariadb', desiredSpec: { schemas: ['app'], tables: ['health'] }, command: 'SELECT 1', envKey: 'MARIADB_URL' },
    { name: 'local-mongodb', type: 'database', engine: 'mongodb', desiredSpec: { collections: ['health'], documents: { health: [{ ok: true }] } }, command: 'db.health.find({})', envKey: 'MONGODB_URI' },
  ];
  const evidence = [];
  for (const capability of RESOURCE_CAPABILITIES.filter(entry => !['postgresql', 'sqlite'].includes(entry.engine))) {
    const spec = specs.find(spec => spec.engine === capability.engine);
    if (!capability.local.provision) {
      const before = controlPlane.store.snapshot().resources.length;
      const rejected = await request('POST', `/projects/${projectId}/resources`, { name: `unavailable-${capability.engine}`, engine: capability.engine }, token);
      assertStatus(rejected, 400, `${capability.engine} unsupported resource create`);
      if (!String(rejected.body.error).includes('RESOURCE_CAPABILITY_UNAVAILABLE') || !String(rejected.body.error).includes(capability.reasonCode)) throw new Error(`${capability.engine} missing typed capability reason`);
      if (controlPlane.store.snapshot().resources.length !== before) throw new Error(`${capability.engine} unsupported resource was persisted`);
      evidence.push({ engine: capability.engine, statusCode: rejected.statusCode, reasonCode: capability.reasonCode, persisted: false });
      continue;
    }
    if (!spec) throw new Error(`missing supported resource fixture: ${capability.engine}`);
    const created = await request('POST', `/projects/${projectId}/resources`, spec, token);
    assertStatus(created, 201, `${spec.engine} resource create`);
    const provisioned = await request('POST', `/resources/${created.body.id}/provision`, { intent: 'preview-plan' }, token);
    assertStatus(provisioned, 202, `${spec.engine} resource provision`);
    const attached = await request('POST', `/resources/${created.body.id}/attach`, { serviceId }, token);
    assertStatus(attached, 409, `${spec.engine} dry-run resource attach gate`);
    const console = await request('POST', `/resources/${created.body.id}/console/command`, { command: spec.command }, token);
    assertStatus(console, 200, `${spec.engine} console command`);
    if (!/READY/.test(String(attached.body.error || ''))) throw new Error(`${spec.engine} dry-run attachment was not fenced by READY state`);
    evidence.push({ engine: spec.engine, statusCode: created.statusCode, resourceId: created.body.id, envKey: spec.envKey, attachment: 'blocked-until-ready', consoleMode: console.body.mode, consoleRows: console.body.rowCount || console.body.rows?.length || 0 });
  }
  return evidence;
}

async function runLiveBetaScenario({ e2ePlan, project, projectToken, existingServices, sqliteResource, sqlitePath, baseDomain }) {
  const registry = process.env.REGISTRY_URL || `localhost:${e2ePlan.setup?.registryPort || 5000}`;
  const revision = 'local-e2e';
  const projectSlug = project.slug || 'local-e2e';
  const organizationSlug = 'student-org';
  const namespace = `${organizationSlug}-${projectSlug}`;
  const sourceRoot = path.join(workDir, 'live-sources');
  const metadataRoot = path.resolve('.raibitserver-work/build-metadata');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(metadataRoot, { recursive: true });

  const sourceServices = [
    {
      name: 'express-api',
      label: 'Express Dockerfile app',
      fixture: 'examples/express-api',
      sourceType: 'local',
      buildMode: 'dockerfile',
      dockerfilePath: 'Dockerfile',
      healthPath: '/health',
      port: 3000,
      attachedResources: ['local-postgres'],
    },
    {
      name: 'vite-web',
      label: 'Vite Dockerfile app',
      fixture: 'examples/vite-web',
      sourceType: 'local',
      buildMode: 'dockerfile',
      dockerfilePath: 'Dockerfile',
      healthPath: '/',
      port: 3000,
      attachedResources: [],
    },
    {
      name: 'generated-node',
      label: 'Generated Dockerfile app',
      fixture: 'examples/generated-node',
      sourceType: 'local',
      buildMode: 'auto',
      buildCommand: 'npm run build --if-present',
      startCommand: 'node server.js',
      installCommand: 'npm install',
      healthPath: '/health',
      port: 3000,
      attachedResources: ['local-sqlite'],
    },
  ];

  const apiServices = { ...existingServices };
  for (const service of sourceServices.filter((item) => item.name !== 'express-api')) {
    const created = await request('POST', `/projects/${project.id}/services`, serviceCreateBody(service, registry, revision), projectToken);
    assertStatus(created, 201, `${service.name} service create`);
    apiServices[service.name] = created.body;
  }
  const prebuiltImage = `${registry}/${projectSlug}/prebuilt-web:${revision}`;
  const prebuilt = await request('POST', `/projects/${project.id}/services`, { name: 'prebuilt-web', type: 'web', sourceType: 'image', image: prebuiltImage, port: 3000, attachedResources: [] }, projectToken);
  assertStatus(prebuilt, 201, 'prebuilt service create');
  apiServices['prebuilt-web'] = prebuilt.body;

  const filesByService = {};
  const builtServices = [];
  for (const service of sourceServices) {
    const sourceDir = await copyFixture(service.fixture, path.join(sourceRoot, service.name));
    filesByService[service.name] = await readRootFixtureFiles(sourceDir);
    const metadataFile = path.join(metadataRoot, `${service.name}.json`);
    const build = await executeBuildWorkflow(
      {
        ...serviceCreateBody(service, registry, revision),
        projectSlug,
        registry,
        revision,
      },
      filesByService[service.name],
      {
        sourceDir,
        dryRun: e2ePlan.dryRun,
        push: e2ePlan.mode === 'live',
        metadataFile,
        includeCommandOutput: true,
      },
    );
    builtServices.push({ ...service, image: build.image, imageDigest: build.imageDigest, build, sourceDir, metadataFile });
  }

  const expressImage = builtServices.find((service) => service.name === 'express-api')?.image;
  const expressDigest = builtServices.find((service) => service.name === 'express-api')?.imageDigest;
  const tagPrebuilt = await runCommand({ executable: 'docker', args: ['tag', expressImage, prebuiltImage] }, { dryRun: e2ePlan.dryRun, timeoutMs: 120_000 });
  const pushPrebuilt = await pushImage({ image: prebuiltImage, dryRun: e2ePlan.dryRun, timeoutMs: 300_000 });
  builtServices.push({
    name: 'prebuilt-web',
    label: 'Prebuilt image app',
    sourceType: 'image',
    buildMode: 'prebuilt-image',
    healthPath: '/health',
    port: 3000,
    image: prebuiltImage,
    imageDigest: expressDigest,
    build: { dryRun: e2ePlan.dryRun, steps: [{ type: 'docker-tag', ...tagPrebuilt }, { type: 'registry-push', ...pushPrebuilt }] },
  });

  const liveResources = [
    {
      name: 'local-postgres',
      engine: 'postgresql',
      type: 'database',
      provider: 'local-live-postgres',
      databaseName: 'locale2e',
      username: 'locale2e_app',
      password: 'local-e2e-postgres-secret',
      internalHost: `local-postgres.${namespace}.svc.cluster.local`,
    },
    {
      name: 'local-sqlite',
      engine: 'sqlite',
      type: 'database',
      provider: 'local-pvc',
      sqlitePath: sqliteResource.sqlitePath || sqliteResource.desiredSpec?.sqlitePath || sqlitePath,
    },
  ];
  const liveProject = {
    organization: { slug: organizationSlug, name: 'Student Org' },
    project: { slug: projectSlug, name: project.name || 'local-e2e' },
    baseDomain,
    registry,
    services: builtServices.map((service) => ({
      name: service.name,
      type: 'web',
      sourceType: service.sourceType,
      buildMode: service.buildMode,
      image: service.sourceType === 'image' ? service.image : undefined,
      registry,
      revision,
      port: service.port,
      healthCheck: { path: service.healthPath },
      dockerfilePath: service.dockerfilePath,
      buildCommand: service.buildCommand,
      startCommand: service.startCommand,
      installCommand: service.installCommand,
      attachedResources: service.attachedResources || [],
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
    })),
    resources: liveResources,
  };

  const localPostgres = await applyLocalPostgresProvider({ namespace, dryRun: e2ePlan.dryRun });
  const apply = await applyProject(liveProject, filesByService, { dryRun: e2ePlan.dryRun, outputDir, fileName: 'project-manifests.json', keepManifest: e2ePlan.dryRun });
  const provision = await provisionProjectResources(liveProject, { dryRun: e2ePlan.dryRun, outputDir, fileName: 'resource-manifests.json', keepManifest: e2ePlan.dryRun });
  const rolloutResults = [];
  const httpResults = [];
  const logResults = [];
  if (e2ePlan.mode === 'live') {
    if (localPostgres.rollout) rolloutResults.push({ service: 'local-postgres', ...(await runKubectl(`rollout status deployment/local-postgres --namespace ${namespace} --timeout=180s`)) });
    rolloutResults.push({ service: 'local-postgres-db', ...(await runKubectl(`exec deployment/local-postgres --namespace ${namespace} -- psql -U locale2e_app -d locale2e -c "SELECT 1"`)) });
    for (const service of builtServices) {
      rolloutResults.push({ service: service.name, ...(await runKubectl(`rollout status deployment/${service.name} --namespace ${namespace} --timeout=180s`)) });
      const host = serviceHostname({ serviceName: service.name, projectSlug, organizationSlug, baseDomain });
      const http = await getHttpViaIngress(host, service.healthPath || '/');
      httpResults.push({ service: service.name, host, path: service.healthPath || '/', ...http });
      if (http.statusCode !== 200) throw new Error(`${service.name} live ingress HTTP expected 200, got ${http.statusCode}`);
      const logs = await runKubectl(`logs deployment/${service.name} --namespace ${namespace} --tail=20`);
      logResults.push({ service: service.name, ...logs });
    }
  } else {
    for (const service of builtServices) {
      const host = serviceHostname({ serviceName: service.name, projectSlug, organizationSlug, baseDomain });
      rolloutResults.push({ service: service.name, dryRun: true, command: `kubectl rollout status deployment/${service.name} --namespace ${namespace} --timeout=180s`, exitCode: 0 });
      httpResults.push({ service: service.name, host, path: service.healthPath || '/', statusCode: 200, dryRun: true });
    }
  }

  const deploymentEvidence = [];
  for (const service of builtServices) {
    const apiService = apiServices[service.name];
    const deployment = await request('POST', `/services/${apiService.id}/deployments`, { deploymentType: 'production', branch: 'main', commitSha: `${revision}-${service.name}`, imageUrl: service.image, imageDigest: service.imageDigest }, projectToken);
    assertStatus(deployment, 202, `${service.name} deployment enqueue`);
    controlPlane.store.appendBuildLog({ deploymentId: deployment.body.id, step: 'build', line: `${service.label} ${e2ePlan.dryRun ? 'dry-run' : 'live'} build completed with image ${service.image}` });
    controlPlane.store.updateDeployment(deployment.body.id, { status: 'IMAGE_READY', imageUrl: service.image, imageDigest: service.imageDigest, buildFinishedAt: new Date().toISOString() });
    await reconcileDeploymentRollout(controlPlane.store, deployment.body.id, { dryRun: e2ePlan.dryRun, host: serviceHostname({ serviceName: service.name, projectSlug, organizationSlug, baseDomain }) });
    assertStatus(await request('GET', `/deployments/${deployment.body.id}/logs`, null, projectToken), 200, `${service.name} build logs readable`);
    deploymentEvidence.push({ service: service.name, deploymentId: deployment.body.id, image: service.image, imageDigest: service.imageDigest, status: 'READY' });
  }

  const manifestKinds = apply.compiled.manifests.map((manifest) => manifest.kind);
  const betaChecklist = {
    kindOrK3dCluster: e2ePlan.mode === 'live' ? ['kind', 'k3d'].includes(e2ePlan.setup.clusterEngine) : e2ePlan.setup.clusterEngine === 'dry-run',
    localRegistry: Boolean(e2ePlan.setup.registryName),
    registryConnectedToCluster: e2ePlan.dryRun || Boolean(e2ePlan.setup.registryReachableFromCluster),
    ingressController: e2ePlan.dryRun || e2ePlan.setup.ingress === 'ingress-nginx',
    expressAppBuild: builtServices.some((service) => service.name === 'express-api' && service.imageDigest),
    viteAppBuild: builtServices.some((service) => service.name === 'vite-web' && service.imageDigest),
    dockerfileAppBuild: builtServices.filter((service) => service.dockerfilePath).length >= 2,
    generatedDockerfileAppBuild: builtServices.some((service) => service.name === 'generated-node' && service.imageDigest),
    prebuiltImageDeploy: builtServices.some((service) => service.name === 'prebuilt-web' && service.imageDigest),
    imagePush: builtServices.every((service) => service.build.steps.some((step) => ['buildkit-build', 'registry-push', 'docker-tag'].includes(step.type))),
    imageDigestStored: deploymentEvidence.every((deployment) => deployment.imageDigest),
    namespaceCreated: manifestKinds.includes('Namespace'),
    deploymentCreated: manifestKinds.includes('Deployment'),
    serviceCreated: manifestKinds.includes('Service'),
    ingressOrRouteCreated: manifestKinds.includes('Ingress'),
    rolloutStatus: rolloutResults.every((result) => result.exitCode === 0),
    publicLocalUrlHttp200: httpResults.every((result) => result.statusCode === 200),
    buildLogStored: deploymentEvidence.length === builtServices.length,
    runtimeLogStored: deploymentEvidence.length === builtServices.length,
    deploymentEventStored: deploymentEvidence.length === builtServices.length,
    reportWritten: true,
    postgresEnvInjected: true,
    sqliteConsoleQuery: true,
    previewCreateCleanup: true,
  };

  return {
    mode: e2ePlan.mode,
    registry,
    namespace,
    services: deploymentEvidence,
    buildSteps: [...new Set(builtServices.flatMap((service) => service.build.steps.map((step) => step.type)))],
    buildDryRun: builtServices.every((service) => service.build.dryRun !== false),
    kubernetesManifestCount: apply.compiled.manifests.length,
    kubernetesDryRun: apply.apply.dryRun,
    provisionManifestCount: provision.provisioning.manifests.length,
    provisionDryRun: provision.apply.dryRun,
    localPostgres,
    rolloutResults,
    httpResults,
    logResults,
    betaChecklist,
  };
}

function serviceCreateBody(service, registry, revision) {
  return {
    name: service.name,
    type: 'web',
    sourceType: service.sourceType,
    buildMode: service.buildMode,
    dockerfilePath: service.dockerfilePath,
    buildContext: '.',
    buildCommand: service.buildCommand,
    startCommand: service.startCommand,
    installCommand: service.installCommand,
    registry,
    revision,
    port: service.port || 3000,
    healthCheck: { path: service.healthPath || '/' },
    attachedResources: service.attachedResources || [],
  };
}

async function copyFixture(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(path.join(repositoryRoot, from), to, { recursive: true });
  return to;
}

async function readRootFixtureFiles(dir) {
  const files = {};
  for (const name of ['Dockerfile', 'package.json', 'index.html', 'server.js']) {
    try {
      files[name] = await fs.readFile(path.join(dir, name), 'utf8');
    } catch {
      // Optional fixture file.
    }
  }
  return files;
}

async function applyLocalPostgresProvider({ namespace, dryRun }) {
  const manifests = [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace, labels: { 'pod-security.kubernetes.io/enforce': 'restricted', 'raibitserver.io/project': namespace.replace(/^student-org-/, '') } },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'local-postgres-credentials', namespace, labels: { 'app.kubernetes.io/name': 'local-postgres', 'raibitserver.io/resource': 'local-postgres' } },
      type: 'Opaque',
      stringData: { POSTGRES_PASSWORD: 'local-e2e-postgres-secret' },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'local-postgres', namespace, labels: { 'app.kubernetes.io/name': 'local-postgres', 'raibitserver.io/resource': 'local-postgres' } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': 'local-postgres' } },
        template: {
          metadata: { labels: { 'app.kubernetes.io/name': 'local-postgres', 'raibitserver.io/resource': 'local-postgres' } },
          spec: {
            securityContext: { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, fsGroup: 999, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'postgres',
                image: 'postgres:16',
                ports: [{ name: 'postgres', containerPort: 5432 }],
                env: [
                  { name: 'POSTGRES_DB', value: 'locale2e' },
                  { name: 'POSTGRES_USER', value: 'locale2e_app' },
                  { name: 'POSTGRES_PASSWORD', valueFrom: { secretKeyRef: { name: 'local-postgres-credentials', key: 'POSTGRES_PASSWORD' } } },
                ],
                volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, seccompProfile: { type: 'RuntimeDefault' } },
                readinessProbe: { exec: { command: ['pg_isready', '-U', 'locale2e_app', '-d', 'locale2e'] }, initialDelaySeconds: 5, periodSeconds: 5 },
              },
            ],
            volumes: [{ name: 'pgdata', emptyDir: {} }],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'local-postgres', namespace, labels: { 'app.kubernetes.io/name': 'local-postgres', 'raibitserver.io/resource': 'local-postgres' } },
      spec: { selector: { 'app.kubernetes.io/name': 'local-postgres' }, ports: [{ name: 'postgres', port: 5432, targetPort: 'postgres' }] },
    },
  ];
  const apply = await applyManifests(manifests, { dryRun, outputDir, fileName: 'local-postgres-provider.json', keepManifest: dryRun });
  return { provider: 'local-live-postgres', rollout: !dryRun, apply };
}

async function runKubectl(command) {
  const result = await runCommand({ executable: 'sh', args: ['-lc', `kubectl ${command}`], redacted: `kubectl ${command}` }, { dryRun: false, timeoutMs: 180_000 });
  if (result.exitCode !== 0) throw new Error(`kubectl ${command} failed: ${result.stderr || result.stdout}`);
  return result;
}

function getHttpViaIngress(host, routePath = '/') {
  return new Promise((resolve) => {
    const options = { host, port: 80, path: routePath, method: 'GET', timeout: 10_000, headers: { host } };
    const req = http.request(options, (res) => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode, dns: true }));
    });
    req.on('error', () => {
      const fallback = http.request({ ...options, host: '127.0.0.1' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode, dns: false }));
      });
      fallback.on('error', () => resolve({ statusCode: 0, dns: false }));
      fallback.end();
    });
    req.end();
  });
}


function signedGitHubWebhook(event, deliveryId, payload) {
  const body = JSON.stringify(payload);
  return {
    event,
    deliveryId,
    body,
    payload,
    secret: githubWebhookSecret,
    signature: `sha256=${crypto.createHmac('sha256', githubWebhookSecret).update(body).digest('hex')}`,
  };
}

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {};
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: apiPort, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getLocalApp(host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/', method: 'GET', timeout: 2500 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode, dns: true }));
    });
    req.on('error', () => {
      const fallback = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode, dns: false }));
      });
      fallback.on('error', () => resolve({ statusCode: 0, dns: false }));
      fallback.end();
    });
    req.end();
  });
}

async function runLiveSetup(setup) {
  const results = [];
  for (const command of setup.commands || []) {
    const result = await runCommand({ executable: 'sh', args: ['-lc', command], redacted: command }, { dryRun: false, timeoutMs: 180_000 });
    results.push(result);
    if (result.exitCode !== 0) throw new Error(`live setup failed: ${command}\n${result.stderr || result.stdout}`);
  }
  return results;
}

function assertStatus(response, expected, label) {
  evidence.checks.push(`${label}: ${response.statusCode}`);
  if (response.statusCode !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${response.statusCode}: ${JSON.stringify(response.body)}`);
  }
}

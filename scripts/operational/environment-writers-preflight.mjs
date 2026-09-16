import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit invocation only; intentionally outside Node test autodiscovery.
// allow: SIZE_OK — the Task7 ownership contract permits exactly one new gate script.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = 'scripts/operational/environment-writers-preflight.mjs';
const require = createRequire(import.meta.url);
const sourcePaths = ['packages/core', 'packages/schemas', 'prisma', 'test-fixtures', 'tests/fixtures/resource-runtime.mjs',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', script, '.github/workflows/operational-environments.yml'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Also exercised by authoring checks: a failed cleanup must not suppress later actions.
export async function settleCleanup(actions, failures) {
  const outcomes = [];
  for (const [action, attempt] of actions) {
    try {
      await attempt();
      outcomes.push({ action, status: 'succeeded' });
    } catch (error) {
      failures.push(error);
      outcomes.push({ action, status: 'failed', error });
    }
  }
  return outcomes;
}

export function diagnostic(error, secrets) {
  let detail = error instanceof Error
    ? [error.stack || error.message, error.stdout, error.stderr].filter(value => typeof value === 'string').join('\n')
    : String(error);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) detail = detail.replaceAll(secret, '[redacted]');
  return detail.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gu, '[redacted-dsn]').slice(-8_000);
}

function sourceManifest(expectedSha) {
  assert.equal(git('rev-parse', 'HEAD'), expectedSha, 'checked-out source SHA differs from the reviewed invocation');
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths), '', 'gate requires committed, unchanged writer inputs');
  return Object.fromEntries(git('ls-files', '--', ...sourcePaths).split('\n').filter(Boolean)
    .map(path => [path, sha256(readFileSync(join(root, path)))]));
}

async function main() {
  const failures = [];
  const secrets = [process.env.RAIBITSERVER_TEST_DATABASE_URL];
  const report = { scope: 'Task7 actual Prisma writer admission; no provider, backup execution, restore execution, or Kubernetes proof',
    status: 'WORKING', phase: 'configuration', node: process.version, observations: [], cleanup: [] };
  const record = (name, rows) => report.observations.push({ name, rows });
  let admin, repo, evidenceDir, roleOwned = false, databaseOwned = false;
  const identity = `raibit_writers_${randomUUID().replaceAll('-', '')}`;
  const password = randomBytes(24).toString('base64url');
  secrets.push(password);
  let originalFailure;
  try {
    assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'RAIBITSERVER_TEST_DATABASE_URL is required; refusing to skip native gate');
    const adminUrl = new URL(process.env.RAIBITSERVER_TEST_DATABASE_URL);
    secrets.push(adminUrl.password, decodeURIComponent(adminUrl.password));
    assert.ok(['postgresql:', 'postgres:'].includes(adminUrl.protocol), 'PostgreSQL URL required');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname), 'use the isolated loopback PostgreSQL fixture');
    assert.match(process.env.RAIBITSERVER_EXPECTED_SOURCE_SHA || '', /^[a-f0-9]{40}$/u, 'reviewed source SHA required');
    assert.match(process.env.RAIBITSERVER_EXPECTED_WRITER_SHA256 || '', /^[a-f0-9]{64}$/u, 'reviewed writer SHA-256 required');
    assert.equal(sha256(readFileSync(join(root, script))), process.env.RAIBITSERVER_EXPECTED_WRITER_SHA256, 'writer hash differs from reviewed script');
    report.phase = 'source-freeze';
    report.sourceSha = process.env.RAIBITSERVER_EXPECTED_SOURCE_SHA;
    report.sourceFiles = sourceManifest(report.sourceSha);
    report.sourceManifestSha256 = sha256(JSON.stringify(report.sourceFiles));
    assert.ok(process.env.RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR, 'RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR required');
    evidenceDir = resolve(process.env.RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR);
    mkdirSync(evidenceDir, { recursive: true });
    // Discard caller connection options, including session protocol/search_path overrides.
    adminUrl.search = '?schema=public&connection_limit=1&connect_timeout=5&pool_timeout=5&socket_timeout=30';
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${identity}`;
    databaseUrl.username = identity;
    databaseUrl.password = password;
    secrets.push(adminUrl.href, databaseUrl.href);
    report.phase = 'database-provision';
    const { PrismaClient } = await import('@prisma/client');
    admin = new PrismaClient({ datasourceUrl: adminUrl.href, log: [] });
    const occupied = await admin.$queryRawUnsafe('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) OR EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS occupied', identity);
    assert.deepEqual(occupied, [{ occupied: false }], 'refuse cleanup ownership of an existing role/database');
    report.owned = { database: identity, role: identity };
    roleOwned = true;
    await admin.$executeRawUnsafe(`CREATE ROLE "${identity}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    databaseOwned = true;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${identity}" OWNER "${identity}"`);
    await admin.$executeRawUnsafe(`REVOKE ALL ON DATABASE "${identity}" FROM PUBLIC`);
    report.phase = 'migrations';
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
      cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl.href, PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
      encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.migration = 'succeeded';
    report.phase = 'writer-scenarios';
    // No new-schema query or product import occurs before migrate deploy succeeds.
    await import('../../tests/fixtures/resource-runtime.mjs');
    process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED = '1';
    const { PrismaControlPlaneRepository } = await import('../../packages/core/src/persistence.ts');
    const { parseDeploymentHistoryQuery } = await import('../../packages/core/src/deployment-history.ts');
    repo = await PrismaControlPlaneRepository.connect({ connect: false, env: { ...process.env, RAIBITSERVER_DB_POOL_SIZE: '1' }, prismaOptions: { datasourceUrl: databaseUrl.href, log: [] } });
    const db = repo.prisma;
    await db.$connect();
    const [session] = await db.$queryRawUnsafe(`SELECT current_database() AS database, current_user AS role,
      current_setting('server_version') AS version, current_setting('raibitserver.operational_protocol',true) AS protocol,
      rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
      (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner
      FROM pg_roles WHERE rolname=current_user`);
    assert.equal(session.database, identity);
    assert.equal(session.role, identity);
    assert.equal(session.owner, identity);
    assert.match(session.version, /^16\./u);
    assert.ok(session.protocol === null || session.protocol === '' || session.protocol === '1');
    for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) assert.equal(session[flag], false);
    record('native session ownership and privilege', session);
    const migrations = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, checksum: sha256(readFileSync(join(root, 'prisma/migrations', entry.name, 'migration.sql'))) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const applied = await db.$queryRawUnsafe('SELECT migration_name AS name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');
    assert.deepEqual(applied, migrations);
    record('current migrations applied', applied);

    // Given an ordinary prod project, retain its exact stored rows before dev admissions.
    const org = await repo.createOrganization({ name: 'Task7 writer fixture', slug: 'task7-writers' });
    const user = await repo.createUser({ name: 'Fixture owner', email: 'task7-writers@example.test', approvalStatus: 'APPROVED', accountType: 'NON_CLUB' });
    await repo.addMember({ organizationId: org.id, userId: user.id, role: 'OWNER' });
    const project = await repo.createProject({ organizationId: org.id, name: 'Writer project', slug: 'writer-project' });
    const prod = await repo.resolveEnvironment(project.id);
    assert.deepEqual((await repo.listEnvironments(project.id)).map(({ id, kind }) => ({ id, kind })), [{ id: `env_prod_${project.id}`, kind: 'prod' }]);
    const prodService = await repo.createService({ projectId: project.id, name: 'web', slug: 'web', sourceType: 'image', image: 'example/web:v1' });
    const resourceInput = { projectId: project.id, name: 'database', slug: 'database', engine: 'postgresql', provider: 'local', version: '16', storageMb: 1024 };
    const prodResource = await repo.createResource(resourceInput);
    const prodWork = await repo.createDeploymentWorkflow({ deployment: { projectId: project.id, serviceId: prodService.id, commitSha: '0'.repeat(40) }, workflow: { type: 'build-and-deploy', payload: {} } });
    assert.equal(prodWork.workflowJob.operationalProtocolVersion, 1);
    // Actual generated-client legacy prod mutation with no protocol setter remains admissible.
    await db.service.update({ where: { id: prodService.id }, data: { image: 'example/web:v1' } });
    const prodRows = () => Promise.all([
      db.project.findUniqueOrThrow({ where: { id: project.id } }), db.environment.findUniqueOrThrow({ where: { id: prod.id } }),
      db.service.findUniqueOrThrow({ where: { id: prodService.id } }), db.resource.findUniqueOrThrow({ where: { id: prodResource.id } }),
      db.deployment.findUniqueOrThrow({ where: { id: prodWork.deployment.id } }), db.workflowJob.findUniqueOrThrow({ where: { id: prodWork.workflowJob.id } }),
      db.environmentService.findUniqueOrThrow({ where: { serviceId: prodService.id } }), db.environmentResource.findUniqueOrThrow({ where: { resourceId: prodResource.id } }),
    ]);
    const baseline = await prodRows();
    assert.equal(baseline[2].slug, 'web');
    assert.equal(baseline[3].slug, 'database');
    assert.equal(baseline[3].name, 'database');
    record('prod baseline', baseline);

    // When actual dev create/update methods run, physical names and logical bindings stay separate.
    const dev = await repo.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
    const service = await repo.createService({ projectId: project.id, environmentId: dev.id, name: 'web', slug: 'web', sourceType: 'image', image: 'example/web:v1' });
    const resource = await repo.createResource({ ...resourceInput, environmentId: dev.id });
    const physicalService = `dev-${sha256(`${dev.id}:web`).slice(0, 10)}-web`;
    const physicalResource = `dev-${sha256(`${dev.id}:database`).slice(0, 10)}-database`;
    assert.notEqual(service.id, prodService.id);
    assert.notEqual(resource.id, prodResource.id);
    for (const [model, bindingModel, id, slug, physical] of [
      ['service', 'environmentService', service.id, 'web', physicalService], ['resource', 'environmentResource', resource.id, 'database', physicalResource],
    ]) {
      const row = await db[model].findUniqueOrThrow({ where: { id } });
      const binding = await db[bindingModel].findUniqueOrThrow({ where: { [`${model}Id`]: id } });
      assert.equal(row.projectId, project.id);
      assert.equal(row.slug, physical);
      if (model === 'resource') assert.equal(row.name, physical);
      assert.equal(binding.projectId, project.id);
      assert.equal(binding.environmentId, dev.id);
      assert.equal(binding.logicalSlug, slug);
      record(`dev ${model} create and binding`, { row, binding });
    }
    const updatedService = await repo.updateService(service.id, { name: 'Web renamed', port: 8081 });
    const updatedResource = await repo.updateResource(resource.id, { name: 'Database renamed', storageMb: 2048 });
    assert.equal(updatedService.name, 'Web renamed');
    assert.equal(updatedService.slug, 'web');
    assert.equal(updatedService.environmentId, dev.id);
    assert.equal(updatedResource.name, 'Database renamed');
    assert.equal(updatedResource.slug, 'database');
    assert.equal(updatedResource.environmentId, dev.id);
    const storedService = await db.service.findUniqueOrThrow({ where: { id: service.id } });
    const storedResource = await db.resource.findUniqueOrThrow({ where: { id: resource.id } });
    assert.equal(storedService.slug, physicalService);
    assert.equal(storedService.port, 8081);
    assert.equal(storedResource.slug, physicalResource);
    assert.equal(storedResource.name, physicalResource);
    assert.equal(storedResource.desiredSpec.storageMb, 2048);
    record('dev updates', { storedService, storedResource, updatedService, updatedResource });

    // Two distinct commits, no caller kind/protocol; second call actively forges workflow-only scope.
    const works = [];
    for (const commitSha of ['1'.repeat(40), '2'.repeat(40)]) {
      const forged = works.length ? { environmentId: prod.id, environmentKind: 'prod', operationalProtocolVersion: 1,
        payload: { environmentId: prod.id, environmentKind: 'prod', serviceId: prodService.id, desiredSpecSnapshot: { kind: 'prod' } } } : { payload: {} };
      const work = await repo.createDeploymentWorkflow({ deployment: { serviceId: service.id, projectId: project.id, environmentId: dev.id, commitSha }, workflow: { type: 'build-and-deploy', ...forged } });
      const deployment = await db.deployment.findUniqueOrThrow({ where: { id: work.deployment.id } });
      const job = await db.workflowJob.findUniqueOrThrow({ where: { id: work.workflowJob.id } });
      const snapshot = deployment.desiredSpecSnapshot;
      assert.equal(deployment.commitSha, commitSha);
      assert.equal(deployment.environmentId, dev.id);
      assert.equal(deployment.serviceId, service.id);
      assert.equal(deployment.snapshotVersion, 1);
      for (const [key, value] of Object.entries({ id: service.id, projectId: project.id, environmentId: dev.id, environmentKind: 'dev', kind: 'dev', slug: 'web', logicalSlug: 'web', physicalSlug: physicalService, port: 8081 })) assert.equal(snapshot[key], value, `snapshot ${key}`);
      assert.equal(job.environmentId, dev.id);
      assert.equal(job.operationalProtocolVersion, 2);
      assert.equal(job.targetType, 'deployment');
      assert.equal(job.targetId, deployment.id);
      assert.deepEqual(job.payload, { deploymentId: deployment.id, serviceId: service.id, projectId: project.id, environmentId: dev.id, environmentKind: 'dev', desiredSpecSnapshot: snapshot, snapshotVersion: 1 });
      works.push({ deployment, job });
    }
    assert.equal(new Set(works.map(work => work.deployment.id)).size, 2);
    assert.equal(new Set(works.map(work => work.job.id)).size, 2);
    record('two binding-derived deployments and jobs', works);
    const direct = await repo.createDeployment({ serviceId: service.id, environmentId: dev.id, commitSha: '3'.repeat(40), deploymentType: 'preview' });
    const directRow = await db.deployment.findUniqueOrThrow({ where: { id: direct.id } });
    assert.equal(directRow.environmentId, dev.id);
    assert.equal(directRow.desiredSpecSnapshot.kind, 'dev');
    assert.equal(directRow.desiredSpecSnapshot.physicalSlug, physicalService);
    record('direct dev deployment', directRow);
    assert.equal(directRow.status, 'queued');
    const transitioned = await repo.transitionDeployment(direct.id, 'BUILDING');
    const transitionedRow = await db.deployment.findUniqueOrThrow({ where: { id: direct.id } });
    for (const row of [transitioned, transitionedRow]) {
      assert.equal(row.status, 'BUILDING');
      for (const key of ['id', 'serviceId', 'projectId', 'environmentId', 'commitSha', 'deploymentType', 'snapshotVersion']) assert.equal(row[key], directRow[key], `transition ${key}`);
      assert.deepEqual(row.desiredSpecSnapshot, directRow.desiredSpecSnapshot);
    }
    record('public dev deployment status transition preserves identity and snapshot', { before: directRow, after: transitionedRow });
    const beforeRejection = await db.deployment.count();
    const jobsBeforeRejection = await db.workflowJob.count();
    for (const create of [input => repo.createDeployment(input), input => repo.createDeploymentWorkflow({ deployment: input, workflow: { payload: {} } })]) {
      await assert.rejects(create({ serviceId: service.id, projectId: project.id, environmentId: prod.id, commitSha: '4'.repeat(40) }), { code: 'ENVIRONMENT_NOT_FOUND', statusCode: 404 });
    }
    assert.equal(await db.deployment.count(), beforeRejection);
    assert.equal(await db.workflowJob.count(), jobsBeforeRejection);
    record('forged deployment environment rejected atomically', { deployments: beforeRejection, jobs: jobsBeforeRejection });
    await repo.updateService(service.id, { port: 8082 });
    for (const work of works) assert.deepEqual(await db.deployment.findUniqueOrThrow({ where: { id: work.deployment.id } }), work.deployment);
    record('stored deployment snapshots survive later service update', { snapshotPort: 8081, currentPort: (await repo.getService(service.id)).port });

    // Then repository project lists/history keep default prod separate from dev and legacy preview.
    const defaultList = await repo.listDeploymentsForProject(project.id, { limit: 20 });
    assert.deepEqual(defaultList.map(row => row.id), [prodWork.deployment.id]);
    const devList = await repo.listDeploymentsForProject(project.id, { environmentId: dev.id, limit: 20 });
    assert.deepEqual(devList.map(row => row.id).sort(), [...works.map(work => work.deployment.id), direct.id].sort());
    const scope = { organizationId: org.id, projectId: project.id, cursorSecret: 'task7-local-cursor-fixture', execute: false };
    const history = await repo.listDeploymentHistory({ ...scope, query: parseDeploymentHistoryQuery({ environment: 'production' }) });
    assert.deepEqual(history.deployments.map(row => row.id), [prodWork.deployment.id]);
    const query = parseDeploymentHistoryQuery({ environment: 'production', limit: 1 });
    const first = await repo.listDeploymentHistory({ ...scope, environmentId: dev.id, query });
    assert.equal(first.deployments.length, 1);
    assert.ok(first.page.nextCursor);
    const second = await repo.listDeploymentHistory({ ...scope, environmentId: dev.id, query: { ...query, cursor: first.page.nextCursor } });
    assert.deepEqual([...first.deployments, ...second.deployments].map(row => row.id).sort(), works.map(work => work.deployment.id).sort());
    assert.equal(second.page.nextCursor, null);
    await assert.rejects(repo.listDeploymentHistory({ ...scope, query: { ...query, cursor: first.page.nextCursor } }), { code: 'INVALID_DEPLOYMENT_HISTORY_QUERY' });
    const preview = await repo.listDeploymentHistory({ ...scope, environmentId: dev.id, query: parseDeploymentHistoryQuery({ environment: 'preview' }) });
    assert.deepEqual(preview.deployments.map(row => row.id), [direct.id]);
    record('scoped project list and history', { defaultList, devList, history, first, second, preview });

    // Provider-observation setup only: local approved synthetic provenance, no provider call.
    const now = '2026-09-13T00:00:00.000Z';
    const provenance = { providerIdentity: { namespace: `rb-dev-${sha256(dev.id).slice(0, 20)}`, name: physicalResource },
      credentialSecretUID: 'task7-fixture-secret-uid', credentialSecretGeneration: 'a'.repeat(43),
      providerImageProvenance: { schema: 'raibitserver.provider-image/v1', image: `registry.example.test/postgresql@sha256:${'a'.repeat(64)}`, workloadUid: 'task7-fixture-workload', workloadGeneration: 1, observedAt: now } };
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
      await tx.resource.update({ where: { id: resource.id }, data: { status: 'READY', connectionSecretName: `${physicalResource}-connection`, desiredState: { ...storedResource.desiredState, ...provenance } } });
    });
    let quotaCalls = 0;
    const recovery = repo.resourceRecovery((state, request, kind) => {
      assert.equal(kind, 'backup');
      assert.equal(request.actorUserId, user.id);
      assert.equal(request.sourceId, resource.id);
      assert.equal(state.backups.length, 0, 'fixture permits one new manual backup');
      quotaCalls += 1;
    });
    const request = { organizationId: org.id, actorUserId: user.id, sourceId: resource.id, body: { requestIdempotencyKey: 'task7-manual', formatVersion: 1 }, now };
    const backup = await recovery.createBackup(request);
    const replay = await recovery.createBackup(request);
    assert.equal(quotaCalls, 1);
    assert.equal(backup.replay, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.operation.id, backup.operation.id);
    assert.equal(replay.operation.environmentId, dev.id, 'manual NULL storage must rehydrate from resource binding');
    const backupRow = await db.resourceBackup.findUniqueOrThrow({ where: { id: backup.operation.id } });
    const backupJob = await db.workflowJob.findUniqueOrThrow({ where: { id: backup.job.id } });
    assert.equal(backupRow.origin, 'manual');
    assert.equal(backupRow.environmentId, null);
    assert.equal(backupRow.resourceId, resource.id);
    assert.equal(backupRow.projectId, project.id);
    assert.equal(backupRow.status, 'QUEUED');
    assert.deepEqual(backupRow.sourceProvenance, provenance);
    assert.equal(backupJob.environmentId, dev.id);
    assert.equal(backupJob.operationalProtocolVersion, 2);
    assert.equal(backupJob.type, 'resource.backup');
    assert.equal(backupJob.targetId, backupRow.id);
    assert.deepEqual(backupJob.payload, { version: 1, operationId: backupRow.id });
    assert.equal(await db.resourceBackup.count(), 1);
    assert.equal(await db.resourceRestore.count(), 0);
    record('manual dev backup admission and replay', { backupRow, backupJob, hydratedEnvironmentId: replay.operation.environmentId, quotaCalls, fixtureProvenance: provenance });

    // Same single-connection session must remain protocol1 after real writer transactions.
    const [afterSession] = await db.$queryRawUnsafe("SELECT current_setting('raibitserver.operational_protocol',true) AS protocol");
    assert.ok(afterSession.protocol === null || afterSession.protocol === '' || afterSession.protocol === '1');
    await assert.rejects(db.$executeRawUnsafe('UPDATE "Deployment" SET "commitSha"=$1 WHERE id=$2', '9'.repeat(40), works[0].deployment.id), /protocol 2 is required for dev deployment mutation/u);
    await assert.rejects(db.$executeRawUnsafe('UPDATE "WorkflowJob" SET attempts=attempts+1 WHERE id=$1', works[0].job.id), /OPERATIONAL_PROTOCOL_2_REQUIRED/u);
    assert.deepEqual(await db.deployment.findUniqueOrThrow({ where: { id: works[0].deployment.id } }), works[0].deployment);
    assert.deepEqual(await db.workflowJob.findUniqueOrThrow({ where: { id: works[0].job.id } }), works[0].job);
    record('transaction-local protocol guard', { afterSession, rejected: ['dev deployment UPDATE', 'dev workflow UPDATE'] });
    const afterProd = await prodRows();
    assert.deepEqual(afterProd, baseline);
    record('prod unchanged after dev writes', afterProd);
  } catch (error) {
    originalFailure = error;
    failures.push(error);
  } finally {
    report.cleanup = await settleCleanup([
      ...(repo ? [['repository-disconnect', () => repo.disconnect()]] : []),
      ...(databaseOwned ? [['owned-database-drop', () => admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${identity}" WITH (FORCE)`)]] : []),
      ...(roleOwned ? [['owned-role-drop', () => admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${identity}"`)]] : []),
      ...(admin ? [['admin-disconnect', () => admin.$disconnect()]] : []),
      ...(report.sourceFiles ? [['source-freeze-recheck', () => assert.deepEqual(sourceManifest(report.sourceSha), report.sourceFiles)]] : []),
    ], failures);
  }
  report.status = failures.length ? 'FAIL' : 'PASS';
  report.originalFailure = originalFailure === undefined ? null : diagnostic(originalFailure, secrets);
  report.failures = failures.map(error => diagnostic(error, secrets));
  report.cleanup = report.cleanup.map(({ error, ...outcome }) => error === undefined ? outcome : { ...outcome, error: diagnostic(error, secrets) });
  // Evidence I/O failure still reports all cleanup outcomes and fails the invocation.
  try {
    if (evidenceDir) writeFileSync(join(evidenceDir, 'environment-writers.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    failures.push(error);
    report.status = 'FAIL';
    report.failures.push(diagnostic(error, secrets));
  }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, sourceSha: report.sourceSha, sourceManifestSha256: report.sourceManifestSha256, observations: report.observations.length, cleanup: report.cleanup }));
  if (failures.length) {
    console.error(JSON.stringify({ originalFailure: report.originalFailure, failures: report.failures, owned: report.owned, cleanup: report.cleanup }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();

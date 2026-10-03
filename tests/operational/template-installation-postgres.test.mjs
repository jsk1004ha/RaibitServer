import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PrismaControlPlaneRepository } from '../../packages/core/src/persistence.ts';
import { preflightTemplateInstallation } from '../../packages/core/src/template-installations.ts';
import { openSecret } from '../../packages/core/src/secret-vault.ts';
import { setOperationalProtocolVersion } from '../../packages/core/src/operational-persistence.ts';

const require = createRequire(import.meta.url);
const databaseUrl = process.env.RAIBITSERVER_TEST_DATABASE_URL;
const catalog = JSON.parse(await readFile(new URL('../../test-fixtures/contracts/starter-catalog-v1.json', import.meta.url), 'utf8'));
const rawToken = 'postgres-discord-secret-never-persist-plaintext-1234567890';
const postgresOptions = { skip: !databaseUrl && process.env.RAIBITSERVER_REQUIRE_POSTGRES_TESTS !== '1' ? 'NOT_RUN: disposable PostgreSQL URL not configured' : false };
Object.assign(process.env, {
  RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1', RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1',
  RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2', RAIBITSERVER_RELEASE_SOURCE_CLEAN: '1',
  RAIBITSERVER_RELEASE_REVISION: 'a'.repeat(40), RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: 'b'.repeat(64),
});

function request(id, key, inputs = {}) {
  const starter = catalog.starters.find(row => row.id === id);
  return { requiredProtocolVersion: 2, catalogId: id, catalogVersion: starter.version,
    catalogDigest: catalog.catalogDigest, sourceDigest: starter.source.digest, requestIdempotencyKey: key, inputs };
}

async function fixture(repository, suffix) {
  const organization = await repository.createOrganization({ name: suffix, slug: `template-${suffix}` });
  const user = await repository.createUser({ name: 'Owner', email: `template-${suffix}@example.test`, approvalStatus: 'APPROVED' });
  await repository.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  await repository.setQuota({ userId: user.id, maxProjects: 20, maxServices: 20, maxDeploymentsPerDay: 20, maxDbStorageMb: 32768, maxCpuMillicores: 16000, maxMemoryMb: 32768 });
  const project = await repository.createProject({ organizationId: organization.id, name: 'Application', slug: 'application', status: 'ACTIVE' });
  const prod = await repository.resolveEnvironment(project.id);
  const dev = await repository.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  return { repository, organization, user, project, prod, dev };
}

async function intentFor(context, body, environment = context.prod) {
  const preflight = await context.repository.templatePreflightContext(context.project.id, { environmentId: environment.id }, body.requestIdempotencyKey, context.user.id);
  return preflightTemplateInstallation(catalog, body, preflight);
}

async function durableState(db) {
  const names = ['templateInstallation', 'templateInstallationVersion', 'service', 'resource', 'deployment', 'environmentService', 'environmentResource', 'secretValue', 'environmentVariable', 'workflowJob', 'auditLog', 'deploymentEvent', 'resourceAttachment'];
  const rows = await Promise.all(names.map(async name => [name, await db[name].findMany()]));
  return Object.fromEntries(rows.map(([name, values]) => [name, values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}

async function protocolWrite(repository, work) {
  return repository.prisma.$transaction(async tx => { await setOperationalProtocolVersion(tx); return work(tx); });
}

const retry = key => ({ requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: key });

test('native PostgreSQL template persistence: atomic graphs, encrypted input, scoped retry and admission', postgresOptions, async t => {
  assert.ok(databaseUrl, 'RAIBITSERVER_TEST_DATABASE_URL must identify a disposable PostgreSQL database');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: databaseUrl });
  const schema = `template_install_${randomUUID().replaceAll('-', '')}`;
  const repositories = [];
  t.after(async () => {
    await Promise.all(repositories.map(repository => repository.disconnect()));
    try { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
    t.diagnostic(JSON.stringify({ cleanup: 'PASS', schema }));
  });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  const migrate = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: new URL('../..', import.meta.url), env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
  for (let index = 0; index < 4; index++) repositories.push(await PrismaControlPlaneRepository.connect({
    env: { ...process.env, RAIBITSERVER_DB_POOL_SIZE: '1' },
    prismaOptions: { datasourceUrl: url.href, transactionOptions: { maxWait: 30000, timeout: 30000 } },
  }));
  const repository = repositories[0];
  const db = repository.prisma;
  const [migrationCount] = await db.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL');
  assert.equal(migrationCount.count, 27);

  await t.test('concurrent identical requests commit one graph and one sealed secret with a resolvable reference', async () => {
    const context = await fixture(repository, 'secret');
    const body = request('discord-bot', 'postgres-secret-install', { DISCORD_TOKEN: rawToken });
    const intent = await intentFor(context, body, context.dev);
    assert.equal(JSON.stringify(intent).includes(rawToken), false);
    const results = await Promise.all(repositories.map(candidate => candidate.installTemplateGraph(intent, body.inputs)));
    assert.equal(new Set(results.map(row => row.installationId)).size, 1);
    assert.equal(await db.templateInstallation.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.templateInstallationVersion.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.service.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.deployment.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.workflowJob.count({ where: { environmentId: context.dev.id } }), 1);
    const variable = await db.environmentVariable.findUnique({ where: { serviceId_key: { serviceId: intent.services[0].id, key: 'DISCORD_TOKEN' } } });
    assert.ok(variable.secretRef);
    assert.equal(variable.value, null);
    assert.equal(variable.isSecret, true);
    const secret = await db.secretValue.findUnique({ where: { id: variable.secretRef } });
    assert.ok(secret, 'stored environment reference resolves to an actual SecretValue row');
    assert.equal(openSecret(secret.sealedValue), rawToken);
    assert.equal(secret.metadata.environmentId, context.dev.id);
    const deployment = await db.deployment.findUnique({ where: { id: intent.services[0].deploymentId } });
    const job = await db.workflowJob.findUnique({ where: { id: intent.services[0].workflowJobId } });
    assert.equal(deployment.environmentId, context.dev.id);
    assert.equal(deployment.desiredSpecSnapshot.sourceType, 'template');
    assert.equal(deployment.desiredSpecSnapshot.source.sourceDigest, intent.sourceDigest);
    assert.equal(deployment.desiredSpecSnapshot.secretRefs[0].secretRef, intent.services[0].secretRefs[0].secretRef);
    assert.equal(job.operationalProtocolVersion, 2);
    assert.equal(job.payload.installationId, intent.installationId);
    const before = await durableState(db);
    const replay = await intentFor(context, body, context.dev);
    await repository.installTemplateGraph(replay, body.inputs);
    assert.deepEqual(await durableState(db), before, 'replay does not rotate ciphertext or enqueue work');
    const changed = { ...body, inputs: { DISCORD_TOKEN: `${rawToken}-changed` } };
    const conflicting = await intentFor(context, changed, context.dev);
    assert.notEqual(conflicting.requestFingerprint, intent.requestFingerprint);
    await assert.rejects(repository.installTemplateGraph(conflicting, changed.inputs), error => error.statusCode === 409);
    assert.deepEqual(await durableState(db), before);
    const detail = await repository.getTemplateInstallation(intent.installationId, context.user.id);
    assert.equal(detail.environmentId, context.dev.id);
    assert.equal((await repository.listTemplateInstallations(context.project.id, {}, context.user.id)).length, 0);
    assert.equal((await repository.listTemplateInstallations(context.project.id, { environmentId: context.dev.id }, context.user.id)).length, 1);
    for (const output of [intent, results, detail, before]) assert.equal(JSON.stringify(output).includes(rawToken), false);
  });

  await t.test('late native CHECK failures roll back installation, resources, services, secrets, jobs and audit together', async () => {
    for (const [id, inputs] of [['next-postgres', {}], ['discord-bot', { DISCORD_TOKEN: rawToken }]]) {
      const context = await fixture(repository, `rollback-${id}`);
      const body = request(id, `postgres-rollback-${id}`, inputs);
      const intent = await intentFor(context, body, context.dev);
      const before = await durableState(db);
      await db.$executeRawUnsafe('ALTER TABLE "WorkflowJob" ADD CONSTRAINT "template_insert_fault" CHECK ("type" <> \'build-and-deploy\') NOT VALID');
      try { await assert.rejects(repository.installTemplateGraph(intent, inputs)); }
      finally { await db.$executeRawUnsafe('ALTER TABLE "WorkflowJob" DROP CONSTRAINT "template_insert_fault"'); }
      assert.deepEqual(await durableState(db), before, `${id}: no partial graph or secret survives the SQL failure`);
      await repository.installTemplateGraph(intent, inputs);
      assert.equal(await db.templateInstallation.count({ where: { projectId: context.project.id } }), 1);
    }
  });

  await t.test('progress requires runtime READY and retries retain identity without resetting active or successful work', async () => {
    const context = await fixture(repository, 'retry');
    const body = request('next-postgres', 'postgres-retry-install');
    const intent = await intentFor(context, body, context.dev);
    await repository.installTemplateGraph(intent, body.inputs);
    const service = intent.services[0];
    const resourceId = intent.resources[0].id;
    const state = async () => ({ resource: await db.resource.findUnique({ where: { id: resourceId } }),
      deployment: await db.deployment.findUnique({ where: { id: service.deploymentId } }),
      job: await db.workflowJob.findUnique({ where: { id: service.workflowJobId } }) });
    assert.equal((await repository.getTemplateInstallation(intent.installationId)).progress.status, 'provisioning');
    assert.equal((await state()).deployment.desiredSpecSnapshot.resourceDependencies[0].secretKey, 'DATABASE_URL');
    await protocolWrite(repository, async tx => {
      await tx.resource.update({ where: { id: resourceId }, data: { status: 'READY' } });
      await tx.deployment.update({ where: { id: service.deploymentId }, data: { status: 'IMAGE_READY' } });
      await tx.workflowJob.update({ where: { id: service.workflowJobId }, data: { status: 'succeeded' } });
    });
    assert.equal((await repository.getTemplateInstallation(intent.installationId)).progress.status, 'building');
    await protocolWrite(repository, tx => tx.deployment.update({ where: { id: service.deploymentId }, data: { status: 'READY' } }));
    assert.deepEqual((await repository.getTemplateInstallation(intent.installationId)).progress, { status: 'ready', completed: 2, total: 2 });
    const succeeded = await state();
    await repository.retryTemplateInstallation(intent.installationId, retry('postgres-successful-retry'), context.user.id);
    assert.deepEqual(await state(), succeeded);
    await protocolWrite(repository, tx => tx.deployment.update({ where: { id: service.deploymentId }, data: {
      status: 'FAILED', imageUrl: `registry.example.test/web@sha256:${'c'.repeat(64)}`, reconcileAttempts: 7,
      publicHealthStatus: 'unhealthy', healthFailureCode: 'CrashLoopBackOff', healthCheckedAt: new Date(), observedGeneration: 5,
      errorCode: 'RUNTIME_FAILED', reconcileLockedBy: 'active-orchestrator', reconcileLockedAt: new Date(),
    } }));
    const leasedRuntime = await state();
    await repository.retryTemplateInstallation(intent.installationId, retry('postgres-leased-runtime'), context.user.id);
    assert.deepEqual(await state(), leasedRuntime);
    await protocolWrite(repository, tx => tx.deployment.update({ where: { id: service.deploymentId }, data: { reconcileLockedBy: null, reconcileLockedAt: null } }));
    await repository.retryTemplateInstallation(intent.installationId, retry('postgres-runtime-retry'), context.user.id);
    const runtimeRetried = await state();
    assert.equal(runtimeRetried.deployment.status, 'IMAGE_READY');
    assert.equal(runtimeRetried.deployment.reconcileAttempts, 7);
    assert.equal(runtimeRetried.deployment.errorCode, null);
    assert.equal(runtimeRetried.deployment.healthFailureCode, null);
    assert.equal(runtimeRetried.deployment.healthCheckedAt, null);
    assert.equal(runtimeRetried.deployment.observedGeneration, null);
    assert.deepEqual(runtimeRetried.job, succeeded.job);
    await protocolWrite(repository, async tx => {
      await tx.deployment.update({ where: { id: service.deploymentId }, data: { status: 'BUILD_FAILED' } });
      await tx.workflowJob.update({ where: { id: service.workflowJobId }, data: { status: 'running', attempts: 1, lockedBy: 'active-builder', lockedAt: new Date() } });
    });
    const running = await state();
    try { await repository.retryTemplateInstallation(intent.installationId, retry('postgres-running-retry'), context.user.id); }
    catch (error) { assert.equal(error.statusCode, 409); }
    assert.deepEqual(await state(), running);
    await protocolWrite(repository, async tx => {
      await tx.resource.update({ where: { id: resourceId }, data: { status: 'FAILED' } });
      await tx.workflowJob.update({ where: { id: service.workflowJobId }, data: { status: 'failed', attempts: 3, lockedBy: null, lockedAt: null } });
    });
    const laterFailure = await durableState(db);
    await repository.retryTemplateInstallation(intent.installationId, retry('postgres-running-retry'), context.user.id);
    assert.deepEqual(await durableState(db), laterFailure, 'an accepted no-op retry cannot later reset newly failed work');
    const failed = await durableState(db);
    await db.$executeRawUnsafe('ALTER TABLE "WorkflowJob" ADD CONSTRAINT "template_retry_fault" CHECK ("status" <> \'queued\') NOT VALID');
    try { await assert.rejects(repository.retryTemplateInstallation(intent.installationId, retry('postgres-failed-retry'), context.user.id)); }
    finally { await db.$executeRawUnsafe('ALTER TABLE "WorkflowJob" DROP CONSTRAINT "template_retry_fault"'); }
    assert.deepEqual(await durableState(db), failed, 'failed job reset rolls back prior resource and deployment updates');
    await repository.retryTemplateInstallation(intent.installationId, retry('postgres-failed-retry'), context.user.id);
    const queued = await state();
    assert.equal(queued.resource.status, 'PROVISIONING');
    assert.equal(queued.deployment.status, 'queued');
    assert.equal(queued.job.status, 'queued');
    assert.equal(queued.job.attempts, 3, 'worker lease generations must never rewind on retry');
    assert.ok(queued.job.maxAttempts >= 6);
    assert.equal(queued.job.id, service.workflowJobId);
    assert.equal(queued.deployment.id, service.deploymentId);
    assert.equal(await db.service.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.resource.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.deployment.count({ where: { projectId: context.project.id } }), 1);
    assert.equal(await db.workflowJob.count({ where: { environmentId: context.dev.id } }), 1);
    const after = await durableState(db);
    await repository.retryTemplateInstallation(intent.installationId, retry('postgres-failed-retry'), context.user.id);
    await assert.rejects(repository.retryTemplateInstallation(intent.installationId, { ...retry('postgres-stale-retry'), expectedVersion: 2 }, context.user.id), error => error.statusCode === 409);
    assert.deepEqual(await durableState(db), after);
    await protocolWrite(repository, tx => tx.workflowJob.update({ where: { id: service.workflowJobId }, data: {
      status: 'running', attempts: { increment: 1 }, lockedBy: 'active-builder', lockedAt: new Date(),
    } }));
    const reclaimed = await state();
    assert.equal(reclaimed.job.attempts, 4);
    const staleWrite = await protocolWrite(repository, tx => tx.workflowJob.updateMany({
      where: { id: service.workflowJobId, status: 'running', lockedBy: 'active-builder', attempts: 3 }, data: { status: 'failed' },
    }));
    assert.equal(staleWrite.count, 0, 'the old JobID/WorkerID/Attempt lease cannot update the new claim');
    assert.deepEqual(await state(), reclaimed);
  });

  await t.test('latest quota and current membership are checked inside admission after preflight', async () => {
    const context = await fixture(repository, 'admission');
    const body = request('fastapi', 'postgres-admission-install');
    const intent = await intentFor(context, body);
    await db.membership.updateMany({ where: { organizationId: context.organization.id, userId: context.user.id }, data: { role: 'VIEWER' } });
    await assert.rejects(repository.installTemplateGraph(intent, body.inputs), error => error.statusCode === 403);
    await db.membership.updateMany({ where: { organizationId: context.organization.id, userId: context.user.id }, data: { role: 'OWNER' } });
    await db.user.update({ where: { id: context.user.id }, data: { bannedAt: new Date() } });
    await assert.rejects(repository.installTemplateGraph(intent, body.inputs), error => error.statusCode === 403);
    await db.user.update({ where: { id: context.user.id }, data: { bannedAt: null } });
    await db.quota.create({ data: { id: 'template-newest-restrictive', userId: context.user.id, accountType: 'NON_CLUB', maxServices: 0, updatedAt: new Date('2030-01-01T00:00:00.000Z') } });
    await db.quota.create({ data: { id: 'template-other-account', userId: context.user.id, accountType: 'CLUB_MEMBER', maxServices: 100, updatedAt: new Date('2040-01-01T00:00:00.000Z') } });
    await assert.rejects(repository.installTemplateGraph(intent, body.inputs), error => [403, 409].includes(error.statusCode));
    assert.equal(await db.templateInstallation.count({ where: { projectId: context.project.id } }), 0);
    assert.equal(await db.service.count({ where: { projectId: context.project.id } }), 0);
    assert.equal(await db.workflowJob.count({ where: { environmentId: context.prod.id } }), 0);
  });

  await t.test('foreign organization/environment selectors and cross-environment key reuse fail closed', async () => {
    const context = await fixture(repository, 'scope');
    const foreign = await fixture(repository, 'foreign');
    const body = request('fastapi', 'postgres-scope-install');
    await assert.rejects(repository.templatePreflightContext(context.project.id, { environmentId: foreign.prod.id }, body.requestIdempotencyKey, context.user.id), error => error.statusCode === 404);
    await assert.rejects(repository.templatePreflightContext(foreign.project.id, {}, body.requestIdempotencyKey, context.user.id), error => error.statusCode === 404);
    const prodIntent = await intentFor(context, body);
    await repository.installTemplateGraph(prodIntent, body.inputs);
    const before = await durableState(db);
    await assert.rejects(async () => repository.installTemplateGraph(await intentFor(context, body, context.dev), body.inputs), error => error.statusCode === 409);
    await assert.rejects(repository.retryTemplateInstallation(prodIntent.installationId, retry('postgres-foreign-retry'), foreign.user.id), error => error.statusCode === 404);
    assert.deepEqual(await durableState(db), before);
    assert.equal((await repository.listTemplateInstallations(context.project.id, { environmentId: context.dev.id }, context.user.id)).length, 0);
  });
  t.diagnostic(JSON.stringify({ migrations: 27, independentConnections: 4 }));
});

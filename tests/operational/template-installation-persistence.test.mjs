import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { InMemoryControlPlaneRepository } from '../../packages/core/src/persistence.ts';
import { preflightTemplateInstallation } from '../../packages/core/src/template-installations.ts';
import { openSecret } from '../../packages/core/src/secret-vault.ts';

const catalog = JSON.parse(await readFile(new URL('../../test-fixtures/contracts/starter-catalog-v1.json', import.meta.url), 'utf8'));
const rawToken = 'discord-test-token-never-in-durable-intent-7890123456789';
Object.assign(process.env, {
  RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1', RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1',
  RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2', RAIBITSERVER_RELEASE_SOURCE_CLEAN: '1',
  RAIBITSERVER_RELEASE_REVISION: 'a'.repeat(40), RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: 'b'.repeat(64),
});

async function fixture() {
  const repository = new InMemoryControlPlaneRepository();
  const organization = await repository.createOrganization({ name: 'Template persistence', slug: 'template-persistence' });
  const user = await repository.createUser({ name: 'Owner', email: 'template-owner@example.test', approvalStatus: 'APPROVED' });
  await repository.addMember({ organizationId: organization.id, userId: user.id, role: 'OWNER' });
  await repository.setQuota({ userId: user.id, maxProjects: 20, maxServices: 20, maxDeploymentsPerDay: 20, maxDbStorageMb: 32768, maxCpuMillicores: 16000, maxMemoryMb: 32768 });
  const project = await repository.createProject({ organizationId: organization.id, name: 'Application', slug: 'application', status: 'ACTIVE' });
  const prod = await repository.resolveEnvironment(project.id);
  const dev = await repository.createEnvironment({ projectId: project.id, kind: 'dev', expectedVersion: 0 });
  return { repository, store: repository.store, organization, user, project, prod, dev };
}

function request(id, key, inputs = {}) {
  const starter = catalog.starters.find(row => row.id === id);
  return { requiredProtocolVersion: 2, catalogId: id, catalogVersion: starter.version,
    catalogDigest: catalog.catalogDigest, sourceDigest: starter.source.digest, requestIdempotencyKey: key, inputs };
}

async function intentFor(context, body, environment = context.prod) {
  const preflight = await context.repository.templatePreflightContext(context.project.id, { environmentId: environment.id }, body.requestIdempotencyKey, context.user.id);
  return preflightTemplateInstallation(catalog, body, preflight);
}

function durableState(store) {
  const maps = ['templateInstallations', 'templateInstallationVersions', 'services', 'resources', 'deployments', 'environmentServices', 'environmentResources', 'secrets', 'environmentVariables'];
  return structuredClone(Object.fromEntries([
    ...maps.map(key => [key, [...store[key]]]),
    ...['workflowJobs', 'auditLogs', 'deploymentEvents', 'resourceAttachments'].map(key => [key, store[key]]),
  ]));
}

function withoutAudit({ auditLogs: _auditLogs, ...state }) { return state; }

const retry = key => ({ requiredProtocolVersion: 2, expectedVersion: 1, requestIdempotencyKey: key });

test('memory template install seals raw input once, exposes references, and rejects a changed replay', async () => {
  const context = await fixture();
  const { repository, store, project, user, dev } = context;
  const body = request('discord-bot', 'memory-secret-install', { DISCORD_TOKEN: rawToken });
  const intent = await intentFor(context, body, dev);
  assert.deepEqual(await intentFor(context, body, dev), intent, 'preflight identities and secret references are deterministic');
  assert.equal(JSON.stringify(intent).includes(rawToken), false);
  assert.match(intent.inputs.DISCORD_TOKEN, /^secret:/);
  const installed = await repository.installTemplateGraph(intent, body.inputs);
  const beforeReplay = durableState(store);
  const replayIntent = await intentFor(context, body, dev);
  const replayed = await repository.installTemplateGraph(replayIntent, body.inputs);
  assert.equal(replayed.installationId, installed.installationId);
  assert.deepEqual(durableState(store), beforeReplay, 'replay does not reseal a secret or enqueue another build');
  assert.equal(store.secrets.size, 1);
  const [secret] = store.secrets.values();
  const [variable] = store.environmentVariables.values();
  assert.equal(openSecret(secret.sealedValue), rawToken);
  assert.equal(secret.metadata.environmentId, dev.id);
  assert.equal(variable.secretRef, secret.id);
  assert.equal(variable.value, null);
  assert.equal(variable.isSecret, true);
  assert.equal(variable.serviceId, intent.services[0].id);
  assert.equal(store.services.size, 1);
  assert.equal(store.deployments.size, 1);
  assert.equal(store.workflowJobs.length, 1);
  assert.equal(store.workflowJobs[0].operationalProtocolVersion, 2);
  assert.equal(store.workflowJobs[0].environmentId, dev.id);
  const snapshot = store.deployments.get(intent.services[0].deploymentId).desiredSpecSnapshot;
  assert.equal(snapshot.sourceType, 'template');
  assert.equal(snapshot.secretRefs[0].secretRef, intent.services[0].secretRefs[0].secretRef);
  const detail = await repository.getTemplateInstallation(intent.installationId, user.id);
  assert.equal(detail.environmentId, dev.id);
  assert.equal(detail.progress.status, 'building');
  assert.equal((await repository.listTemplateInstallations(project.id, {}, user.id)).length, 0);
  assert.equal((await repository.listTemplateInstallations(project.id, { environmentId: dev.id }, user.id)).length, 1);
  for (const output of [intent, installed, detail, store.snapshot(), durableState(store)]) {
    assert.equal(JSON.stringify(output).includes(rawToken), false, 'raw input cannot escape the sealed vault');
  }
  const changed = { ...body, inputs: { DISCORD_TOKEN: `${rawToken}-changed` } };
  const changedIntent = await intentFor(context, changed, dev);
  assert.notEqual(changedIntent.requestFingerprint, intent.requestFingerprint);
  await assert.rejects(repository.installTemplateGraph(changedIntent, changed.inputs), error => error.statusCode === 409);
  assert.deepEqual(durableState(store), beforeReplay);
});

test('memory progress waits for runtime READY and retry keeps resource, service, deployment and job identities', async () => {
  const context = await fixture();
  const { repository, store, user } = context;
  const body = request('next-postgres', 'memory-resource-install');
  const intent = await intentFor(context, body);
  await repository.installTemplateGraph(intent, body.inputs);
  const resource = store.resources.get(intent.resources[0].id);
  const deployment = store.deployments.get(intent.services[0].deploymentId);
  const job = store.workflowJobs.find(row => row.id === intent.services[0].workflowJobId);
  assert.equal(deployment.desiredSpecSnapshot.resourceDependencies[0].secretKey, 'DATABASE_URL');
  assert.equal((await repository.getTemplateInstallation(intent.installationId)).progress.status, 'provisioning');
  resource.status = 'READY';
  deployment.status = 'IMAGE_READY';
  job.status = 'succeeded';
  assert.equal((await repository.getTemplateInstallation(intent.installationId)).progress.status, 'building');
  deployment.status = 'READY';
  assert.deepEqual((await repository.getTemplateInstallation(intent.installationId)).progress, { status: 'ready', completed: 2, total: 2 });
  const completed = durableState(store);
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-completed-retry'), user.id);
  assert.deepEqual(withoutAudit(durableState(store)), withoutAudit(completed), 'completed runtime and successful job remain untouched');
  assert.equal(store.auditLogs.length, completed.auditLogs.length + 1, 'accepted no-op retry records its request key');
  const succeededJob = structuredClone(job);
  Object.assign(deployment, { status: 'FAILED', imageUrl: `registry.example.test/web@sha256:${'c'.repeat(64)}`, reconcileAttempts: 7,
    publicHealthStatus: 'unhealthy', healthFailureCode: 'CrashLoopBackOff', healthCheckedAt: '2026-09-30T00:00:00.000Z', observedGeneration: 5,
    errorCode: 'RUNTIME_FAILED', reconcileLockedBy: 'active-orchestrator', reconcileLockedAt: '2026-09-30T00:00:00.000Z' });
  const leased = structuredClone(deployment);
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-leased-runtime'), user.id);
  assert.deepEqual(store.deployments.get(deployment.id), leased, 'retry cannot steal an active runtime reconciliation lease');
  Object.assign(deployment, { reconcileLockedBy: null, reconcileLockedAt: null });
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-runtime-retry'), user.id);
  const runtimeRetry = store.deployments.get(deployment.id);
  assert.equal(runtimeRetry.status, 'IMAGE_READY');
  assert.equal(runtimeRetry.reconcileAttempts, 7);
  assert.equal(runtimeRetry.errorCode, null);
  assert.equal(runtimeRetry.healthFailureCode, null);
  assert.equal(runtimeRetry.healthCheckedAt, null);
  assert.equal(runtimeRetry.observedGeneration, null);
  assert.deepEqual(store.workflowJobs.find(row => row.id === job.id), succeededJob);
  Object.assign(store.resources.get(resource.id), { status: 'FAILED' });
  Object.assign(runtimeRetry, { status: 'BUILD_FAILED' });
  Object.assign(store.workflowJobs.find(row => row.id === job.id), { status: 'failed', attempts: 3, lockedBy: null, lockedAt: null });
  assert.equal((await repository.getTemplateInstallation(intent.installationId)).progress.status, 'failed');
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-failed-retry'), user.id);
  assert.equal(store.resources.get(resource.id).status, 'PROVISIONING');
  assert.equal(store.deployments.get(deployment.id).status, 'queued');
  assert.equal(store.workflowJobs.find(row => row.id === job.id).status, 'queued');
  assert.equal(store.workflowJobs.find(row => row.id === job.id).attempts, 3, 'retry preserves the worker lease generation');
  assert.ok(store.workflowJobs.find(row => row.id === job.id).maxAttempts >= 6);
  assert.deepEqual([...store.services.keys()], intent.services.map(row => row.id));
  assert.deepEqual([...store.resources.keys()], intent.resources.map(row => row.id));
  assert.deepEqual([...store.deployments.keys()], intent.services.map(row => row.deploymentId));
  assert.deepEqual(store.workflowJobs.map(row => row.id), intent.services.map(row => row.workflowJobId));
  const afterRetry = durableState(store);
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-failed-retry'), user.id);
  assert.deepEqual(durableState(store), afterRetry, 'a retry request replays without changes');
});

test('memory retry does not steal a running lease or accept a stale version', async () => {
  const context = await fixture();
  const { repository, store, user } = context;
  const body = request('fastapi', 'memory-running-install');
  const intent = await intentFor(context, body);
  await repository.installTemplateGraph(intent, body.inputs);
  const job = store.workflowJobs[0];
  Object.assign(job, { status: 'running', attempts: 1, lockedBy: 'builder-live', lockedAt: '2026-09-30T00:00:00.000Z' });
  store.deployments.get(intent.services[0].deploymentId).status = 'BUILD_FAILED';
  const before = durableState(store);
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-running-retry'), user.id);
  assert.deepEqual(withoutAudit(durableState(store)), withoutAudit(before));
  assert.equal(store.auditLogs.length, before.auditLogs.length + 1);
  const receipt = durableState(store);
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-running-retry'), user.id);
  assert.deepEqual(durableState(store), receipt, 'running no-op receipt replays without a second audit');
  Object.assign(store.workflowJobs[0], { status: 'failed', lockedBy: null, lockedAt: null });
  const laterFailure = durableState(store);
  await repository.retryTemplateInstallation(intent.installationId, retry('memory-running-retry'), user.id);
  assert.deepEqual(durableState(store), laterFailure, 'an earlier no-op retry key cannot reset a later failure');
  await assert.rejects(repository.retryTemplateInstallation(intent.installationId, { ...retry('memory-stale-retry'), expectedVersion: 2 }, user.id), error => error.statusCode === 409);
  assert.deepEqual(durableState(store), laterFailure);
});

test('memory install rolls back every durable collection after a late job insertion failure', async () => {
  for (const [catalogId, inputs] of [['next-postgres', {}], ['discord-bot', { DISCORD_TOKEN: rawToken }]]) {
    const context = await fixture();
    const { repository, store } = context;
    const body = request(catalogId, `memory-rollback-${catalogId}`, inputs);
    const intent = await intentFor(context, body, context.dev);
    const before = durableState(store);
    const enqueue = store.enqueueWorkflowJob;
    store.enqueueWorkflowJob = function (input) { enqueue.call(this, input); throw new Error('injected late template job failure'); };
    try {
      await assert.rejects(repository.installTemplateGraph(intent, inputs), /injected late template job failure/);
    } finally { store.enqueueWorkflowJob = enqueue; }
    assert.deepEqual(durableState(store), before, `${catalogId}: all rows and audit entries roll back`);
    await repository.installTemplateGraph(intent, inputs);
    assert.equal(store.templateInstallations.size, 1, 'the same request can recover after rollback');
  }
});

test('memory template admission rechecks current authorization, environment scope and latest quota', async () => {
  const context = await fixture();
  const { repository, store, organization, user, project } = context;
  const body = request('fastapi', 'memory-admission-install');
  const intent = await intentFor(context, body);
  for (const change of ['viewer', 'pending', 'banned', 'removed']) {
    const savedUser = structuredClone(store.users.get(user.id));
    const savedMembers = structuredClone(store.members);
    if (change === 'viewer') store.members.find(row => row.organizationId === organization.id && row.userId === user.id).role = 'VIEWER';
    if (change === 'pending') store.users.get(user.id).approvalStatus = 'PENDING';
    if (change === 'banned') store.users.get(user.id).bannedAt = new Date().toISOString();
    if (change === 'removed') store.members = [];
    await assert.rejects(repository.installTemplateGraph(intent, body.inputs), error => error.statusCode === (change === 'removed' ? 404 : 403), change);
    store.users.set(user.id, savedUser);
    store.members = savedMembers;
  }
  const foreignOrganization = await repository.createOrganization({ name: 'Foreign', slug: 'foreign' });
  const foreignProject = await repository.createProject({ organizationId: foreignOrganization.id, name: 'Foreign', slug: 'foreign' });
  const foreignEnvironment = await repository.resolveEnvironment(foreignProject.id);
  await assert.rejects(repository.templatePreflightContext(project.id, { environmentId: foreignEnvironment.id }, body.requestIdempotencyKey, user.id), error => error.statusCode === 404);
  await assert.rejects(repository.templatePreflightContext(foreignProject.id, {}, body.requestIdempotencyKey, user.id), error => error.statusCode === 404);
  const quota = [...store.quotas.values()].find(row => row.userId === user.id);
  store.quotas.set('newest-restrictive-quota', { ...quota, id: 'newest-restrictive-quota', maxServices: 0, updatedAt: '2030-01-01T00:00:00.000Z' });
  store.quotas.set('unrelated-account-quota', { ...quota, id: 'unrelated-account-quota', accountType: 'CLUB_MEMBER', maxServices: 100, updatedAt: '2040-01-01T00:00:00.000Z' });
  await assert.rejects(repository.installTemplateGraph(intent, body.inputs), error => [403, 409].includes(error.statusCode));
  assert.equal(store.templateInstallations.size, 0);
  assert.equal(store.services.size, 0);
  assert.equal(store.workflowJobs.length, 0);
});

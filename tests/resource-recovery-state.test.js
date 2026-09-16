import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as workflows from '../packages/core/src/workflows.ts';
import { ResourceRecoveryRepository, captureRecoveryProvenance } from '../packages/core/src/resource-recovery.ts';
import { MemoryRecoveryTransaction, assertRecoveryPins } from '../packages/core/src/resource-recovery-memory.ts';
import { fixture, request, commonRecoveryMatrix, scope } from './resource-recovery-fixture.test.js';
import { fence } from './resource-recovery-fixture.test.js';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { recoveryTransition, recoveryMillis } from '../packages/core/src/resource-recovery-state.ts';
import { LIFECYCLE_CONTRACT } from '../packages/core/src/lifecycle.ts';

test('PIN existing generic workflows claim builds but reserve health jobs', () => {
  // Given independent ready jobs, when the generic worker claims, then health stays reserved.
  const jobs = ['public-health-observe', 'build-and-deploy'].map(type => workflows.createWorkflowJobRecord({ type, targetId: type }));
  assert.equal(workflows.claimNextWorkflowJobFromList(jobs, { now: Date.now() + 1000 }).type, 'build-and-deploy');
});

test('resource recovery state happy path and resource recovery adversarial matrix in memory', async t => {
  // Given real in-memory transactional state, when running the shared behavior matrix, then the same contracts hold as PostgreSQL.
  const state = fixture();
  let quotaCalls = 0;
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => { quotaCalls++; });
  await commonRecoveryMatrix(t, [repository]);
  assert.equal(quotaCalls, 6);
  assert.equal(state.attempts.find(row => row.state === 'CLEANED').cleanupPending, false);
});

test('resource recovery adversarial matrix: source provenance, rollback, legacy and barriers', async () => {
  // Given server-owned provenance, when heartbeat time changes, then immutable incarnation stays stable.
  const state = fixture();
  const first = captureRecoveryProvenance(state.resources[0]);
  state.resources[0].desiredState.providerImageProvenance.observedAt = '2026-09-03T01:00:00Z';
  assert.equal(captureRecoveryProvenance(state.resources[0]).sourceGeneration, first.sourceGeneration);
  const tx = new MemoryRecoveryTransaction(state);
  const rejectQuota = new ResourceRecoveryRepository(tx, () => { throw new Error('quota denied'); });
  await assert.rejects(rejectQuota.createBackup(request()), /quota denied/);
  assert.equal(state.backups.length + state.jobs.length + state.pins.length, 0);
  const repository = new ResourceRecoveryRepository(tx, () => {});
  await repository.createBackup(request());
  assert.throws(() => assertRecoveryPins(state, ['resource_a']), { code: 'RESOURCE_RECOVERY_PINNED' });
  state.legacyBackups.push({ id: 'legacy', resourceId: 'resource_a' });
  assert.deepEqual(await repository.getBackup(scope, 'legacy'), { id: 'legacy', resourceId: 'resource_a', status: 'FAILED', errorCode: 'LEGACY_BACKUP_UNVERIFIED', recoverable: false });
  delete state.resources[0].desiredState.providerImageProvenance;
  await assert.rejects(repository.createBackup(request('no-provenance')), { code: 'SOURCE_IMAGE_PROVENANCE_UNAVAILABLE' });
});

test('resource recovery adversarial matrix: pinned target rejects attach and connection before publication', () => {
  // Given a target whose ordinary provisioner reports READY prematurely, when access is requested, then the independent target pin still wins.
  const store = new ControlPlaneStore();
  const resource = fixture().resources[0];
  resource.desiredState.providerConnection = { secretName: resource.connectionSecretName, environmentKeys: ['DATABASE_URL'] };
  store.resources.set(resource.id, resource);
  store.services.set('service_a', { id: 'service_a', projectId: resource.projectId, desiredSpec: {} });
  store.recoveryState.pins.push({ id: 'pin_a', resourceId: resource.id, backupId: 'backup_a', restoreId: 'restore_a', kind: 'RESTORE_TARGET', createdAt: '2026-09-03T00:00:00Z' });
  assert.throws(() => store.attachResource({ resourceId: resource.id, serviceId: 'service_a' }), { code: 'RECOVERY_TARGET_UNPUBLISHED' });
  assert.throws(() => store.resourceForConsole(resource), { code: 'RECOVERY_TARGET_UNPUBLISHED' });
});

test('resource recovery adversarial matrix: all transitions conform to lifecycle registry and UTC timestamps', () => {
  // Given every registry state pair, when applying a transition, then only registered next states succeed.
  for (const kind of ['backup', 'restore']) for (const [from, entry] of Object.entries(LIFECYCLE_CONTRACT.machines[kind].states)) for (const to of Object.keys(LIFECYCLE_CONTRACT.machines[kind].states)) {
    if (entry.next.includes(to)) assert.doesNotThrow(() => recoveryTransition(kind, from, to));
    else assert.throws(() => recoveryTransition(kind, from, to), { code: 'RECOVERY_TRANSITION_INVALID' });
  }
  assert.equal(recoveryMillis('2026-09-03T00:00:00'), Date.parse('2026-09-03T00:00:00Z'));
});

test('resource recovery adversarial matrix: project pin barrier precedes any descendant mutation', async () => {
  // Given a source pin and unrelated service descendant, when deleting the project, then every descendant remains untouched.
  const store = new ControlPlaneStore();
  const resource = fixture().resources[0];
  store.resources.set(resource.id, resource);
  store.projects.set(resource.projectId, fixture().projects[0]);
  store.services.set('service_a', { id: 'service_a', projectId: resource.projectId });
  store.recoveryState.pins.push({ id: 'pin_a', resourceId: resource.id, backupId: 'backup_a', restoreId: null, kind: 'ARTIFACT_SOURCE', createdAt: '2026-09-03T00:00:00Z' });
  assert.throws(() => store.deleteProject(resource.projectId), { code: 'RESOURCE_RECOVERY_PINNED' });
  assert.equal(store.services.size, 1);
  assert.equal(store.resources.size, 1);
  assert.equal(store.projects.size, 1);
});

test('resource recovery adversarial matrix: changed source is fenced terminally for recoverable cleanup', async () => {
  // Given an expired worker and changed applied generation, when claim is retried, then publication is terminally fenced and cleanup can proceed.
  const state = fixture();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const created = await repository.createBackup(request());
  await repository.claim(fence(created.operation.id));
  state.resources[0].desiredState.providerImageProvenance.workloadGeneration = 2;
  const result = await repository.claim(fence(created.operation.id, 'backup', { now: '2026-09-03T00:01:01Z' }));
  assert.equal(result.operation.status, 'FAILED');
  assert.equal(result.job.status, 'failed');
  assert.equal(result.operation.errorCode, 'SOURCE_CHANGED');
});

test('resource recovery adversarial matrix: concurrent store mutation is preserved across asynchronous quota evaluation', async () => {
  // Given a pending quota evaluation, when another store operation updates source provenance, then the transaction cannot overwrite it.
  const store = new ControlPlaneStore();
  const seed = fixture();
  store.organizations = new Map(seed.organizations.map(row => [row.id, row]));
  store.projects = new Map(seed.projects.map(row => [row.id, row]));
  store.resources = new Map(seed.resources.map(row => [row.id, row]));
  store.members = seed.members;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(store.recoveryState, store), async () => { entered.resolve(); await release.promise; });
  const pending = repository.createBackup(request());
  await entered.promise;
  store.resources.get('resource_a').desiredState.providerImageProvenance.workloadGeneration = 2;
  release.resolve();
  await assert.rejects(pending, { code: 'RECOVERY_TRANSACTION_CONFLICT' });
  assert.equal(store.resources.get('resource_a').desiredState.providerImageProvenance.workloadGeneration, 2);
  assert.equal(store.recoveryState.backups.length, 0);
});

test('resource recovery adversarial matrix: generic claims reserve recovery jobs', () => {
  // Given dedicated jobs, when a generic worker polls, then neither may be claimed.
  const jobs = ['resource.backup', 'resource.restore'].map(type => workflows.createWorkflowJobRecord({ type, targetId: type }));
  assert.equal(workflows.claimNextWorkflowJobFromList(jobs, { now: Date.now() + 1000 }), null);
});

test('resource recovery state happy path: additive persistence provides independent restrict pins', () => {
  // Given schema13, when inspecting its additive successor, then physical deletion has independent barriers.
  const file = new URL('../prisma/migrations/000014_resource_recovery/migration.sql', import.meta.url);
  assert.equal(existsSync(file), true, 'schema14 recovery migration must exist');
  const sql = readFileSync(file, 'utf8');
  for (const column of ['resourceId', 'backupId', 'restoreId']) assert.match(sql, new RegExp(`FOREIGN KEY \\("${column}"\\)[^;]+ON DELETE RESTRICT`));
});

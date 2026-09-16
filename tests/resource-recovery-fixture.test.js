import assert from 'node:assert/strict';
import { emptyRecoveryState } from '../packages/core/src/resource-recovery-memory.ts';

export const now = '2026-09-03T00:00:00.000Z';
export const scope = { organizationId: 'org_a', actorUserId: 'user_a' };
export const body = { requestIdempotencyKey: 'key_a', formatVersion: 1 };
export const artifact = { checksum: 'a'.repeat(64), size: '1024', keyVersion: 'key1' };
export function fixture() {
  const state = emptyRecoveryState();
  state.organizations.push({ id: 'org_a' }, { id: 'org_b' });
  state.projects.push({ id: 'project_a', organizationId: 'org_a', status: 'ACTIVE' }, { id: 'project_b', organizationId: 'org_b', status: 'ACTIVE' });
  state.members.push({ organizationId: 'org_a', userId: 'user_a', role: 'OWNER' }, { organizationId: 'org_b', userId: 'user_b', role: 'OWNER' });
  state.resources.push({ id: 'resource_a', projectId: 'project_a', name: 'source', slug: 'source', type: 'database', engine: 'postgresql', provider: 'local', plan: 'shared-small', region: 'local', version: '16', status: 'READY', desiredSpec: { storageMb: 1024 }, connectionSecretName: 'resource-a-connection', desiredState: {
    providerIdentity: { namespace: 'org-a', name: 'resource-a' }, credentialSecretUID: 'credential-uid', credentialSecretGeneration: 'a'.repeat(43),
    providerImageProvenance: { schema: 'raibitserver.provider-image/v1', image: `postgres@sha256:${'b'.repeat(64)}`, workloadUid: 'workload-uid', workloadGeneration: 1, observedAt: now },
  } });
  state.resources.push({ ...structuredClone(state.resources[0]), id: 'resource_b', projectId: 'project_b' });
  return state;
}
export function request(key = 'key_a') { return { ...scope, sourceId: 'resource_a', body: { ...body, requestIdempotencyKey: key }, now }; }
export function fence(operationId, kind = 'backup', overrides = {}) { return { organizationId: 'org_a', kind, operationId, workerId: 'worker1', attempt: 1, now, ...overrides }; }
export async function readyBackup(repository, operationId, overrides = {}) {
  const input = fence(operationId, 'backup', overrides);
  await repository.claim(input);
  await repository.mutate(input, { action: 'intent', keyVersion: 'key1' });
  await repository.mutate(input, { action: 'upload', uploadId: 'upload1' });
  await repository.mutate(input, { action: 'candidate', storedBytes: '1024', plaintextBytes: '512', checksum: artifact.checksum });
  await repository.mutate(input, { action: 'complete' });
  await repository.mutate(input, { action: 'verify' });
  return repository.mutate(input, { action: 'ready', artifact });
}
export async function commonRecoveryMatrix(t, repositories) {
  const repository = repositories[0];
  const created = await Promise.all(Array.from({ length: 20 }, (_, index) => repositories[index % repositories.length].createBackup(request())));
  const backup = created[0].operation;
  assert.equal(new Set(created.map(row => row.operation.id)).size, 1);
  assert.equal(new Set(created.map(row => row.job.id)).size, 1);
  assert.match(created[0].job.id, /^job_[a-f0-9]{64}$/);
  assert.deepEqual(created[0].job.payload, { version: 1, operationId: backup.id });
  await t.test('foreign and missing IDs have identical scoped failures', async () => {
    // Given another org source and no source, when creating, then both return identical missing errors.
    for (const sourceId of ['resource_b', 'absent']) await assert.rejects(repository.createBackup({ ...request('foreign'), sourceId }), { code: 'RECOVERY_NOT_FOUND', statusCode: 404 });
  });
  await t.test('client artifact metadata is rejected before writes', async () => {
    // Given untrusted object ownership, when creating, then strict parsing rejects it.
    for (const field of ['organizationId', 'artifactKey', 'checksum', 'targetResourceId', 'sourceProvenance']) await assert.rejects(repository.createBackup({ ...request('bad'), body: { ...body, [field]: 'owned-by-client' } }), { code: 'RECOVERY_INPUT_INVALID' });
  });
  await readyBackup(repository, backup.id);
  const view = await repository.getBackup(scope, backup.id);
  assert.equal(view.size, '1024');
  for (const privateField of ['artifactKey', 'artifactChecksum', 'sourceProvenance', 'encryptionKeyVersion', 'cleanupToken', 'uploadId']) assert.equal(Object.hasOwn(view, privateField), false);
  const restoreInput = { ...scope, sourceId: backup.id, body: { ...body, name: 'restored' }, now };
  const restores = await Promise.all(Array.from({ length: 20 }, (_, index) => repositories[index % repositories.length].createRestore(restoreInput)));
  const restore = restores[0].operation;
  assert.equal(new Set(restores.map(row => row.operation.id)).size, 1);
  assert.notEqual(restore.targetResourceId, restore.sourceResourceId);
  assert.equal(restore.projectId, backup.projectId);
  await assert.rejects(repository.createRestore({ ...restoreInput, body: { ...restoreInput.body, name: 'different' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(repository.createRestore({ ...restoreInput, body: { ...restoreInput.body, requestIdempotencyKey: 'second' } }), { code: 'RESTORE_TARGET_EXISTS' });
  const restoreFence = fence(restore.id, 'restore');
  await repository.claim(restoreFence);
  await repository.mutate(restoreFence, { action: 'verify' });
  await repository.mutate(restoreFence, { action: 'ready' });
  await assert.rejects(repository.mutate(restoreFence, { action: 'fail', code: 'RECOVERY_EXECUTION_FAILED' }), { code: 'RECOVERY_LEASE_LOST' });
  await t.test('expired leases cannot publish and retries preserve first deadline', async () => {
    // Given a claimed backup, when another worker resumes after lease expiry, then old results are rejected.
    const pending = await repository.createBackup(request('lease'));
    const old = fence(pending.operation.id);
    const first = await repository.claim(old);
    await repository.mutate(old, { action: 'intent', keyVersion: 'key1' });
    const resumed = fence(pending.operation.id, 'backup', { workerId: 'worker2', attempt: 2, now: '2026-09-03T00:01:01.000Z' });
    const next = await repository.claim(resumed);
    assert.equal(new Date(next.operation.deadlineAt.endsWith('Z') ? next.operation.deadlineAt : `${next.operation.deadlineAt}Z`).toISOString(), first.operation.deadlineAt);
    assert.equal(next.operation.status, 'RUNNING');
    await assert.rejects(repository.mutate({ ...old, now: resumed.now }, { action: 'ready', artifact }), { code: 'RECOVERY_LEASE_LOST' });
    await repository.mutate(resumed, { action: 'fail', code: 'RECOVERY_EXECUTION_FAILED' });
    await assert.rejects(repository.claim({ ...resumed, now: '2026-09-03T00:03:00.000Z' }), { code: 'RECOVERY_TERMINAL' });
  });
  await t.test('retention refuses new restores and active target pins block object cleanup', async () => {
    // Given an active restore at expiry, when retention starts, then its backup object remains pinned.
    const active = await repository.createRestore({ ...restoreInput, body: { ...body, requestIdempotencyKey: 'active', name: 'active' } });
    const expired = '2026-10-03T00:00:00.000Z';
    await repository.expireBackup({ organizationId: scope.organizationId, operationId: backup.id, now: expired });
    await assert.rejects(repository.createRestore({ ...restoreInput, body: { ...body, requestIdempotencyKey: 'late', name: 'late' }, now: expired }), { code: 'BACKUP_NOT_RECOVERABLE' });
    await assert.rejects(repository.claimCleanup(fence(backup.id, 'backup', { now: expired })), { code: 'RECOVERY_RESTORE_PINNED' });
    await repository.cancelRestore({ ...scope, operationId: active.operation.id, now: expired });
    const targetCleanup = await repository.claimCleanup(fence(active.operation.id, 'restore', { now: expired }));
    await repository.finishCleanup({ ...fence(active.operation.id, 'restore', { now: expired }), token: targetCleanup.operation.cleanupToken });
    const cleanup = await repository.claimCleanup(fence(backup.id, 'backup', { now: expired }));
    assert.equal(cleanup.attempts[0].candidateStoredBytes, '1024');
    await assert.rejects(repository.finishCleanup({ ...fence(backup.id, 'backup', { now: expired }), token: 'stale' }), { code: 'RECOVERY_LEASE_LOST' });
    const done = await repository.finishCleanup({ ...fence(backup.id, 'backup', { now: expired }), token: cleanup.operation.cleanupToken });
    assert.equal(done.status, 'DELETED');
  });
  await t.test('three attempts and absolute deadline terminally fence exhausted work', async () => {
    // Given the fixed retry budget, when claims are exhausted or the original deadline expires, then the job cannot resume.
    const retries = await repository.createBackup(request('attempt-budget'));
    for (const [index, at] of ['2026-09-03T00:00:00Z', '2026-09-03T00:01:01Z', '2026-09-03T00:02:02Z'].entries()) {
      const claimed = await repository.claim(fence(retries.operation.id, 'backup', { now: at, workerId: `retry${index}` }));
      assert.equal(claimed.job.attempts, index + 1);
    }
    const exhausted = await repository.claim(fence(retries.operation.id, 'backup', { now: '2026-09-03T00:03:03Z' }));
    assert.equal(exhausted.operation.status, 'FAILED');
    assert.equal(exhausted.job.attempts, 3);
    const deadline = await repository.createBackup(request('deadline-budget'));
    await repository.claim(fence(deadline.operation.id));
    const heartbeat = await repository.mutate(fence(deadline.operation.id, 'backup', { now: '2026-09-03T00:00:20Z' }), { action: 'heartbeat' });
    assert.equal(heartbeat.job.lockedAt, '2026-09-03T00:00:20.000Z');
    const expired = await repository.claim(fence(deadline.operation.id, 'backup', { now: '2026-09-03T00:30:00Z' }));
    assert.equal(expired.operation.status, 'FAILED');
    assert.equal(expired.operation.errorCode, 'DEADLINE_EXCEEDED');
    assert.equal(expired.job.attempts, 1);
  });
  return { backupId: backup.id, restoreId: restore.id };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute as resources, emitVerifiedLifecycleReceipts, releaseCapabilitiesVerified } from '../scripts/production-evidence/steps/resources.mjs';
import { execute as sql, validateRecoveryDescriptors, runVerifiedRecovery } from '../scripts/production-evidence/steps/backup-sql.mjs';
import { execute as nosql, validateCacheRecovery } from '../scripts/production-evidence/steps/backup-nosql.mjs';
import { parseStepResult } from '../scripts/production-evidence/lib/step-contract.mjs';
import { ResourceLifecycleReceiptSchema, SqliteLifecycleReceiptSchema } from '../packages/schemas/src/resource-lifecycle-evidence.ts';
import { runFixedStepMain, stepReceiptExitCode } from '../scripts/production-evidence/run-component.mjs';
import { createDataJournalFixture } from './fixtures/production-evidence-data-journal.mjs';
import { ResourceRecoveryRepository } from '../packages/core/src/resource-recovery.ts';
import { MemoryRecoveryTransaction } from '../packages/core/src/resource-recovery-memory.ts';
import { body as recoveryBody, fence, fixture as recoveryState, readyBackup, request as recoveryRequest, scope as recoveryScope } from './resource-recovery-fixture.test.js';

const engines = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey'], hex = (c) => c.repeat(64);
const clients = { postgresql: 'psql', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongosh', redis: 'redis-cli', valkey: 'valkey-cli' };

function identity() { return { runId: randomUUID(), environmentFingerprint: hex('1'), sourceCommitSha: '2'.repeat(40), migrationDigest: hex('3'), approvedInputSha256: '0EC3728F53E872561F78D2A4849EBB11C037FF65529439AD5E55DAD49EB9AEE2', operatorContractDigest: hex('4'), operatorInputFingerprint: hex('5') }; }

async function makeRequest(step, t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-t27-')), runIdentity = identity(), runDirectory = path.join(parent, runIdentity.runId);
  await mkdir(runDirectory); await writeFile(path.join(runDirectory, 'run.json'), `${JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: runIdentity })}\n`);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { schema: 'raibitserver.production-evidence-step-request/v1', step, identity: runIdentity, startedAt: '2026-09-04T00:00:00.000Z', deadlineAt: '2026-09-04T01:00:00.000Z', runDirectory,
    selectors: { RAIBITSERVER_RELEASE_KUBE_CONTEXT: 'release', RAIBITSERVER_RELEASE_NAMESPACE_PREFIX: 'raibit' }, secretRefs: [], state: {} };
}

function context() {
  const calls = [];
  return { calls, now: () => '2026-09-04T00:00:01.000Z',
    controlPlaneJson: async (input) => { calls.push(['control', input]); throw new Error('must not run'); },
    resourceProbe: async (input) => { calls.push(['probe', input]); throw new Error('must not run'); },
    executeFile: async (...args) => { calls.push(['process', ...args]); throw new Error('must not run'); },
    writeArtifact: async (component, name, value) => { calls.push(['artifact', value]); return { path: `${component}/${name}`, sha256: hex('e'), redacted: true }; } };
}

for (const [step, runner] of [['resources', resources], ['backup-sql', sql], ['backup-nosql', nosql]]) {
  test(`${step}: canonical disabled release capabilities stop before mutation`, async (t) => {
    const request = await makeRequest(step, t);
    const adapter = context();
    const result = await runner(request, adapter);
    assert.equal(parseStepResult(result, step, request).status, 'NOT_RUN');
    assert.equal(result.reason, 'release_capability_not_verified');
    assert.deepEqual(adapter.calls.map(([kind]) => kind), ['artifact']);
    assert.doesNotMatch(JSON.stringify(result), /credential|endpoint|secretKey|artifactKey|presigned/i);
  });
}

test('capability helper requires recorded release evidence and every named release bit', () => {
  const contract = { engines: [...engines, 'sqlite'].map((engine) => ({ engine, release: { provision: true, authenticatedHealth: true, attach: true, query: true, schema: true }, liveEvidence: { release: 'recorded' } })) };
  assert.equal(releaseCapabilitiesVerified(contract), true);
  contract.engines[0].release.query = false;
  assert.equal(releaseCapabilitiesVerified(contract), false);
});

function managedReceipt(id, engine) {
  const stamp = '2026-09-04T00:00:01.000Z';
  return { schema: 'raibitserver.resource-lifecycle/v1', engine, level: 'L3', provenance: 'credentialed', identity: id, providerImage: `registry.example/${engine}@sha256:${hex('a')}`, namespace: 'tenant-a',
    objects: { workloadUid: `workload-${engine}`, podUid: `provider-${engine}`, pvcUid: `pvc-${engine}`, secretUid: `secret-${engine}`, secretName: `secret-${engine}`, secretImmutable: true, storageBound: true, workloadReady: true },
    attachment: { id: `attach-${engine}`, serviceId: 'service-a', deploymentId: 'deployment-a', namespace: 'tenant-a', consumerPodUid: `consumer-${engine}`, secretName: `secret-${engine}`, key: 'DATABASE_URL', secretUid: `secret-${engine}` },
    native: { kind: 'engine-native', client: clients[engine], namespace: 'tenant-a', consumerPodUid: `consumer-${engine}`, secretUid: `secret-${engine}`, authenticated: true, healthExitCode: 0, writeExitCode: 0, readExitCode: 0, nonce: randomUUID(), inputSha256: hex('b'), readSha256: hex('b') },
    providerHealth: { kind: 'engine-native', client: clients[engine], namespace: 'tenant-a', providerPodUid: `provider-${engine}`, secretUid: `secret-${engine}`, authenticated: true, healthExitCode: 0 },
    times: { createdAt: stamp, providerHealthAt: stamp, readyAt: stamp, attachedAt: stamp, healthAt: stamp, sentinelAt: stamp, detachedAt: stamp, consumerRemovedAt: stamp, providerDeleteStartedAt: stamp, objectsDeletedAt: stamp, rowDeletedAt: stamp, cleanupAt: stamp },
    deletion: { attachmentsRemaining: 0, injectedRefsRemaining: 0, consumerRemoved: true, providerObjectsRemaining: 0, resourceRowsRemaining: 0 }, cleanup: 'PASS' };
}

function sqliteReceipt(id) {
  const stamp = '2026-09-04T00:00:01.000Z';
  return { schema: 'raibitserver.sqlite-lifecycle/v1', engine: 'sqlite', level: 'L1', provenance: 'local', identity: id, databaseId: randomUUID(), inputSha256: hex('c'), readSha256: hex('c'), times: { createdAt: stamp, writtenAt: stamp, readAt: stamp, removedAt: stamp }, writeCount: 1, readCount: 1, cleanup: 'PASS', fileRemoved: true };
}

test('trusted probe emits six managed lifecycle receipts and one SQLite receipt bijectively', async (t) => {
  const request = await makeRequest('resources', t);
  const receipts = [...engines.map((engine) => managedReceipt(request.identity, engine)), sqliteReceipt(request.identity)];
  const resourceIds = Object.fromEntries(engines.map((engine) => [engine, `resource-${engine}`]));
  const graph = { organizationId: 'organization-a', projectId: 'project-a', serviceId: 'service-a', deploymentId: 'deployment-a', resources: resourceIds };
  const written = [];
  const adapter = { resourceProbe: async ({ descriptor, engine, phase, nonce }) => { const receipt = receipts.find((value) => value.engine === engine); return { ...descriptor, engine, phase, nonce, authenticated: true, healthExitCode: 0, writeExitCode: 0, readExitCode: 0, inputSha256: receipt.native.inputSha256, readSha256: receipt.native.readSha256 }; },
    writeArtifact: async (component, name, value) => { written.push(value); return { path: `${component}/${name}`, sha256: hex('e'), redacted: true }; } };
  const artifacts = await emitVerifiedLifecycleReceipts(request, adapter, receipts, resourceIds, graph);
  assert.equal(artifacts.length, 7);
  assert.equal(written.filter((value) => ResourceLifecycleReceiptSchema.safeParse(value).success).length, 6);
  assert.equal(written.filter((value) => SqliteLifecycleReceiptSchema.safeParse(value).success).length, 1);
  assert.equal(new Set(artifacts.map(({ path: artifactPath }) => artifactPath)).size, 7);
});

test('missing probe and descriptor splice cannot produce lifecycle evidence', async (t) => {
  const request = await makeRequest('resources', t);
  await assert.rejects(() => emitVerifiedLifecycleReceipts(request, { writeArtifact() {} }, []), /resource_probe_unavailable/);
  const receipt = managedReceipt(request.identity, 'postgresql');
  const receipts = [receipt, ...engines.slice(1).map((engine) => managedReceipt(request.identity, engine)), sqliteReceipt(request.identity)];
  const resourceIds = Object.fromEntries(engines.map((engine) => [engine, `resource-${engine}`]));
  const graph = { organizationId: 'organization-a', projectId: 'project-a', serviceId: 'service-a', deploymentId: 'deployment-a', resources: resourceIds };
  const probes = { resourceProbe: async () => { throw new Error('must not run'); }, writeArtifact() {} };
  await assert.rejects(() => emitVerifiedLifecycleReceipts(request, probes, receipts, resourceIds), /lifecycle_descriptor_invalid/);
  await assert.rejects(() => emitVerifiedLifecycleReceipts(request, probes, receipts, resourceIds, { ...graph, resources: { ...resourceIds, postgresql: 'foreign' } }), /lifecycle_descriptor_invalid/);
  await assert.rejects(() => emitVerifiedLifecycleReceipts(request, { resourceProbe: async ({ descriptor, engine, phase, nonce }) => ({ ...descriptor, secretUid: 'spliced', engine, phase, nonce, authenticated: true, healthExitCode: 0 }), writeArtifact() {} }, receipts, resourceIds, graph), /descriptor_splice/);
});

test('recovery descriptors reject same target and cache proof binds TTL/type/count/value', () => {
  const source = { role: 'source', engine: 'redis', resourceId: 'source', namespace: 'tenant-a', providerPodUid: 'provider-a', consumerPodUid: 'consumer-a', secretUid: 'secret-a', secretName: 'secret-a', secretKey: 'DATABASE_URL' };
  const target = { ...source, role: 'target', resourceId: 'target', providerPodUid: 'provider-b', consumerPodUid: 'consumer-b', secretUid: 'secret-b', secretName: 'secret-b' };
  assert.equal(validateRecoveryDescriptors(source, target, 'redis'), true);
  assert.throws(() => validateRecoveryDescriptors(source, { ...target, resourceId: 'source' }, 'redis'), /descriptor_splice/);
  assert.equal(validateCacheRecovery(source, target, { authenticated: true, keyType: 'string', valueSha256: hex('d'), expectedValueSha256: hex('d'), keyCount: 1, ttlMs: 60_000, serverTimeMs: 1_000 }), true);
  assert.throws(() => validateCacheRecovery(source, target, { authenticated: true, keyType: 'string', valueSha256: hex('d'), expectedValueSha256: hex('d'), keyCount: 1, ttlMs: 0, serverTimeMs: 1_000 }), /cache_restore_mismatch/);
});

test('memory recovery transaction atomically removes the restore pin at READY before backup deletion', async () => {
  const state = recoveryState(), repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const backup = await repository.createBackup(recoveryRequest('runner-source'));
  await readyBackup(repository, backup.operation.id);
  const restore = await repository.createRestore({ ...recoveryScope, sourceId: backup.operation.id,
    body: { ...recoveryBody, requestIdempotencyKey: 'runner-restore', name: 'runner-restore' }, now: '2026-09-03T00:02:00Z' });
  assert.equal(state.pins.some(({ restoreId }) => restoreId === restore.operation.id), true);
  const lease = fence(restore.operation.id, 'restore', { now: '2026-09-03T00:02:01Z' });
  await repository.claim(lease); await repository.mutate(lease, { action: 'verify' });
  const ready = await repository.mutate(lease, { action: 'ready' });
  assert.equal(ready.operation.status, 'READY'); assert.equal(state.pins.some(({ restoreId }) => restoreId === restore.operation.id), false);
  assert.equal((await repository.requestBackupDeletion(recoveryScope, backup.operation.id, { confirmed: true }, '2026-09-03T00:03:00Z')).status, 'DELETING');
});

test('shell wrappers bind compile-time fixed entrypoints without a selectable step argument', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['resources', 'backup-sql', 'backup-nosql']) {
    const wrapper = await readFile(new URL(`../scripts/production-evidence/${name}.sh`, import.meta.url), 'utf8');
    const entrypoint = await readFile(new URL(`../scripts/production-evidence/runners/${name}.mjs`, import.meta.url), 'utf8');
    assert.match(wrapper, /direct_component_execution_forbidden/);
    assert.doesNotMatch(wrapper, /--step/);
    assert.match(entrypoint, new RegExp(`runFixedStepMain\\('${name}'`));
  }
});

test('fixed-step main maps PASS to 0, evidence outcomes to 1, and harness errors to 2', async () => {
  assert.equal(stepReceiptExitCode({ status: 'PASS' }), 0);
  assert.equal(stepReceiptExitCode({ status: 'FAIL' }), 1);
  assert.equal(stepReceiptExitCode({ status: 'NOT_RUN' }), 1);
  const messages = [];
  const invalid = await runFixedStepMain('resources', [], { stderr: { write: (value) => messages.push(value) } });
  assert.equal(invalid.exitCode, 1);
  assert.deepEqual(messages, ['direct_component_execution_forbidden\n']);
});

function recoveryAdapter({ dirtyTarget = false, failedBackup = false, failedBackupDelete = false, foreignHistory = false, mismatchedReady = false, deletionBody, lostBackupResponse = false, backupStillListed = false, backupListUnavailable = false, backupCursorLoop = false, foreignBackupPage = false } = {}, journal = {}) {
  const calls = [];
  const attachment = { id: 'attach-source', serviceId: 'service-a', deploymentId: 'deployment-a', namespace: 'tenant-a', consumerPodUid: 'consumer-a', secretUid: 'secret-a', secretName: 'secret-a', key: 'DATABASE_URL' };
  const backup = (status) => ({ id: 'backup-postgresql', organizationId: 'org-a', projectId: 'project-a', resourceId: 'source', engine: 'postgresql', status, createdAt: '2026-09-04T00:00:00.000Z', readyAt: status === 'READY' ? '2026-09-04T00:01:00.000Z' : null, errorCode: null, size: ['READY', 'DELETING'].includes(status) ? '1024' : null, expiresAt: status === 'READY' ? '2026-09-05T00:00:00.000Z' : null, recoverable: status === 'READY' });
  const restore = (status) => ({ id: 'restore-postgresql', organizationId: 'org-a', projectId: 'project-a', backupId: 'backup-postgresql', sourceResourceId: 'source', targetResourceId: 'target', engine: 'postgresql', status, createdAt: '2026-09-04T00:01:01.000Z', readyAt: status === 'READY' ? '2026-09-04T00:02:00.000Z' : null, errorCode: null });
  const descriptor = (role, resourceId) => { const suffix = role === 'source' ? 'a' : 'b'; const boundAttachment = { ...attachment, id: `attach-${role}`, consumerPodUid: `consumer-${suffix}`, secretUid: `secret-${suffix}`, secretName: `secret-${suffix}` }; return { engine: 'postgresql', role, resourceId, namespace: 'tenant-a', providerPodUid: `provider-${suffix}`, consumerPodUid: `consumer-${suffix}`, secretUid: `secret-${suffix}`, secretName: `secret-${suffix}`, secretKey: 'DATABASE_URL', attachment: boundAttachment }; };
  return { ...journal, calls, now: () => '2026-09-04T00:10:00.000Z',
    controlPlaneJson: async (input) => {
      calls.push(['control', input.method, input.path]);
      if (['POST', 'DELETE'].includes(input.method)) { const expected = input.method === 'POST' ? (input.path.endsWith('/restores') ? 'control-plane-create-restore' : 'control-plane-create-backup') : (input.path.startsWith('/api/backups/') ? 'control-plane-delete-backup' : 'control-plane-delete-restore-target');
        assert.equal((await journal.journalAuthority.loadCleanup()).pending.at(-1)?.mutationKind, expected); }
      if (input.path.endsWith('/backups') && input.method === 'POST') { assert.deepEqual(input.body, { requestIdempotencyKey: `${input.body.requestIdempotencyKey.split(':').slice(0, 2).join(':')}:backup`, formatVersion: 1 }); if (lostBackupResponse) throw new Error('lost'); return { statusCode: 202, body: backup('QUEUED') }; }
      if (input.path.endsWith('/backups') && input.method === 'GET') { if (backupListUnavailable) throw new Error('unavailable'); const second = input.query?.cursor === 'page-2'; return { statusCode: 200, body: { backups: second && (backupStillListed || foreignBackupPage) ? [{ ...backup('DELETING'), ...(foreignBackupPage ? { id: 'other', organizationId: 'foreign' } : {}) }] : [], nextCursor: backupCursorLoop || !second ? 'page-2' : null } }; }
      if (input.path.endsWith('/restores')) { assert.deepEqual(Object.keys(input.body).sort(), ['formatVersion', 'name', 'requestIdempotencyKey']); return { statusCode: 202, body: restore('QUEUED') }; }
      if (input.path.startsWith('/api/backups/') && input.method === 'DELETE') { assert.deepEqual(input.body, { confirmed: true }); return { statusCode: 200, body: backup('DELETING') }; }
      if (input.method === 'DELETE') return { statusCode: 200, body: deletionBody ?? { deletionRequested: true, status: 'DELETE_REQUESTED', resourceId: 'target' } };
      return { statusCode: 200, body: {} };
    },
    waitForState: async (input) => {
      calls.push(['wait', input.path, input.terminal]);
      if (input.path.endsWith('/backups')) { const states = failedBackup ? ['QUEUED', 'RUNNING', 'FAILED'] : ['QUEUED', 'RUNNING', 'VERIFYING', 'READY']; const observations = states.map(backup); if (foreignHistory) observations[1] = { ...observations[1], organizationId: 'foreign' }; const view = backup(states.at(-1)); return { view: mismatchedReady ? { ...view, id: 'stale-backup' } : view, observations }; }
      const states = ['QUEUED', 'RUNNING', 'VERIFYING', 'READY']; return { view: restore('READY'), observations: states.map(restore) };
    },
    resourceProbe: async ({ descriptor, engine, phase, nonce }) => ({ ...descriptor, engine, phase, nonce, authenticated: true, inputSha256: hex('b'), readSha256: phase === 'target' ? hex('b') : hex('c'), schemaSha256: hex('d'), recordCount: 1 }),
    resolveResourceDescriptor: async ({ role, resourceId }) => { calls.push(['descriptor', role, resourceId]); return descriptor(role, resourceId); },
    recoveryEvidenceProbe: async ({ runId, operationId }) => ({ kind: 'backup-provenance', runId, operationId, verified: true }),
    postDeleteProbe: async ({ kind, runId, operationId }) => kind === 'backup-delete' ? { kind, runId, operationId, artifactDeleted: !failedBackupDelete } : { kind, runId, operationId, resourceRowsRemaining: 0, attachmentsRemaining: 0, injectedRefsRemaining: 0, providerObjectsRemaining: dirtyTarget ? 1 : 0 },
    writeArtifact: async (component, name) => ({ path: `${component}/${name}`, sha256: hex('e'), redacted: true }) };
}

async function recoverySetup(request, t, options = {}) {
  const fixture = await createDataJournalFixture(request, t, ['postgresql'], options);
  request.state = { authenticatedClient: {}, ...fixture.state };
  return recoveryAdapter(options, { journalAuthority: fixture.authority });
}

test('missing narrow recovery hooks returns NOT_RUN before any mutation', async (t) => {
  const request = await makeRequest('backup-sql', t);
  request.state = { authenticatedClient: {}, bindings: { organizationId: 'org-a', projectId: 'project-a', resources: { postgresql: 'source' } } };
  const calls = [];
  const result = await runVerifiedRecovery(request, { controlPlaneJson: async (input) => { calls.push(input); throw new Error('forbidden'); }, writeArtifact: async (component, name) => ({ path: `${component}/${name}`, sha256: hex('e'), redacted: true }) }, ['postgresql']);
  assert.deepEqual([result.status, result.reason], ['NOT_RUN', 'recovery_evidence_adapter_unavailable']); assert.deepEqual(calls, []);
});

test('caller-constructed bindings without journal authority are rejected before I/O', async (t) => {
  const request = await makeRequest('backup-sql', t);
  request.state = { authenticatedClient: {}, bindings: { organizationId: 'org-a', projectId: 'project-a', resources: { postgresql: 'source' } } };
  const calls = [];
  const forbidden = async (...args) => { calls.push(args); throw new Error('forbidden'); };
  const result = await runVerifiedRecovery(request, { controlPlaneJson: forbidden, waitForState: forbidden, resourceProbe: forbidden, resolveResourceDescriptor: forbidden, recoveryEvidenceProbe: forbidden, postDeleteProbe: forbidden,
    writeArtifact: async (component, name) => ({ path: `${component}/${name}`, sha256: hex('e'), redacted: true }) }, ['postgresql']);
  assert.deepEqual([result.status, result.reason], ['NOT_RUN', 'recovery_evidence_adapter_unavailable']); assert.deepEqual(calls, []);
});

test('tampered binding journal snapshot is rejected before control-plane I/O', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t);
  request.state.bindingJournalSnapshot = { ...request.state.bindingJournalSnapshot, entriesSha256: hex('9') };
  const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
  assert.deepEqual([result.status, result.reason], ['FAIL', 'binding_journal_mismatch']); assert.equal(adapter.calls.some(([kind]) => ['control', 'probe', 'descriptor', 'wait'].includes(kind)), false);
});

test('verified recovery uses exact confirmed backup deletion and proves list/artifact plus target inventory deletion', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t);
  request.state.authenticatedClient = { schema: 'raibitserver.production-evidence-client/v1' };
  const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
  parseStepResult(result, 'backup-sql', request);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(result.cleanupInventory, []);
  assert.equal(adapter.calls.some(([kind, route]) => kind === 'wait' && route.includes('/backups')), true);
  assert.equal(adapter.calls.filter(([kind, method]) => kind === 'control' && method === 'DELETE').length, 2);
  const restorePosted = adapter.calls.findIndex(([kind, method, route]) => kind === 'control' && method === 'POST' && route.endsWith('/restores'));
  const targetResolved = adapter.calls.findIndex(([kind, role]) => kind === 'descriptor' && role === 'target');
  assert.ok(restorePosted >= 0 && targetResolved > restorePosted);
  const journal = await adapter.journalAuthority.loadCleanup();
  assert.deepEqual(journal.entries.map(({ entryType, mutationKind }) => [entryType, mutationKind ?? null]), [
    ['intent', 'control-plane-create-backup'], ['outcome', null], ['intent', 'control-plane-create-restore'], ['outcome', null],
    ['intent', 'control-plane-delete-backup'], ['outcome', null], ['intent', 'control-plane-delete-restore-target'], ['outcome', null]]);
});

test('exact immediate target deletion acknowledgment is accepted', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t, { deletionBody: { deleted: true, resourceId: 'target' } });
  assert.equal((await runVerifiedRecovery(request, adapter, ['postgresql'])).status, 'PASS');
});

test('partial cleanup failure is attempted unconditionally and leaves exact unresolved inventory', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t, { dirtyTarget: true });
  const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_failed');
  assert.deepEqual(result.cleanupInventory.map(({ resourceType, id }) => [resourceType, id]), [['restore-target', 'target']]);
  assert.equal(adapter.calls.filter(([kind, method]) => kind === 'control' && method === 'DELETE').length, 2);
});

test('backup terminal failure never passes and still cleans every allocated object', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t, { failedBackup: true });
  const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
  assert.deepEqual([result.status, result.reason], ['FAIL', 'backup_not_ready']);
  assert.equal(adapter.calls.filter(([kind, method]) => kind === 'control' && method === 'DELETE').length, 1);
});

test('lost backup response leaves a durable pending intent and performs no unbound continuation', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t, { lostBackupResponse: true });
  const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
  assert.equal(result.status, 'FAIL');
  assert.equal(adapter.calls.filter(([kind]) => kind === 'control').length, 1);
  const journal = await adapter.journalAuthority.loadCleanup();
  assert.deepEqual(journal.entries.map(({ entryType }) => entryType), ['intent']); assert.equal(journal.pending.length, 1);
});

test('backup deletion failure leaves the exact backup cleanup inventory item', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const adapter = await recoverySetup(request, t, { failedBackupDelete: true });
  const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.cleanupInventory, [{ type: 'control-plane', resourceType: 'backup', id: 'backup-postgresql', organizationId: 'org-a', projectId: 'project-a' }]);
});

test('direct fixed-step injection is forbidden before request or output I/O', async (t) => {
  const request = await makeRequest('backup-sql', t);
  const outputPath = path.join(request.runDirectory, 'forbidden-receipt.json');
  const messages = [];
  const outcome = await runFixedStepMain('backup-sql', ['--request', path.join(request.runDirectory, 'missing.json'), '--output', outputPath],
    { stderr: { write: (value) => messages.push(value) }, fixture: true, injectedExecuteStep: () => { throw new Error('must not execute'); } });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.receipt, null);
  assert.deepEqual(messages, ['direct_component_execution_forbidden\n']);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(outputPath), false);
});

test('foreign/stale recovery, forged journal, and invalid deletion acknowledgments fail closed', async (t) => {
  const invalidDeletes = [{}, { deletionRequested: true, status: 'ACTIVE', resourceId: 'target' }, { deletionRequested: true, status: 'READY', resourceId: 'target' }, { deletionRequested: true, status: 'DELETING', resourceId: 'wrong' }, { deleted: true, status: 'ACTIVE', resourceId: 'target' }, { deleted: true, resourceId: 'target', extra: true }];
  for (const [mutation, reason] of [[{ foreignHistory: true }, 'invalid_public_recovery_view'], [{ mismatchedReady: true }, 'invalid_public_recovery_view'], [{ tamperedJournal: true }, 'mutation_journal_failed'], [{ backupStillListed: true }, 'cleanup_failed'], [{ foreignBackupPage: true }, 'cleanup_failed'], [{ backupListUnavailable: true }, 'cleanup_failed'], [{ backupCursorLoop: true }, 'cleanup_failed'], ...invalidDeletes.map((deletionBody) => [{ deletionBody }, 'cleanup_failed'])]) {
    const request = await makeRequest('backup-sql', t);
    const adapter = await recoverySetup(request, t, mutation);
    const result = await runVerifiedRecovery(request, adapter, ['postgresql']);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, reason);
  }
});

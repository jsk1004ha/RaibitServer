import test from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../packages/core/src/rbac.ts';
import { ResourceRecoveryRepository } from '../packages/core/src/resource-recovery.ts';
import { MemoryRecoveryTransaction } from '../packages/core/src/resource-recovery-memory.ts';
import { PostgresRecoveryTransaction } from '../packages/core/src/resource-recovery-postgres.ts';
import { fixture, request, scope, readyBackup, body } from './resource-recovery-fixture.test.js';

test('recovery API core enforces the locked backup permission matrix', async () => {
  // Given every organization role, when checking recovery actions, then only the locked roles are authorized.
  assert.equal(can('OWNER', 'backup:manage'), true);
  assert.equal(can('ADMIN', 'backup:manage'), true);
  assert.equal(can('DB_ADMIN', 'backup:manage'), true);
  assert.equal(can('OWNER', 'backup:restore'), true);
  assert.equal(can('DB_ADMIN', 'backup:restore'), true);
  for (const role of ['MAINTAINER', 'DEVELOPER', 'VIEWER']) {
    assert.equal(can(role, 'backup:manage'), false);
    assert.equal(can(role, 'backup:restore'), false);
  }
  assert.equal(can('ADMIN', 'backup:restore'), false);
});

test('recovery API core lists safe v1 backup views with stable keyset pagination', async () => {
  // Given three v1 backups and a legacy row, when listing two pages, then ordering, expiry, and projection are stable and safe.
  const state = fixture();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const created = [];
  for (const [key, at] of [['one', '2026-09-03T00:00:00Z'], ['two', '2026-09-03T00:00:01Z'], ['three', '2026-09-03T00:00:01Z']]) {
    const result = await repository.createBackup({ ...request(key), now: at });
    created.push(result.operation);
  }
  state.legacyBackups.push({ id: 'legacy', resourceId: 'resource_a' });
  state.backups = state.backups.map((row, index) => index === 0
    ? { ...row, status: 'READY', readyAt: row.createdAt, expiresAt: '2026-09-03T00:00:02Z', artifactSize: '7', errorCode: 'INTERNAL_SECRET_ERROR' }
    : row);
  state.backups = state.backups.map(row => ({ ...row, createdAt: row.createdAt.replace('.000Z', '') }));

  const first = await repository.listBackups(scope, 'resource_a', { limit: 2, now: '2026-09-03T00:00:03Z' });
  const second = await repository.listBackups(scope, 'resource_a', { limit: 2, cursor: first.nextCursor, now: '2026-09-03T00:00:03Z' });
  assert.deepEqual([...first.backups, ...second.backups].map(row => row.id), [...created].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(row => row.id));
  assert.equal(first.backups.length, 2);
  assert.equal(second.backups.length, 1);
  assert.equal(second.nextCursor, null);
  await assert.rejects(repository.listBackups(scope, 'resource_a', { cursor: 'not-json' }), { code: 'RECOVERY_CURSOR_INVALID', statusCode: 400 });
  await assert.rejects(repository.listBackups(scope, 'resource_a', { limit: 1001 }), { code: 'RECOVERY_LIMIT_INVALID', statusCode: 400 });
  const expired = [...first.backups, ...second.backups].find(row => row.id === created[0].id);
  assert.equal(expired.recoverable, false);
  assert.equal(expired.errorCode, null);
  for (const privateField of ['artifactKey', 'artifactChecksum', 'sourceSpec', 'sourceProvenance', 'encryptionKeyVersion', 'cleanupToken', 'job']) {
    assert.equal(Object.hasOwn(expired, privateField), false);
  }
});

test('recovery API core applies the default backup page bound', async () => {
  // Given more than the default page size, when listing without options, then exactly 200 rows and a continuation cursor are returned.
  const state = fixture();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const seed = (await repository.createBackup(request('page-bound'))).operation;
  state.backups = Array.from({ length: 201 }, (_, index) => ({ ...seed, id: `backup_${String(index).padStart(3, '0')}`, requestIdempotencyKey: `page-${index}` }));
  const page = await repository.listBackups(scope, 'resource_a');
  assert.equal(page.backups.length, 200);
  assert.notEqual(page.nextCursor, null);
});

test('recovery API core returns safe restore views and indistinguishable scoped failures', async () => {
  // Given a ready backup and active restore, when reading the restore, then only public fields are returned and foreign/missing stay 404.
  const state = fixture();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const backup = await repository.createBackup(request('restore-source'));
  await readyBackup(repository, backup.operation.id);
  const restore = await repository.createRestore({ ...scope, sourceId: backup.operation.id, body: { ...body, requestIdempotencyKey: 'restore', name: 'restored' }, now: '2026-09-03T00:01:00Z' });
  const view = await repository.getRestore(scope, restore.operation.id);
  assert.deepEqual(Object.keys(view).sort(), ['backupId', 'createdAt', 'engine', 'errorCode', 'id', 'organizationId', 'projectId', 'readyAt', 'sourceResourceId', 'status', 'targetResourceId'].sort());
  for (const id of [restore.operation.id, 'missing']) {
    await assert.rejects(repository.getRestore({ organizationId: 'org_b', actorUserId: 'user_b' }, id), { code: 'RECOVERY_NOT_FOUND', statusCode: 404 });
  }
  state.members.push({ organizationId: 'org_a', userId: 'admin_a', role: 'ADMIN' });
  await assert.rejects(repository.getRestore({ organizationId: 'org_a', actorUserId: 'admin_a' }, restore.operation.id), { code: 'RECOVERY_FORBIDDEN', statusCode: 403 });
  await assert.rejects(repository.createRestore({ ...scope, sourceId: backup.operation.id, body: { ...body, requestIdempotencyKey: 'restore', name: 'changed' } }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('recovery API core authorizes owned create targets before inspecting lifecycle or provenance', async () => {
  // Given unauthorized same-org users and owned but unhealthy sources, when creating recovery work, then lifecycle details remain hidden behind 403.
  const state = fixture();
  state.members.push({ organizationId: 'org_a', userId: 'viewer_a', role: 'VIEWER' }, { organizationId: 'org_a', userId: 'admin_a', role: 'ADMIN' });
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const backup = await repository.createBackup(request('authorization-source'));
  await readyBackup(repository, backup.operation.id);
  state.resources[0].status = 'DELETING';
  await assert.rejects(repository.createBackup({ ...request('hidden-backup'), actorUserId: 'viewer_a' }), { code: 'RECOVERY_FORBIDDEN', statusCode: 403 });
  await assert.rejects(repository.createRestore({ ...scope, actorUserId: 'admin_a', sourceId: backup.operation.id, body: { ...body, requestIdempotencyKey: 'hidden-restore', name: 'hidden-restore' } }), { code: 'RECOVERY_FORBIDDEN', statusCode: 403 });
  state.backups.push({ ...backup.operation, id: 'malformed_backup', formatVersion: 0 });
  await assert.rejects(repository.createRestore({ ...scope, actorUserId: 'admin_a', sourceId: 'malformed_backup', body: { ...body, requestIdempotencyKey: 'hidden-malformed', name: 'hidden-malformed' } }), { code: 'RECOVERY_FORBIDDEN', statusCode: 403 });
});

test('recovery API core makes mutation audits replay-safe and deletion asynchronous', async () => {
  // Given first requests, replays, conflicts, and active restore pins, when mutating, then audits and deletion states are exact.
  const state = fixture();
  let quotaCalls = 0;
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => { quotaCalls += 1; });
  const first = await repository.createBackup(request('audit'));
  const replay = await repository.createBackup(request('audit'));
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(quotaCalls, 1);
  assert.equal(state.auditEvents.length, 1);
  assert.equal(state.auditEvents[0].action, 'resource.backup:requested');
  state.resources[0].status = 'PROVISIONING';
  const replayAfterSourceChange = await repository.createBackup(request('audit'));
  assert.equal(replayAfterSourceChange.operation.id, first.operation.id);
  assert.equal(quotaCalls, 1);
  assert.equal(state.auditEvents.length, 1);
  state.resources[0].status = 'READY';
  await assert.rejects(repository.createBackup({ ...request('audit'), body: { ...body, requestIdempotencyKey: 'audit', unexpected: true } }), { code: 'RECOVERY_INPUT_INVALID' });
  await readyBackup(repository, first.operation.id);
  const pending = await repository.createBackup(request('pending-delete'));
  await assert.rejects(repository.requestBackupDeletion(scope, pending.operation.id, { confirmed: true }), { code: 'RECOVERY_CLEANUP_INELIGIBLE' });
  const restore = await repository.createRestore({ ...scope, sourceId: first.operation.id, body: { ...body, requestIdempotencyKey: 'restore-pin', name: 'restore-pin' }, now: '2026-09-03T00:02:00Z' });
  assert.equal(state.auditEvents.filter(row => row.action === 'resource.restore:requested').length, 1);
  await assert.rejects(repository.requestBackupDeletion(scope, first.operation.id, { confirmed: true }, '2026-09-03T00:03:00Z'), { code: 'RECOVERY_RESTORE_PINNED' });
  state.pins = state.pins.filter(row => row.restoreId !== restore.operation.id);
  const deleting = await repository.requestBackupDeletion(scope, first.operation.id, { confirmed: true }, '2026-09-03T00:03:00Z');
  const repeated = await repository.requestBackupDeletion(scope, first.operation.id, { confirmed: true }, '2026-09-03T00:04:00Z');
  assert.equal(deleting.status, 'DELETING');
  assert.equal(repeated.status, 'DELETING');
  assert.equal(state.auditEvents.filter(row => row.action === 'resource.backup:delete-requested').length, 1);
  assert.deepEqual(Object.keys(state.auditEvents[0].metadata).sort(), ['engine', 'status']);
});

test('recovery API core replays backup and restore before inspecting retired source lifecycle', async () => {
  // Given committed backup and restore requests whose source is later retired, when exact keys replay, then the original rows return without side effects.
  const state = fixture();
  let quotaCalls = 0;
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => { quotaCalls += 1; });
  const backupInput = request('retired-backup-replay');
  const backup = await repository.createBackup(backupInput);
  await readyBackup(repository, backup.operation.id);
  const restoreInput = { ...scope, sourceId: backup.operation.id, body: { ...body, requestIdempotencyKey: 'retired-restore-replay', name: 'retired-restore' }, now: '2026-09-03T00:02:00Z' };
  const restore = await repository.createRestore(restoreInput);
  const before = { jobs: state.jobs.length, audits: state.auditEvents.length, quotaCalls };
  state.projects[0].deletionRequestedAt = '2026-09-03T00:03:00Z';
  state.resources[0].status = 'DELETED';
  state.resources[0].deletionRequestedAt = '2026-09-03T00:03:00Z';
  state.resources = state.resources.filter(row => row.id !== 'resource_a');

  const backupReplay = await repository.createBackup(backupInput);
  const restoreReplay = await repository.createRestore(restoreInput);
  assert.equal(backupReplay.operation.id, backup.operation.id);
  assert.equal(backupReplay.job.id, backup.job.id);
  assert.equal(restoreReplay.operation.id, restore.operation.id);
  assert.equal(restoreReplay.job.id, restore.job.id);
  assert.deepEqual({ jobs: state.jobs.length, audits: state.auditEvents.length, quotaCalls }, before);
  await assert.rejects(repository.createRestore({ ...restoreInput, body: { ...restoreInput.body, name: 'changed-after-retire' } }), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
});

test('recovery API core PostgreSQL transaction replays retired sources without persistence writes', async () => {
  // Given durable rows loaded by the PostgreSQL adapter, when exact requests replay after retirement, then no row, audit, job, or quota write occurs.
  const state = fixture();
  const memory = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const backupInput = request('postgres-retired-backup');
  const backup = await memory.createBackup(backupInput);
  await readyBackup(memory, backup.operation.id);
  const restoreInput = { ...scope, sourceId: backup.operation.id, body: { ...body, requestIdempotencyKey: 'postgres-retired-restore', name: 'postgres-retired' }, now: '2026-09-03T00:02:00Z' };
  const restore = await memory.createRestore(restoreInput);
  state.projects[0].deletionRequestedAt = '2026-09-03T00:03:00Z';
  state.resources[0].status = 'DELETED';
  state.resources[0].deletionRequestedAt = '2026-09-03T00:03:00Z';
  const writes = [];
  const sql = {
    async $transaction(work) { return work(this); },
    async $queryRawUnsafe(query) {
      if (query.includes('FROM "Organization" o WHERE')) return state.organizations.filter(row => row.id === 'org_a').map(row => ({ row }));
      if (query.includes('FROM "ResourceBackup" b WHERE')) return state.backups.map(row => ({ row }));
      if (query.includes('FROM "ResourceRestore" r WHERE')) return state.restores.map(row => ({ row }));
      if (query.includes('FROM "ResourceRecoveryPin"')) return state.pins.map(row => ({ row }));
      if (query.includes('FROM "ResourceRecoveryAttempt"')) return state.attempts.map(row => ({ row }));
      if (query.includes('FROM "WorkflowJob"')) return state.jobs.map(row => ({ row }));
      if (query.includes('FROM "Resource" r WHERE')) return state.resources.filter(row => row.projectId === 'project_a').map(row => ({ row }));
      if (query.includes('FROM "Project" p WHERE')) return state.projects.filter(row => row.organizationId === 'org_a').map(row => ({ row }));
      if (query.includes('FROM "Membership"')) return state.members.filter(row => row.organizationId === 'org_a').map(row => ({ row }));
      return [];
    },
    async $executeRawUnsafe(query, ...values) { writes.push({ query, values }); return 1; },
  };
  let quotaCalls = 0;
  const repository = new ResourceRecoveryRepository(new PostgresRecoveryTransaction(sql), () => { quotaCalls += 1; });
  assert.equal((await repository.createBackup(backupInput)).operation.id, backup.operation.id);
  assert.equal((await repository.createRestore(restoreInput)).operation.id, restore.operation.id);
  assert.equal(quotaCalls, 0);
  assert.equal(writes.length, 0);
});

test('recovery API core accepts every terminal cleanup state and replays deleted backups', async () => {
  // Given failed, expired, and deleted backups, when deletion is requested, then eligible rows move to DELETING and deleted rows remain idempotent.
  const state = fixture();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const seed = (await repository.createBackup(request('delete-states'))).operation;
  state.backups = [
    { ...seed, id: 'backup_failed', status: 'FAILED' },
    { ...seed, id: 'backup_expired', status: 'EXPIRED' },
    { ...seed, id: 'backup_deleted', status: 'DELETED' },
  ];
  for (const id of ['backup_failed', 'backup_expired']) {
    assert.equal((await repository.requestBackupDeletion(scope, id, { confirmed: true })).status, 'DELETING');
  }
  assert.equal((await repository.requestBackupDeletion(scope, 'backup_deleted', { confirmed: true })).status, 'DELETED');
  assert.equal(state.auditEvents.filter(row => row.action === 'resource.backup:delete-requested').length, 2);
});

test('recovery API core parses delete confirmation as an exact prototype-safe body', async () => {
  // Given malformed, missing, inherited, and exact confirmation bodies, when deletion is requested, then only one own confirmed=true field is accepted.
  const state = fixture();
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const backup = await repository.createBackup(request('delete-body'));
  await readyBackup(repository, backup.operation.id);
  const symbolExtra = { confirmed: true };
  Object.defineProperty(symbolExtra, Symbol('extra'), { enumerable: true, value: true });
  for (const input of [null, 'true', [], { confirmed: 'true' }, { confirmed: true, extra: true }, symbolExtra]) {
    await assert.rejects(repository.requestBackupDeletion(scope, backup.operation.id, input), { code: 'RECOVERY_INPUT_INVALID', statusCode: 400 });
  }
  for (const input of [{}, { confirmed: false }, Object.create({ confirmed: true })]) {
    await assert.rejects(repository.requestBackupDeletion(scope, backup.operation.id, input), { code: 'RECOVERY_CONFIRMATION_REQUIRED', statusCode: 400 });
  }
  const exact = Object.assign(Object.create(null), { confirmed: true });
  assert.equal((await repository.requestBackupDeletion(scope, backup.operation.id, exact)).status, 'DELETING');
  assert.equal((await repository.requestBackupDeletion(scope, backup.operation.id, { confirmed: true })).status, 'DELETING');
  assert.equal(state.auditEvents.filter(row => row.action === 'resource.backup:delete-requested').length, 1);
});

test('recovery API core rejects malformed delete bodies before target lookup or authorization', async () => {
  // Given missing and forbidden targets, when malformed bodies are supplied, then deterministic body errors precede target and permission errors.
  const state = fixture();
  state.members.push({ organizationId: 'org_a', userId: 'viewer_a', role: 'VIEWER' });
  const repository = new ResourceRecoveryRepository(new MemoryRecoveryTransaction(state), () => {});
  const backup = await repository.createBackup(request('delete-precedence'));
  await assert.rejects(repository.requestBackupDeletion(scope, 'missing', { confirmed: true, extra: true }), { code: 'RECOVERY_INPUT_INVALID', statusCode: 400 });
  await assert.rejects(repository.requestBackupDeletion(scope, 'missing', { confirmed: false }), { code: 'RECOVERY_CONFIRMATION_REQUIRED', statusCode: 400 });
  await assert.rejects(repository.requestBackupDeletion({ organizationId: 'org_a', actorUserId: 'viewer_a' }, backup.operation.id, []), { code: 'RECOVERY_INPUT_INVALID', statusCode: 400 });
  await assert.rejects(repository.requestBackupDeletion(scope, 'missing', { confirmed: true }), { code: 'RECOVERY_NOT_FOUND', statusCode: 404 });
  await assert.rejects(repository.requestBackupDeletion({ organizationId: 'org_a', actorUserId: 'viewer_a' }, backup.operation.id, { confirmed: true }), { code: 'RECOVERY_FORBIDDEN', statusCode: 403 });
});

test('recovery API core persists the first mutation audit inside the PostgreSQL transaction', async () => {
  // Given a PostgreSQL transaction fake backed by the real fixture, when creating a backup, then its domain rows and audit use the same transaction callback.
  const seed = fixture();
  const writes = [];
  let transactionActive = false;
  const sql = {
    async $transaction(work) {
      transactionActive = true;
      try { return await work(this); }
      finally { transactionActive = false; }
    },
    async $queryRawUnsafe(query) {
      if (query.includes('FROM "Organization"')) return seed.organizations.filter(row => row.id === 'org_a').map(row => ({ row }));
      if (query.includes('FROM "Resource" r WHERE')) return seed.resources.filter(row => row.projectId === 'project_a').map(row => ({ row }));
      if (query.includes('FROM "Project" p WHERE')) return seed.projects.filter(row => row.organizationId === 'org_a').map(row => ({ row }));
      if (query.includes('FROM "Membership"')) return seed.members.filter(row => row.organizationId === 'org_a').map(row => ({ row }));
      return [];
    },
    async $executeRawUnsafe(query, ...values) {
      assert.equal(transactionActive, true);
      writes.push({ query, values });
      return 1;
    },
  };
  const repository = new ResourceRecoveryRepository(new PostgresRecoveryTransaction(sql), () => {});
  const result = await repository.createBackup(request('postgres-audit'));
  const audit = writes.find(row => row.query.includes('INSERT INTO "AuditLog"'));
  assert.ok(audit);
  assert.deepEqual(audit.values.slice(0, 4), ['user_a', 'resource.backup:requested', 'resource-backup', result.operation.id]);
  assert.deepEqual(JSON.parse(audit.values[4]), { engine: 'postgresql', status: 'QUEUED' });
});

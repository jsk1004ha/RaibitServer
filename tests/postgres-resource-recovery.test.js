import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ResourceRecoveryRepository } from '../packages/core/src/resource-recovery.ts';
import { PostgresRecoveryTransaction } from '../packages/core/src/resource-recovery-postgres.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { fixture, request, scope, fence, readyBackup, artifact, commonRecoveryMatrix } from './resource-recovery-fixture.test.js';

test('resource recovery state happy path and resource recovery adversarial matrix on actual owned PostgreSQL', async t => {
  // Given a dedicated UUID database migrated 1..14, when twenty independent clients race, then only one operation/job is committed.
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'owned PostgreSQL URL required');
  const url = new URL(process.env.RAIBITSERVER_TEST_DATABASE_URL);
  assert.match(url.pathname, /^\/recovery_[a-f0-9]{32}$/);
  url.searchParams.set('connection_limit', '1');
  const clients = Array.from({ length: 20 }, () => new PrismaClient({ datasourceUrl: url.href }));
  t.after(() => Promise.all(clients.map(client => client.$disconnect())));
  const sql = clients[0];
  const seed = fixture();
  for (const org of seed.organizations) await sql.organization.create({ data: { id: org.id, name: org.id, slug: org.id.replaceAll('_', '-') } });
  for (const project of seed.projects) await sql.project.create({ data: { ...project, name: project.id, slug: project.id } });
  for (const member of seed.members) {
    await sql.user.create({ data: { id: member.userId, email: `${member.userId}@example.test`, approvalStatus: 'APPROVED' } });
    await sql.membership.create({ data: member });
  }
  for (const resource of seed.resources) await sql.resource.create({ data: resource });
  const repositories = clients.map(client => new ResourceRecoveryRepository(new PostgresRecoveryTransaction(client), () => {}));
  const repository = repositories[0];
  const result = await commonRecoveryMatrix(t, repositories);
  const rows = await sql.$queryRawUnsafe('SELECT b.id,b.status,b."sourceGeneration",j.id AS "jobId",j.status AS "jobStatus" FROM "ResourceBackup" b JOIN "WorkflowJob" j ON j."targetId"=b.id WHERE b.id=$1', result.backupId);
  assert.equal(rows[0].status, 'DELETED');
  assert.equal(rows[0].jobStatus, 'succeeded');
  t.diagnostic(JSON.stringify({ surface: 'actual PostgreSQL transaction/result', clients: 20, lineage: rows }));
  await t.test('actual transaction failure rolls back backup, pin and job atomically', async () => {
    // Given an actual database constraint rejecting the last INSERT, when creating, then all earlier transaction writes roll back.
    const before = await sql.$queryRawUnsafe('SELECT (SELECT count(*) FROM "ResourceBackup")::int AS backups,(SELECT count(*) FROM "ResourceRecoveryPin")::int AS pins,(SELECT count(*) FROM "WorkflowJob")::int AS jobs');
    await sql.$executeRawUnsafe('ALTER TABLE "WorkflowJob" ADD CONSTRAINT recovery_injected_failure CHECK (type<>\'resource.backup\') NOT VALID');
    try { await assert.rejects(repository.createBackup(request('transaction-failure'))); }
    finally { await sql.$executeRawUnsafe('ALTER TABLE "WorkflowJob" DROP CONSTRAINT recovery_injected_failure'); }
    const after = await sql.$queryRawUnsafe('SELECT (SELECT count(*) FROM "ResourceBackup")::int AS backups,(SELECT count(*) FROM "ResourceRecoveryPin")::int AS pins,(SELECT count(*) FROM "WorkflowJob")::int AS jobs');
    assert.deepEqual(after, before);
    const recovered = await repository.createBackup(request('transaction-failure'));
    assert.equal(recovered.operation.status, 'QUEUED');
    t.diagnostic(JSON.stringify({ realConstraintFailure: true, orphanRows: 0, sameKeyRecovered: recovered.operation.id }));
  });
  await t.test('resource project and organization physical deletes are independently restricted', async () => {
    // Given pending artifact pins, when deleting any ancestor directly, then PostgreSQL rejects the cascade.
    for (const [table, id] of [['Resource', 'resource_a'], ['Project', 'project_a'], ['Organization', 'org_a']]) await assert.rejects(sql.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id=$1`, id));
    const control = new PrismaControlPlaneRepository(sql);
    await assert.rejects(control.deleteResource('resource_a'), { code: 'RESOURCE_RECOVERY_PINNED' });
    await assert.rejects(control.deleteProject('project_a'), { code: 'RESOURCE_RECOVERY_PINNED' });
    assert.equal((await sql.resource.findUnique({ where: { id: 'resource_a' } })).status, 'READY');
    assert.equal((await sql.project.findUnique({ where: { id: 'project_a' } })).status, 'ACTIVE');
  });
  await t.test('legacy stored backup projects failed without resolving path or changing stored row', async () => {
    // Given an original CREATED/path/metadata row, when reading, then it is nonrecoverable and stored bytes remain untouched.
    await sql.resourceBackup.create({ data: { id: 'legacy_backup', resourceId: 'resource_a', path: '/private/never-resolve', metadata: { original: true } } });
    const view = await repository.getBackup(scope, 'legacy_backup');
    assert.deepEqual(view, { id: 'legacy_backup', resourceId: 'resource_a', status: 'FAILED', errorCode: 'LEGACY_BACKUP_UNVERIFIED', recoverable: false });
    assert.equal((await sql.resourceBackup.findUnique({ where: { id: 'legacy_backup' } })).status, 'CREATED');
  });
  await t.test('candidate descriptor survives unknown complete and rejects partial or changed metadata', async () => {
    // Given a prepared descriptor before Complete, when the claim is lost, then immutable descriptor and exact cleanup identity remain durable.
    const created = await repository.createBackup(request('candidate'));
    const claim = fence(created.operation.id);
    await repository.claim(claim);
    await repository.mutate(claim, { action: 'intent', keyVersion: 'key1' });
    await repository.mutate(claim, { action: 'upload', uploadId: 'candidate-upload' });
    await assert.rejects(sql.$executeRawUnsafe('UPDATE "ResourceRecoveryAttempt" SET "candidateStoredBytes"=1024 WHERE "backupId"=$1', created.operation.id));
    await repository.mutate(claim, { action: 'candidate', storedBytes: '1024', plaintextBytes: '512', checksum: artifact.checksum });
    await assert.rejects(sql.$executeRawUnsafe('UPDATE "ResourceRecoveryAttempt" SET "candidatePlaintextBytes"=513 WHERE "backupId"=$1', created.operation.id));
    await assert.rejects(sql.$executeRawUnsafe('DELETE FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1', created.operation.id));
    await repository.claim(fence(created.operation.id, 'backup', { workerId: 'worker2', attempt: 2, now: '2026-09-03T00:01:01Z' }));
    const durable = await sql.$queryRawUnsafe('SELECT "objectKey","uploadId",state,"keyVersion","candidateStoredBytes"::text,"candidatePlaintextBytes"::text,"candidateChecksum" FROM "ResourceRecoveryAttempt" WHERE "backupId"=$1', created.operation.id);
    assert.equal(durable[0].state, 'PREPARED');
    assert.equal(durable[0].candidateStoredBytes, '1024');
    assert.equal(durable[0].candidatePlaintextBytes, '512');
    assert.equal(durable[0].candidateChecksum, artifact.checksum);
    assert.equal(durable[0].uploadId, 'candidate-upload');
  });
  await t.test('READY metadata and immutable tenant provenance cannot be changed directly', async () => {
    // Given a verified READY backup, when direct SQL attempts replacement, then physical guards reject it.
    const backup = await repository.createBackup(request('immutable'));
    await readyBackup(repository, backup.operation.id);
    for (const update of ['"artifactChecksum"=repeat(\'c\',64)', '"organizationId"=\'org_b\'', '"sourceGeneration"=\'changed\'', 'status=\'QUEUED\'']) await assert.rejects(sql.$executeRawUnsafe(`UPDATE "ResourceBackup" SET ${update} WHERE id=$1`, backup.operation.id));
    const pending = await repository.createRestore({ ...scope, sourceId: backup.operation.id, body: { requestIdempotencyKey: 'publication', formatVersion: 1, name: 'publication' }, now: '2026-09-03T00:00:00Z' });
    const control = new PrismaControlPlaneRepository(sql);
    await assert.rejects(control.resourceForConsole(await sql.resource.findUnique({ where: { id: pending.operation.targetResourceId } })), { code: 'RECOVERY_TARGET_UNPUBLISHED' });
  });
  await t.test('source readiness engine scope and concurrent lease claims fail closed', async () => {
    // Given server-owned source state, when readiness/engine/ownership is invalid, then no operation is written.
    const source = await sql.resource.findUnique({ where: { id: 'resource_a' } });
    await sql.resource.update({ where: { id: source.id }, data: { status: 'PROVISIONING' } });
    await assert.rejects(repository.createBackup(request('not-ready')), { code: 'SOURCE_NOT_READY' });
    await sql.resource.update({ where: { id: source.id }, data: { status: 'READY', engine: 'sqlite' } });
    await assert.rejects(repository.createBackup(request('unsupported')), { code: 'RECOVERY_ENGINE_UNSUPPORTED' });
    await sql.resource.update({ where: { id: source.id }, data: { engine: 'postgresql' } });
    for (const id of [result.backupId, 'missing']) await assert.rejects(repository.getBackup({ organizationId: 'org_b', actorUserId: 'user_b' }, id), { code: 'RECOVERY_NOT_FOUND', statusCode: 404 });
    const pending = await repository.createBackup(request('claim-race'));
    const claims = await Promise.allSettled(repositories.map((candidate, index) => candidate.claim(fence(pending.operation.id, 'backup', { workerId: `worker${index}` }))));
    assert.equal(claims.filter(claim => claim.status === 'fulfilled').length, 1);
    assert.equal(claims.filter(claim => claim.status === 'rejected' && claim.reason.code === 'RECOVERY_LEASE_BUSY').length, 19);
    const changed = structuredClone(source.desiredState);
    changed.providerImageProvenance.workloadGeneration = 2;
    await sql.resource.update({ where: { id: source.id }, data: { desiredState: changed } });
    const failed = await repository.claim(fence(pending.operation.id, 'backup', { now: '2026-09-03T00:01:01Z' }));
    assert.equal(failed.operation.status, 'FAILED');
    assert.equal(failed.operation.errorCode, 'SOURCE_CHANGED');
    assert.equal(failed.job.status, 'failed');
    await sql.resource.update({ where: { id: source.id }, data: { desiredState: source.desiredState } });
  });
  await t.test('mandatory quota policy rejection leaves no transaction rows', async () => {
    // Given a denied account quota, when requesting new work, then no backup or pin/job survives.
    assert.throws(() => new ResourceRecoveryRepository(new PostgresRecoveryTransaction(sql)), { code: 'RECOVERY_QUOTA_POLICY_REQUIRED' });
    const denied = new ResourceRecoveryRepository(new PostgresRecoveryTransaction(sql), () => { throw new Error('test quota denied'); });
    await assert.rejects(denied.createBackup(request('quota-denied')), /test quota denied/);
    assert.equal(await sql.resourceBackup.count({ where: { requestIdempotencyKey: 'quota-denied' } }), 0);
  });
  await t.test('cleaned backup and successful restore history retire with final physical source deletion', async () => {
    // Given successful restore history and verified artifact cleanup, when finalizing source deletion, then terminal metadata retires without deleting the restored target.
    await sql.resource.create({ data: { ...seed.resources[0], id: 'resource_delete', name: 'delete-source', slug: 'delete-source' } });
    const created = await repository.createBackup({ ...request('retirement'), sourceId: 'resource_delete' });
    await readyBackup(repository, created.operation.id);
    const restore = await repository.createRestore({ ...scope, sourceId: created.operation.id, body: { requestIdempotencyKey: 'retirement', formatVersion: 1, name: 'retained-target' }, now: '2026-09-03T00:00:00Z' });
    await assert.rejects(sql.resource.delete({ where: { id: 'resource_delete' } }));
    const restoreFence = fence(restore.operation.id, 'restore');
    await repository.claim(restoreFence);
    await repository.mutate(restoreFence, { action: 'verify' });
    await repository.mutate(restoreFence, { action: 'ready' });
    const expired = '2026-10-03T00:00:00Z';
    await repository.expireBackup({ organizationId: scope.organizationId, operationId: created.operation.id, now: expired });
    const cleanup = await repository.claimCleanup(fence(created.operation.id, 'backup', { now: expired }));
    await repository.finishCleanup({ ...fence(created.operation.id, 'backup', { now: expired }), token: cleanup.operation.cleanupToken });
    const deleted = await sql.resource.delete({ where: { id: 'resource_delete' } });
    assert.equal(deleted.id, 'resource_delete');
    assert.equal((await sql.resource.findUnique({ where: { id: restore.operation.targetResourceId } })).status, 'READY');
  });
});

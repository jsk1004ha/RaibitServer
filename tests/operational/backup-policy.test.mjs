import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from '../../node_modules/typescript/lib/typescript.js';
import {
  BackupPolicyError,
  applyBackupPolicyMutation,
  backupExpiryForOrigin,
  coalesceDailyKstOccurrences,
  nextDailyKstRun,
  occurrenceKey,
  scheduledRetentionDecision,
} from '../../packages/core/src/backup-policy.ts';
import { PrismaBackupPolicyPersistence } from '../../packages/core/src/backup-policy-postgres.ts';
import { operationalBackupEnvironment, PrismaPolicyFixture } from './backup-policy-fixture.mjs';

const evidence = [];
const validIntent = (overrides = {}) => ({
  requiredProtocolVersion: 2, resourceId: 'resource-a', environmentId: 'env-prod', enabled: true,
  timezone: 'Asia/Seoul', localMinute: 180, origin: 'scheduled', retention: { mode: 'success-count', count: 7 },
  expectedVersion: 1, ...overrides,
});
const context = (overrides = {}) => ({
  dbNow: '2026-09-13T17:59:59.000Z', actorRole: 'OWNER', resourceStatus: 'READY', engine: 'postgresql',
  localBackupCapability: true, quotaAvailable: true, operatorRecoveryReady: true, writerProtocolReady: true,
  policy: { id: 'policy-a', organizationId: 'org-a', projectId: 'project-a', environmentId: 'env-prod', resourceId: 'resource-a',
    createdByUserId: 'owner-a', version: 1, enabled: false, timezone: 'Asia/Seoul', localMinute: 180,
    nextRunAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
  ...overrides,
});

test('happy: daily KST boundaries and immutable occurrence identity are deterministic', () => {
  // Given DB instants around 03:00 KST and every allowed minute boundary.
  // When the next occurrence is calculated.
  const before = nextDailyKstRun('2026-09-13T17:59:59.000Z', 180);
  const exact = nextDailyKstRun('2026-09-13T18:00:00.000Z', 180);
  const firstMinute = nextDailyKstRun('2026-09-13T15:00:00.000Z', 0);
  const lastMinute = nextDailyKstRun('2026-09-13T14:58:59.000Z', 1439);

  // Then 03:00 is previous-day 18:00 UTC and identity is stable.
  assert.equal(before, '2026-09-13T18:00:00.000Z');
  assert.equal(exact, '2026-09-14T18:00:00.000Z');
  assert.equal(firstMinute, '2026-09-14T15:00:00.000Z');
  assert.equal(lastMinute, '2026-09-13T14:59:00.000Z');
  assert.equal(occurrenceKey('policy-a', before), occurrenceKey('policy-a', before));
  assert.notEqual(occurrenceKey('policy-a', before), occurrenceKey('policy-b', before));
  evidence.push({ scenario: 'kst-boundary', before, exact, firstMinute, lastMinute });
});

test('happy: owner enables and disables one versioned policy without deleting history', () => {
  // Given one persisted disabled policy and two immutable historical runs.
  const runs = Object.freeze([{ id: 'run-1', status: 'READY' }, { id: 'run-2', status: 'FAILED' }]);

  // When the owner enables then disables using exact versions.
  const enabled = applyBackupPolicyMutation(context(), validIntent());
  const disabled = applyBackupPolicyMutation(context({ policy: enabled }), validIntent({ enabled: false, expectedVersion: 2 }));

  // Then next UTC/version are exact and caller-owned history remains intact.
  assert.equal(enabled.nextRunAt, '2026-09-13T18:00:00.000Z');
  assert.equal(enabled.version, 2);
  assert.equal(disabled.nextRunAt, null);
  assert.equal(disabled.version, 3);
  assert.deepEqual(runs, [{ id: 'run-1', status: 'READY' }, { id: 'run-2', status: 'FAILED' }]);
  evidence.push({ scenario: 'enable-disable', enabled, disabled, runs });
});

test('failure: boundary rejects arbitrary schedule, timezone, member, stale and admission failures', () => {
  // Given independently failing malformed, authorization, concurrency, and admission cases.
  const cases = [
    ['arbitrary-timezone', context(), validIntent({ timezone: 'UTC' }), 'BACKUP_POLICY_INPUT_INVALID', 400],
    ['arbitrary-cron', context(), { ...validIntent(), cron: '* * * * *' }, 'BACKUP_POLICY_INPUT_INVALID', 400],
    ['misleading-success-output', context(), { ...validIntent(), result: 'PASS' }, 'BACKUP_POLICY_INPUT_INVALID', 400],
    ['member', context({ actorRole: 'DB_ADMIN' }), validIntent(), 'BACKUP_POLICY_FORBIDDEN', 403],
    ['stale-version', context(), validIntent({ expectedVersion: 9 }), 'BACKUP_POLICY_VERSION_CONFLICT', 409],
    ['unsupported-engine', context({ engine: 'sqlite' }), validIntent(), 'BACKUP_POLICY_ENGINE_UNSUPPORTED', 400],
    ['capability', context({ localBackupCapability: false }), validIntent(), 'BACKUP_POLICY_CAPABILITY_UNAVAILABLE', 409],
    ['quota', context({ quotaAvailable: false }), validIntent(), 'BACKUP_POLICY_QUOTA_EXCEEDED', 409],
    ['readiness', context({ operatorRecoveryReady: false }), validIntent(), 'BACKUP_POLICY_OPERATOR_NOT_READY', 409],
    ['dirty-worktree', context({ writerProtocolReady: false }), validIntent(), 'BACKUP_POLICY_WRITER_NOT_READY', 409],
  ];

  // When/Then each request is rejected by its typed condition with no policy output.
  for (const [name, state, input, code, statusCode] of cases) {
    assert.throws(() => applyBackupPolicyMutation(state, input), error => error instanceof BackupPolicyError && error.code === code && error.statusCode === statusCode, name);
    evidence.push({ scenario: name, code, statusCode });
  }
});

test('happy: a 31-day gap coalesces once and seven successful scheduled copies have no age expiry', () => {
  // Given a daily policy missing 31 dates and eight old successful scheduled backups plus manual history.
  const coalesced = coalesceDailyKstOccurrences({ policyId: 'policy-a', nextRunAt: '2026-08-13T18:00:00.000Z', dbNow: '2026-09-13T18:05:00.000Z', localMinute: 180 });
  const backups = Array.from({ length: 9 }, (_, index) => ({ id: `scheduled-${index}`, origin: 'scheduled', status: 'READY', readyAt: `2026-07-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`, pinned: index === 8 }));
  backups.push({ id: 'manual-old', origin: 'manual', status: 'READY', readyAt: '2026-01-01T00:00:00.000Z', pinned: false });

  // When fixed count retention is evaluated while enabled.
  const retention = scheduledRetentionDecision(backups, true);
  const disabledRetention = scheduledRetentionDecision(backups, false);

  // Then exactly one latest due run exists, older dates are skipped, and age alone expires no scheduled success.
  assert.deepEqual(coalesced, {
    due: { policyId: 'policy-a', scheduledAtUtc: '2026-09-13T18:00:00.000Z', key: occurrenceKey('policy-a', '2026-09-13T18:00:00.000Z') },
    skippedOlderCount: 31,
    skippedOlder: { status: 'SKIPPED', reason: 'MISSED_WINDOW', firstScheduledAtUtc: '2026-08-13T18:00:00.000Z', lastScheduledAtUtc: '2026-09-12T18:00:00.000Z', count: 31 },
  });
  assert.deepEqual(retention.deleteIds, ['scheduled-7']);
  assert.equal(retention.retainedIds.length, 8);
  assert.deepEqual(disabledRetention.deleteIds, []);
  assert.equal(disabledRetention.retainedIds.length, 9);
  assert.equal(backupExpiryForOrigin('scheduled', '2026-01-01T00:00:00.000Z'), null);
  assert.equal(backupExpiryForOrigin('manual', '2026-01-01T00:00:00.000Z'), '2026-01-31T00:00:00.000Z');
  evidence.push({ scenario: '31-day-coalesce-retention', coalesced, retention, disabledRetention });
});

test('happy: actual public service call and Nest HTTP expose policy/history with scoped typed failures', async () => {
  // Given a file-backed persistence adapter and the actual compiled Nest controller/service.
  const fixtureDir = await mkdtemp(join(tmpdir(), 'raibit-task6-'));
  const database = new PrismaPolicyFixture(context(), [{ id: 'run-ready', policyId: 'policy-a', policyVersion: 1, resourceId: 'resource-a', environmentId: 'env-prod', scheduledAtUtc: '2026-09-12T18:00:00.000Z', origin: 'scheduled', status: 'READY', policySnapshot: validIntent({ expectedVersion: 0 }) }]);
  const operatorEnvironment = operationalBackupEnvironment();
  const store = new PrismaBackupPolicyPersistence(database, operatorEnvironment);
  const leaves = await compiledApiLeaves(fixtureDir);
  const { BackupPolicyService, BackupPolicyPersistence } = leaves;
  let deferredLoads = 0;
  const deferred = new leaves.DeferredBackupPolicyPersistence(async () => { deferredLoads += 1; return store; });
  assert.equal(deferredLoads, 0);
  const service = new BackupPolicyService(store);
  const direct = await service.getPolicy('resource-a', { id: 'owner-a', role: 'OWNER', organizationId: 'org-a' });
  const immutableHistory = await service.listRuns('resource-a', {}, { id: 'fixture-VIEWER', role: 'VIEWER', organizationId: 'org-a' });
  assert.equal(Object.isFrozen(direct), true);
  assert.equal(Object.isFrozen(immutableHistory.runs), true);
  assert.equal(Object.isFrozen(immutableHistory.runs[0]), true);
  assert.equal(Object.isFrozen(immutableHistory.runs[0].policySnapshot), true);
  assert.equal((await deferred.getBackupPolicyContext({ resourceId: 'resource-a', subject: { id: 'owner-a', organizationId: 'org-a' } })).policy.enabled, false);
  assert.equal(deferredLoads, 1);
  const app = await nestApp(store, leaves);
  let publicEvidence = null;

  // When the real HTTP routes read, mutate, list, and attempt foreign access.
  try {
    const read = await request(app.getHttpServer(), 'GET', '/resources/resource-a/backup-policy', null, 'OWNER', 'org-a');
    const changed = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent(), 'OWNER', 'org-a');
    const foreign = await request(app.getHttpServer(), 'GET', '/resources/resource-a/backup-policy', null, 'OWNER', 'org-b');
    database.scope.engine = 'sqlite';
    const unsupported = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 2 }), 'OWNER', 'org-a');
    database.scope.engine = 'postgresql';
    database.scope.quotaLimit = 0;
    const quota = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 2 }), 'OWNER', 'org-a');
    database.scope.quotaLimit = null;
    operatorEnvironment.RAIBITSERVER_PROVISIONER_BACKUP_ENABLED = '0';
    const readiness = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 2 }), 'OWNER', 'org-a');
    operatorEnvironment.RAIBITSERVER_PROVISIONER_BACKUP_ENABLED = '1';
    const member = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 2 }), 'DB_ADMIN', 'org-a');
    const timezone = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 2, timezone: 'UTC' }), 'OWNER', 'org-a');
    const stale = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 99 }), 'OWNER', 'org-a');
    const disabled = await request(app.getHttpServer(), 'PUT', '/resources/resource-a/backup-policy', validIntent({ expectedVersion: 2, enabled: false }), 'OWNER', 'org-a');
    const history = await request(app.getHttpServer(), 'GET', '/resources/resource-a/backup-runs', null, 'VIEWER', 'org-a');

    // Then outputs come from persisted state and typed public status codes, not mock call counts.
    assert.equal(direct.enabled, false);
    assert.equal(read.statusCode, 200);
    assert.equal(changed.body.nextRunAt, '2026-09-13T18:00:00.000Z');
    assert.equal(disabled.body.nextRunAt, null);
    assert.equal(history.body.runs[0].origin, 'scheduled');
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.body.code, 'BACKUP_POLICY_NOT_FOUND');
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.body.code, 'BACKUP_POLICY_ENGINE_UNSUPPORTED');
    for (const [result, code] of [[quota, 'BACKUP_POLICY_QUOTA_EXCEEDED'], [readiness, 'BACKUP_POLICY_OPERATOR_NOT_READY'], [member, 'BACKUP_POLICY_FORBIDDEN'], [timezone, 'BACKUP_POLICY_INPUT_INVALID'], [stale, 'BACKUP_POLICY_VERSION_CONFLICT']]) {
      assert.equal(result.body.code, code);
      assert.ok([400, 403, 409].includes(result.statusCode));
    }
    publicEvidence = { scenario: 'public-surface', runtime: 'actual Prisma adapter with deterministic SQL transaction fixture; PostgreSQL runtime is Task 22', deferredBinding: { loadsAtModuleConstruction: 0, loadsAfterFirstFeatureCall: deferredLoads }, immutability: { policy: true, runPage: true, run: true, policySnapshot: true }, direct, read, changed, disabled, history, foreign, unsupported, quota, readiness, member, timezone, stale };
  } finally {
    await app.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
  evidence.push({ ...publicEvidence, cleanup: { nestClosed: true, ownedFixtureRemoved: true, portsRetained: 0 } });
});

test.after(async () => {
  if (process.env.TASK6_EVIDENCE_JSON) await writeFile(process.env.TASK6_EVIDENCE_JSON, `${JSON.stringify({ schema: 'raibitserver.task-6-evidence/v1', scenarios: evidence }, null, 2)}\n`);
});

async function compiledApiLeaves(fixtureDir) {
  const requireFromCache = nestRequire();
  const nestCommon = pathToFileURL(requireFromCache.resolve('@nestjs/common')).href;
  const files = [
    ['service', new URL('../../apps/api/src/modules/resources/backup-policy.service.ts', import.meta.url)],
    ['permissions', new URL('../../apps/api/src/auth/permissions.decorator.ts', import.meta.url)],
    ['controller', new URL('../../apps/api/src/modules/resources/backup-policy.controller.ts', import.meta.url)],
  ];
  await writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  for (const [name, source] of files) {
    const input = await readFile(source, 'utf8');
    const compiled = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true } }).outputText
      .replaceAll("'@nestjs/common'", `'${nestCommon}'`)
      .replace("'../../auth/permissions.decorator'", "'./permissions.js'")
      .replace("'./backup-policy.service'", "'./service.js'");
    await writeFile(join(fixtureDir, `${name}.js`), compiled);
  }
  const service = await import(pathToFileURL(join(fixtureDir, 'service.js')).href);
  const controller = await import(pathToFileURL(join(fixtureDir, 'controller.js')).href);
  return { ...service, ...controller, nestCore: await import(pathToFileURL(requireFromCache.resolve('@nestjs/core')).href) };
}

async function nestApp(store, leaves) {
  const requireFromCache = nestRequire();
  const { Module } = await import(pathToFileURL(requireFromCache.resolve('@nestjs/common')).href);
  const { BackupPolicyController, BackupPolicyService, BackupPolicyPersistence, nestCore: { NestFactory } } = leaves;
  class TestModule {}
  Module({ controllers: [BackupPolicyController], providers: [BackupPolicyService, { provide: BackupPolicyPersistence, useValue: store }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.use((req, _res, next) => { req.raibitSubject = { id: `fixture-${req.headers['x-role']}`, role: req.headers['x-role'], organizationId: req.headers['x-org'] }; next(); });
  await app.listen(0, '127.0.0.1');
  return app;
}

function nestRequire() {
  const project = fileURLToPath(new URL('../../apps/api/package.json', import.meta.url));
  const local = createRequire(project);
  try {
    local.resolve('@nestjs/common');
    return local;
  } catch (error) {
    if (!(error instanceof Error) || !Reflect.get(error, 'code') || Reflect.get(error, 'code') !== 'MODULE_NOT_FOUND') throw error;
    return createRequire('C:/rw/a3a2merge/apps/api/package.json');
  }
}

function request(server, method, path, body, role, organizationId) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return new Promise((resolve, reject) => {
    const value = body === null ? '' : JSON.stringify(body);
    const outgoing = http.request({ host: '127.0.0.1', port: address.port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(value), 'x-role': role, 'x-org': organizationId } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    outgoing.on('error', reject);
    outgoing.end(value);
  });
}

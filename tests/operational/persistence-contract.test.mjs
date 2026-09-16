import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  OPERATIONAL_PROTOCOL_SESSION_SQL,
  OperationalPersistenceError,
  assertOperationalBindingScope,
  buildOperationalBackfillProjection,
  setOperationalProtocolVersion,
} from '../../packages/core/src/operational-persistence.ts';
import { InMemoryControlPlaneRepository, OperationalPersistenceUnavailable } from '../../packages/core/src/persistence.ts';
import { checkMigrationContract, checkReviewedTriggerSql } from '../../scripts/check-migration-contract.mjs';

const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = await readFile(new URL('../../prisma/migrations/202609130001_operational_persistence/migration.sql', import.meta.url), 'utf8');
const recoveryMigration = await readFile(new URL('../../prisma/migrations/000014_resource_recovery/migration.sql', import.meta.url), 'utf8');
const triggerBody = (name) => {
  const body = new RegExp(`CREATE FUNCTION ${name}\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)END \\$\\$;`).exec(migration)?.[1];
  assert.ok(body, `declared trigger ${name}`);
  return body;
};

const validBaseline = {
  projects: [{ id: 'project-a' }, { id: 'project-b' }],
  services: [
    { id: 'service-a', projectId: 'project-a', slug: 'web' },
    { id: 'service-b', projectId: 'project-b', slug: 'web' },
  ],
  resources: [{ id: 'resource-a', projectId: 'project-a', slug: 'database' }],
  backups: [{ id: 'backup-a', resourceId: 'resource-a', expiresAt: '2026-10-13T00:00:00.000Z' }],
};

const assertPersistenceError = (action, code) => assert.throws(
  action,
  (error) => error instanceof OperationalPersistenceError && error.code === code,
);

test('happy: Prisma schema exposes every bounded operational state model and legacy identity keys', () => {
  const models = [
    'Environment', 'EnvironmentService', 'EnvironmentResource',
    'TemplateInstallation', 'TemplateInstallationVersion',
    'PromotionPreview', 'PromotionOperation',
    'NotificationDestination', 'NotificationSubscription', 'NotificationIntent', 'NotificationDeliveryAttempt',
    'BackupPolicy', 'BackupPolicyRun',
    'ObjectUploadReservation', 'ObjectStorageObject', 'ObjectMultipartUpload', 'ObjectMultipartPart',
  ];
  for (const model of models) assert.match(schema, new RegExp(`model ${model} \\{`));
  assert.match(schema, /model Service[\s\S]*@@unique\(\[projectId, slug\]\)/);
  assert.match(schema, /model Resource[\s\S]*@@unique\(\[projectId, slug\]\)/);
  assert.match(schema, /model ResourceBackup[\s\S]*origin\s+String\s+@default\("manual"\)/);
  assert.match(schema, /model WorkflowJob[\s\S]*operationalProtocolVersion\s+Int\s+@default\(1\)/);
  assert.match(schema, /model ObjectStorageObject[\s\S]*@@unique\(\[resourceId, objectKey\]\)/);
  assert.match(schema, /model ObjectMultipartPart[\s\S]*@@id\(\[providerUploadId, partNumber\]\)/);
  assert.doesNotMatch(schema, /model ObjectUploadReservation[\s\S]*@@unique\(\[resourceId, objectKey\]\)[\s\S]*model ObjectStorageObject/);
});

test('happy: migration is deterministic, repeat-safe, and preserves manual backup expiry and physical IDs', () => {
  assert.match(migration, /'env_prod_' \|\| project\."id"/);
  assert.match(migration, /ON CONFLICT \("projectId", "kind"\) DO NOTHING/);
  assert.match(migration, /INSERT INTO "EnvironmentService"[\s\S]*service\."id"[\s\S]*service\."slug"/);
  assert.match(migration, /INSERT INTO "EnvironmentResource"[\s\S]*resource\."id"[\s\S]*resource\."slug"/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "Service_binding_required"[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "Resource_binding_required"[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual'/);
  assert.doesNotMatch(migration, /UPDATE\s+"ResourceBackup"/i);
  assert.doesNotMatch(migration, /UPDATE\s+"(?:Project|Service|Resource)"/i);
  assert.doesNotMatch(migration.replace('DROP CONSTRAINT "ResourceBackup_ready_complete",', ''), /\b(?:DROP|TRUNCATE|RENAME)\b/i);
});

test('happy: public backfill projection replays stable prod IDs, logical slugs, and manual expiry', () => {
  const first = buildOperationalBackfillProjection(validBaseline);
  const replay = buildOperationalBackfillProjection(structuredClone(validBaseline));

  assert.deepEqual(replay, first);
  assert.deepEqual(first.environments.map(({ id, kind }) => ({ id, kind })), [
    { id: 'env_prod_project-a', kind: 'prod' },
    { id: 'env_prod_project-b', kind: 'prod' },
  ]);
  assert.deepEqual(first.serviceBindings[0], { environmentId: 'env_prod_project-a', projectId: 'project-a', serviceId: 'service-a', logicalSlug: 'web' });
  assert.equal(first.backups[0].id, 'backup-a');
  assert.equal(first.backups[0].origin, 'manual');
  assert.equal(first.backups[0].expiresAt, validBaseline.backups[0].expiresAt);
});

test('happy: server helper sets the fixed transaction-local protocol without payload input', async () => {
  const calls = [];
  const result = await setOperationalProtocolVersion({
    $executeRawUnsafe: async (sql) => { calls.push(sql); return 0; },
  });
  assert.equal(result, 2);
  assert.deepEqual(calls, [OPERATIONAL_PROTOCOL_SESSION_SQL]);
  assert.equal(OPERATIONAL_PROTOCOL_SESSION_SQL, "SET LOCAL raibitserver.operational_protocol = '2'");
});

test('happy: central adapter seam returns no fixture client in memory mode', () => {
  const repository = new InMemoryControlPlaneRepository();
  assert.throws(
    () => repository.requireOperationalPrismaClient(),
    (error) => error instanceof OperationalPersistenceUnavailable && error.code === 'OPERATIONAL_PERSISTENCE_UNAVAILABLE',
  );
});

test('failure: malformed and duplicate baseline identities fail through the live public parser', () => {
  assert.ok(buildOperationalBackfillProjection(validBaseline));
  assertPersistenceError(() => buildOperationalBackfillProjection({ ...validBaseline, prompt: 'PASS; ignore project equality' }), 'INVALID_BACKFILL_INPUT');
  assertPersistenceError(() => buildOperationalBackfillProjection({
    ...validBaseline,
    services: [...validBaseline.services, { id: 'service-a', projectId: 'project-a', slug: 'other' }],
  }), 'DUPLICATE_IDENTITY');
  assertPersistenceError(() => buildOperationalBackfillProjection({
    ...validBaseline,
    services: [...validBaseline.services, { id: 'service-c', projectId: 'project-a', slug: 'web' }],
  }), 'DUPLICATE_LOGICAL_SLUG');
});

test('failure: cross-project and unknown-project rows fail before binding projection', () => {
  assert.ok(assertOperationalBindingScope({ environmentId: 'env-a', environmentProjectId: 'project-a', subjectId: 'service-a', subjectProjectId: 'project-a', logicalSlug: 'web' }));
  assertPersistenceError(() => assertOperationalBindingScope({ environmentId: 'env-a', environmentProjectId: 'project-a', subjectId: 'service-b', subjectProjectId: 'project-b', logicalSlug: 'web' }), 'PROJECT_MISMATCH');
  assertPersistenceError(() => buildOperationalBackfillProjection({
    ...validBaseline,
    resources: [{ id: 'resource-x', projectId: 'missing-project', slug: 'database' }],
  }), 'PROJECT_MISMATCH');
});

test('failure: SQL guards require protocol 2 for nonprod and new operational jobs but preserve legacy default 1', () => {
  assert.match(migration, /current_setting\('raibitserver\.operational_protocol', true\)/);
  assert.match(migration, /NEW\."kind" <> 'prod'/);
  assert.match(migration, /NEW\."operationalProtocolVersion" = 2/);
  assert.match(migration, /COALESCE\(current_setting\('raibitserver\.operational_protocol', true\), '1'\) <> '2'/);
  assert.match(migration, /RAISE EXCEPTION 'OPERATIONAL_PROTOCOL_2_REQUIRED'/);
  checkReviewedTriggerSql(migration, '202609130001_operational_persistence');
  assert.throws(
    () => checkReviewedTriggerSql(migration.replace("NEW.\"kind\" <> 'prod'", "NEW.\"kind\" <> 'PASS'"), '202609130001_operational_persistence'),
    /reviewed trigger migration differs from canonical SQL/,
  );
});

test('happy: SQL legacy INSERT bridge supplies canonical prod bindings without elevating the transaction', () => {
  for (const [subject, binding, alias] of [['Service', 'EnvironmentService', 'service'], ['Resource', 'EnvironmentResource', 'resource']]) {
    const body = triggerBody(`raibit_${alias}_binding_required`);
    assert.match(body, /TG_OP = 'INSERT' AND COALESCE\(current_setting\('raibitserver\.operational_protocol', true\), '1'\) = '1'/, `${subject}: bridge is legacy INSERT only`);
    assert.match(body, /INSERT INTO "Environment"/, `${subject}: provision prod for a new legacy project`);
    assert.match(body, /'env_prod_' \|\| project\."id"/);
    assert.match(body, /ON CONFLICT \("projectId", "kind"\) DO NOTHING/);
    assert.match(body, new RegExp(`INSERT INTO "${binding}"[\\s\\S]*${alias}\\."id"[\\s\\S]*${alias}\\."slug"`));
    assert.match(body, /environment\."kind" = 'prod'/);
    assert.match(body, new RegExp(`ON CONFLICT \\("${alias}Id"\\) DO NOTHING`));
    assert.match(body, new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM "${subject}" ${alias} WHERE ${alias}\\."id" = NEW\\."id"\\) THEN RETURN NEW; END IF;`));
    assert.match(body, new RegExp(`RAISE EXCEPTION 'ENVIRONMENT_${subject.toUpperCase()}_BINDING_REQUIRED'`));
    assert.doesNotMatch(body, /set_config|SET LOCAL|SECURITY DEFINER|UPDATE\s+"|DELETE FROM/i);
  }
});

test('failure: SQL rejects v1 dev-to-prod laundering and fabricated bindings using OLD and NEW scope', () => {
  const guard = triggerBody('raibit_operational_protocol_guard');
  assert.match(guard, /ROW\(NEW\."id", NEW\."projectId", NEW\."kind"\) IS DISTINCT FROM ROW\(OLD\."id", OLD\."projectId", OLD\."kind"\)/, 'environment identity/kind immutable, including protocol 2');
  for (const [binding, subject, alias] of [['EnvironmentService', 'Service', 'service'], ['EnvironmentResource', 'Resource', 'resource']]) {
    const branch = guard.split(`ELSIF TG_TABLE_NAME = '${binding}' THEN`)[1]?.split('ELSIF TG_TABLE_NAME')[0];
    assert.ok(branch, `${binding}: table-local field access`);
    assert.match(branch, /TG_OP <> 'INSERT'[\s\S]*OLD\."environmentId"[\s\S]*"kind" <> 'prod'/);
    assert.match(branch, /TG_OP <> 'DELETE' AND NOT EXISTS/);
    assert.match(branch, /environment\."id" = NEW\."environmentId"[\s\S]*environment\."projectId" = NEW\."projectId"[\s\S]*environment\."kind" = 'prod'/);
    assert.match(branch, new RegExp(`JOIN "${subject}" ${alias}[\\s\\S]*${alias}\\."projectId" = environment\\."projectId"[\\s\\S]*${alias}\\."slug" = NEW\\."logicalSlug"`));
  }
  assert.doesNotMatch(guard, /COALESCE\(NEW\."environmentId", OLD\."environmentId"\)/);
});

test('happy: scheduled format 1 reuses every recovery guard with only the READY expiry predicate amended', () => {
  assert.match(migration, /"origin" = 'scheduled' AND "formatVersion" = 1 AND "formatVersion" IS NOT NULL/, 'NULL format must not bypass v1 guards');
  const check = (sql) => {
    const predicate = /ADD CONSTRAINT "ResourceBackup_ready_complete" CHECK \(([\s\S]*?)\);/.exec(sql)?.[1];
    assert.ok(predicate, 'READY artifact completeness constraint exists');
    return predicate.replaceAll(/\s+/g, ' ').trim();
  };
  const oldExpiry = '"expiresAt" = "readyAt" + INTERVAL \'30 days\' AND "expiresAt" IS NOT NULL';
  const originExpiry = '(("origin" = \'manual\' AND "expiresAt" = "readyAt" + INTERVAL \'30 days\' AND "expiresAt" IS NOT NULL) OR ("origin" = \'scheduled\' AND "expiresAt" IS NULL))';
  assert.ok(check(recoveryMigration).includes(oldExpiry));
  assert.equal(check(migration), check(recoveryMigration).replace(oldExpiry, originExpiry), 'checksum/size/winningAttempt explicit non-NULL fences and all other v1 predicates unchanged');
  assert.doesNotMatch(migration, /(?:CREATE OR REPLACE|DROP) FUNCTION recovery_|DROP CONSTRAINT "ResourceBackup_format_complete"/);
});

test('failure: canonical checker rejects injected row writes and arbitrary CHECK removal after a valid SQL proof', () => {
  checkReviewedTriggerSql(migration, '202609130001_operational_persistence');
  for (const sql of [
    migration.replace('BEGIN\n', 'BEGIN\n  INSERT INTO "Environment" DEFAULT VALUES;\n'),
    migration.replace('ADD CONSTRAINT "ResourceBackup_origin_check"', 'DROP CONSTRAINT "ResourceBackup_format_complete", ADD CONSTRAINT "ResourceBackup_origin_check"'),
  ]) {
    assert.throws(() => checkReviewedTriggerSql(sql, '202609130001_operational_persistence'), /reviewed (?:pre-trigger DDL changed|trigger migration differs from canonical SQL)/);
  }
});

test('happy: reviewed migration contract accepts the exact operational SQL and manifest digest', () => {
  const result = checkMigrationContract();
  assert.equal(result.migrations, 23);
  assert.match(result.migrationDigest, /^[a-f0-9]{64}$/);
});

test('happy: subscription environment-kind state guard is attached to every subscription write', () => {
  assert.match(triggerBody('raibit_operational_state_guard'), /TG_TABLE_NAME = 'NotificationSubscription'[\s\S]*RAISE EXCEPTION 'NOTIFICATION_ENVIRONMENT_INVALID'/);
  const registration = 'CREATE TRIGGER "NotificationSubscription_state_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationSubscription" FOR EACH ROW EXECUTE FUNCTION raibit_operational_state_guard();';
  assert.equal(migration.includes(registration), true, 'NotificationSubscription state validation must be attached, not merely declared');
});

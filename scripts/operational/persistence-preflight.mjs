import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const BASELINE = 'b0e48beadc0e95427aceed7aa3436bb56ae938d1';
const MIGRATION_SHA256 = '3f0aba94669d906664b6b734d47d02d946a0960ba69e5501945bf6a5b17df817';
const MIGRATIONS = [
  ['202609130001_operational_persistence', MIGRATION_SHA256],
  ['202609130002_runtime_environment_protocol', 'eebc11a218f527416688b643f4ab630a9adb90a07fb4362e3467873f8967e191'],
  ['202609130003_operational_state_dispatch', '72001f2d48c4d4890057a258408facd8fb14cc058c61e9a70e2b02dd7b56681c'],
];
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const evidenceDir = process.env.RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR;
const results = [];
const materialization = [];
const dispatch = [];
let postgresVersion = 'unavailable';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(name, observable) {
  results.push({ name, observable, status: 'passed' });
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function materializeBaseline(directory) {
  const paths = git('ls-tree', '-r', '--name-only', BASELINE, 'prisma')
    .trim().split('\n').filter((path) => path === 'prisma/schema.prisma' || path.endsWith('/migration.sql'));
  const ledger = [];
  for (const path of paths) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, git('show', `${BASELINE}:${path}`));
    if (path.endsWith('/migration.sql')) ledger.push({ name: path.split('/')[2], checksum: sha256(readFileSync(destination)) });
  }
  return ledger;
}

function migrate(schemaPath, databaseUrl) {
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', schemaPath], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: 'true' },
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error instanceof Error) {
      const password = new URL(databaseUrl).password;
      const diagnostic = [error.message, error.stdout, error.stderr]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('\n')
        .replaceAll(databaseUrl, 'postgresql://[redacted]')
        .replaceAll(password, '[redacted-password]')
        .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gu, 'postgresql://[redacted]@')
        .slice(-4_000);
      throw new Error(`Prisma migrate deploy failed with sanitized diagnostics:\n${diagnostic}`);
    }
    throw error;
  }
}

const fixtureSections = new Map(readFileSync(join(root, 'tests/operational/fixtures/postgres-persistence-baseline.sql'), 'utf8')
  .split(/^-- preflight: /mu).slice(1).map((section) => {
    const boundary = section.indexOf('\n');
    return [section.slice(0, boundary).trim(), section.slice(boundary + 1).split(/;\s*(?:\r?\n|$)/u).map((sql) => sql.trim()).filter(Boolean)];
  }));

async function executeFixture(client, section) {
  const statements = fixtureSections.get(section);
  assert.ok(statements?.length, `fixture section ${section} must be nonempty`);
  for (const sql of statements) assert.ok(await client.$executeRawUnsafe(sql) > 0, `fixture ${section} must affect rows`);
}

async function protocol2(client, work) {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
    return work(transaction);
  }, { timeout: 30_000 });
}

const DESTINATION_SQL = `INSERT INTO "NotificationDestination" ("id","projectId","kind","sealedWebhookUrl","encryptionKeyVersion","updatedAt") VALUES ('destination_main','project_existing','discord','sealed:test','key-v1',TIMESTAMP '2031-01-01 18:00:00')`;

async function guardDefinition(client) {
  const rows = await client.$queryRawUnsafe("SELECT pg_get_functiondef('public.raibit_operational_state_guard()'::regprocedure) AS definition");
  return rows[0].definition;
}

async function destinationProbe(client, options) {
  const rollback = new Error('owned destination probe rollback');
  let observation;
  try {
    await protocol2(client, async (transaction) => {
      if (options.revert) await transaction.$executeRawUnsafe(options.revert);
      const columns = await transaction.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='NotificationDestination' ORDER BY ordinal_position`);
      assert.ok(!columns.some((row) => row.column_name === 'environmentId'));
      const triggers = await transaction.$queryRawUnsafe(`SELECT tgname AS name,tgenabled::text AS enabled,tgfoid::regproc::text AS function FROM pg_trigger WHERE tgrelid='"NotificationDestination"'::regclass AND NOT tgisinternal ORDER BY tgname`);
      assert.ok(triggers.some((row) => row.function === 'raibit_operational_state_guard' && row.enabled === 'O'));
      assert.ok(triggers.some((row) => row.function === 'raibit_operational_protocol_guard' && row.enabled === 'O'));
      const [session] = await transaction.$queryRawUnsafe("SELECT current_user::text AS role,current_setting('raibitserver.operational_protocol') AS protocol");
      assert.deepEqual(session, { role: options.role, protocol: '2' });
      const functionSha256 = sha256(await guardDefinition(transaction));
      await transaction.$executeRawUnsafe('CREATE TEMP TABLE preflight_dispatch_result (state text,message text,context text) ON COMMIT DROP');
      // Capture PostgreSQL's exception context, which Prisma's raw-query error omits.
      await transaction.$executeRawUnsafe(`DO $probe$ DECLARE code text; detail text; trace text; BEGIN
        ${DESTINATION_SQL};
        INSERT INTO preflight_dispatch_result VALUES ('00000',NULL,NULL);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS code = RETURNED_SQLSTATE, detail = MESSAGE_TEXT, trace = PG_EXCEPTION_CONTEXT;
        INSERT INTO preflight_dispatch_result VALUES (code,detail,trace);
      END $probe$`);
      const [native] = await transaction.$queryRawUnsafe('SELECT state,message,context FROM preflight_dispatch_result');
      observation = { phase: options.phase, inputSql: DESTINATION_SQL, inputSha256: sha256(DESTINATION_SQL), columns, triggers, session, functionSha256, native };
      dispatch.push(observation);
      assert.equal(native.state, options.red ? '42703' : '00000', JSON.stringify(native));
      const rows = await transaction.$queryRawUnsafe(`SELECT "id","projectId","kind","sealedWebhookUrl","encryptionKeyVersion","updatedAt","version" FROM "NotificationDestination" WHERE "id"='destination_main'`);
      if (options.red) {
        assert.equal(native.message, 'record "new" has no field "environmentId"');
        assert.match(native.context, /PL\/pgSQL function (?:public\.)?raibit_operational_state_guard\(\)/u);
        assert.deepEqual(rows, []);
      } else {
        assert.deepEqual(rows, [{ id: 'destination_main', projectId: 'project_existing', kind: 'discord', sealedWebhookUrl: 'sealed:test', encryptionKeyVersion: 'key-v1', updatedAt: new Date('2031-01-01T18:00:00.000Z'), version: 1 }]);
        observation.row = rows[0];
      }
      if (!options.commit) throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  observation.transaction = options.commit ? 'committed' : 'rolled-back';
  record(`destination toggle ${options.phase}`, options.red ? '42703/environmentId/state_guard' : 'inserted-row');
}

async function expectRejected(client, scenario) {
  await assert.rejects(
    client.$transaction(async (transaction) => {
      if (scenario.protocol === 2) await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
      const statements = Array.isArray(scenario.sql) ? scenario.sql : [scenario.sql];
      for (const sql of statements) await transaction.$executeRawUnsafe(sql);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }, { timeout: 30_000 }),
    scenario.error,
  );
  record(scenario.name, `rejected:${scenario.error.source}`);
}

const snapshot = '{"requiredProtocolVersion":2,"enabled":true,"timezone":"Asia/Seoul","origin":"scheduled","retention":{"mode":"success-count","count":7}}';
const generation = 'resource-incarnation/v1:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

async function insertScheduled(client, id, readyValues) {
  await protocol2(client, async (transaction) => {
    await transaction.$executeRawUnsafe(`INSERT INTO "BackupPolicyRun" ("id","policyId","organizationId","projectId","environmentId","resourceId","scheduledAtUtc","policyVersion","policySnapshot","updatedAt") VALUES ('run_${id}','policy_main','org_preflight','project_existing','env_prod_project_existing','resource_existing',TIMESTAMP '2031-01-0${id} 18:00:00',1,'${snapshot}'::jsonb,CURRENT_TIMESTAMP)`);
    await transaction.$executeRawUnsafe(`INSERT INTO "ResourceBackup" ("id","resourceId","status","createdAt","formatVersion","organizationId","projectId","engine","provider","sourceGeneration","sourceProvenance","sourceSpec","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt","origin","policyId","policyRunId","policyVersion","scheduledAtUtc","policySnapshot","environmentId"${readyValues ? ',"artifactKey","artifactChecksum","artifactSize","encryptionKeyVersion","winningAttempt","readyAt","expiresAt"' : ''}) VALUES ('scheduled_${id}','resource_existing','${readyValues ? 'READY' : 'QUEUED'}',CURRENT_TIMESTAMP,1,'org_preflight','project_existing','postgres','local','${generation}','{"source":"scheduled"}'::jsonb,'{"engine":"postgres"}'::jsonb,'user_preflight','scheduled-${id}','fingerprint-${id}',CURRENT_TIMESTAMP,'scheduled','policy_main','run_${id}',1,TIMESTAMP '2031-01-0${id} 18:00:00','${snapshot}'::jsonb,'env_prod_project_existing'${readyValues ? `,${readyValues}` : ''})`);
  });
}

test('current operational migration passes the focused real PostgreSQL compatibility gate', { timeout: 420_000 }, async (t) => {
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'RAIBITSERVER_TEST_DATABASE_URL is required; refusing a skipped green');
  assert.ok(evidenceDir, 'RAIBITSERVER_OPERATIONAL_EVIDENCE_DIR is required');
  const { PrismaClient } = await import('@prisma/client');
  const suffix = randomUUID().replaceAll('-', '');
  const role = `raibit_preflight_${suffix}`;
  const database = `raibit_preflight_${suffix}`;
  const password = randomBytes(24).toString('base64url');
  const adminUrl = new URL(process.env.RAIBITSERVER_TEST_DATABASE_URL);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  databaseUrl.username = role;
  databaseUrl.password = password;
  databaseUrl.searchParams.set('connection_limit', '1');
  mkdirSync(evidenceDir, { recursive: true });
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'raibit-postgres-preflight-'));
  const admin = new PrismaClient({ datasourceUrl: adminUrl.href });
  let client;
  const failures = [];

  try {
    const frozen = MIGRATIONS.map(([name, checksum]) => {
      const sql = readFileSync(join(root, 'prisma/migrations', name, 'migration.sql'));
      assert.equal(sha256(sql), checksum, `${name} must match its owner's final freeze`);
      return { name, checksum, sql };
    });
    record('Task2 SQL freeze', `immutable 001 SHA-256 matched ${MIGRATION_SHA256}`);
    record('migration owner freezes', MIGRATIONS);
    await admin.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}" OWNER "${role}"`);
    const owner = await admin.$queryRawUnsafe(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = '${database}'`);
    assert.equal(owner[0]?.owner, role);
    record('ephemeral database ownership', 'generated database owner matched generated login');

    const ledger = materializeBaseline(fixtureRoot);
    const schemaPath = join(fixtureRoot, 'prisma/schema.prisma');
    let historicalGuard;
    for (const migration of [null, ...frozen]) {
      if (migration) {
        const path = join(fixtureRoot, 'prisma/migrations', migration.name, 'migration.sql');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, migration.sql);
        ledger.push({ name: migration.name, checksum: migration.checksum });
      }
      migrate(schemaPath, databaseUrl.href);
      client = new PrismaClient({ datasourceUrl: databaseUrl.href });
      const applied = await client.$queryRawUnsafe(`SELECT migration_name AS name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
      assert.deepEqual(applied, ledger);
      materialization.push({ phase: migration?.name ?? BASELINE, applied });
      if (!migration) {
        await executeFixture(client, 'baseline');
        const version = await client.$queryRawUnsafe('SHOW server_version');
        postgresVersion = version[0]?.server_version ?? 'unavailable';
        assert.match(postgresVersion, /^16\./u);
        record('PostgreSQL runtime', `server_version=${postgresVersion}`);
      } else if (migration.name === MIGRATIONS[0][0]) {
        historicalGuard = await guardDefinition(client);
      } else if (migration.name === MIGRATIONS[1][0]) {
        assert.equal(await guardDefinition(client), historicalGuard, '002 must retain the exact loaded historical state guard');
        await destinationProbe(client, { phase: 'old-before-003', role, red: true });
      } else {
        const correctedGuard = await guardDefinition(client);
        assert.notEqual(correctedGuard, historicalGuard);
        await destinationProbe(client, { phase: 'new-after-003', role });
        await destinationProbe(client, { phase: 'old-reverted', role, red: true, revert: historicalGuard });
        assert.equal(await guardDefinition(client), correctedGuard, 'rollback must restore the migrated003 guard');
        await destinationProbe(client, { phase: 'new-restored', role, commit: true });
        assert.equal(await guardDefinition(client), correctedGuard, 'final production fix must remain active');
        assert.deepEqual(dispatch.map(({ native }) => native.state), ['42703', '00000', '42703', '00000']);
        for (const probe of dispatch) {
          for (const key of ['inputSql', 'inputSha256', 'columns', 'triggers', 'session']) assert.deepEqual(probe[key], dispatch[0][key]);
        }
        assert.equal(dispatch[0].functionSha256, dispatch[2].functionSha256);
        assert.equal(dispatch[1].functionSha256, dispatch[3].functionSha256);
        break;
      }
      await client.$disconnect();
      client = undefined;
    }
    record('baseline upgrade', `exact ${BASELINE} migration tree, then independently materialized001/002/003 with native ledger/checksums`);

    const preserved = await client.$queryRawUnsafe(`SELECT s."id" AS service_id,s."slug" AS service_slug,r."id" AS resource_id,r."slug" AS resource_slug,b."origin" AS legacy_origin,b."expiresAt" AS legacy_expiry,m."origin" AS manual_origin,m."expiresAt" AS manual_expiry FROM "Service" s JOIN "Resource" r ON r."id"='resource_existing' JOIN "ResourceBackup" b ON b."id"='backup_legacy_manual' JOIN "ResourceBackup" m ON m."id"='backup_v1_manual' WHERE s."id"='service_existing'`);
    assert.deepEqual([preserved[0].service_id, preserved[0].service_slug, preserved[0].resource_id, preserved[0].resource_slug], ['service_existing', 'existing-api', 'resource_existing', 'existing-db']);
    assert.deepEqual([preserved[0].legacy_origin, preserved[0].manual_origin], ['manual', 'manual']);
    assert.equal(preserved[0].legacy_expiry.toISOString(), '2040-01-02T03:04:05.000Z');
    assert.equal(preserved[0].manual_expiry.toISOString(), '2030-01-31T00:00:00.000Z');
    record('production preservation', 'existing IDs, physical slugs, and both legacy/manual expiries remained byte-equivalent');

    await client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '1'");
      await transaction.$executeRawUnsafe(`INSERT INTO "Project" ("id","organizationId","name","slug","createdAt","updatedAt") VALUES ('project_n1','org_preflight','N-1','n-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","createdAt","updatedAt") VALUES ('service_n1','project_n1','N-1 API','n1-api','web','image',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "Resource" ("id","projectId","name","slug","type","engine","provider","plan","region","createdAt","updatedAt") VALUES ('resource_n1','project_n1','N-1 DB','n1-db','database','postgres','local','starter','local',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });
    const bindings = await client.$queryRawUnsafe(`SELECT e."id",e."kind",s."logicalSlug" AS service_slug,r."logicalSlug" AS resource_slug FROM "Environment" e JOIN "EnvironmentService" s ON s."environmentId"=e."id" JOIN "EnvironmentResource" r ON r."environmentId"=e."id" WHERE e."projectId"='project_n1'`);
    assert.deepEqual(bindings, [{ id: 'env_prod_project_n1', kind: 'prod', service_slug: 'n1-api', resource_slug: 'n1-db' }]);
    await client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '1'");
      assert.equal(await transaction.$executeRawUnsafe(`UPDATE "Project" SET "name"='N-1 updated' WHERE "id"='project_n1'`), 1);
      await transaction.$executeRawUnsafe(`UPDATE "Service" SET "status"='READY' WHERE "id"='service_n1'`);
      await transaction.$executeRawUnsafe(`UPDATE "Resource" SET "status"='READY' WHERE "id"='resource_n1'`);
      await transaction.$executeRawUnsafe(`DELETE FROM "Service" WHERE "id"='service_n1'`);
      await transaction.$executeRawUnsafe(`DELETE FROM "Resource" WHERE "id"='resource_n1'`);
      assert.equal(await transaction.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id"='project_n1'`), 1);
    });
    record('N-1 protocol-1 writes while OFF', 'fresh project/service/resource create, update, and delete committed with exact prod bindings');

    await expectRejected(client, { name: 'cross-project binding', protocol: 2, sql: [
      `INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","createdAt","updatedAt") VALUES ('service_cross','project_existing','Cross API','cross-api','web','image',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      `INSERT INTO "EnvironmentService" ("serviceId","environmentId","projectId","logicalSlug","createdAt","updatedAt") VALUES ('service_cross','env_prod_project_other','project_other','cross-api',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ], error: /foreign key/i });
    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "Environment" ("id","projectId","kind","createdAt","updatedAt") VALUES ('env_dev_project_existing','project_existing','dev',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "Service" ("id","projectId","name","slug","type","sourceType","createdAt","updatedAt") VALUES ('service_dev','project_existing','Dev API','dev-api','web','image',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe(`INSERT INTO "EnvironmentService" ("serviceId","environmentId","projectId","logicalSlug","createdAt","updatedAt") VALUES ('service_dev','env_dev_project_existing','project_existing','api',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });
    await expectRejected(client, { name: 'protocol-1 dev write', sql: `UPDATE "Service" SET "status"='READY' WHERE "id"='service_dev'`, error: /OPERATIONAL_PROTOCOL_2_REQUIRED/ });
    await expectRejected(client, { name: 'protocol-1 operational job', sql: `INSERT INTO "WorkflowJob" ("id","type","targetType","targetId","payload","createdAt","updatedAt") VALUES ('job_v1','operational.backup','resource','resource_existing','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, error: /OPERATIONAL_PROTOCOL_2_REQUIRED/ });

    await expectRejected(client, { name: 'destination row-shape dispatch', protocol: 2, sql: `UPDATE "NotificationDestination" SET "sealedWebhookUrl"='sealed:changed' WHERE "id"='destination_main'`, error: /NOTIFICATION_DESTINATION_VERSION_INVALID/ });
    await protocol2(client, async (transaction) => {
      assert.equal(await transaction.$executeRawUnsafe(`UPDATE "NotificationDestination" SET "sealedWebhookUrl"='sealed:changed',"version"=2 WHERE "id"='destination_main'`), 1);
      assert.equal(await transaction.$executeRawUnsafe(`INSERT INTO "NotificationSubscription" ("id","projectId","destinationId","environmentId","environmentKind","eventCode","updatedAt") VALUES ('subscription_valid','project_existing','destination_main','env_prod_project_existing','prod','backup.failed',CURRENT_TIMESTAMP)`), 1);
      assert.equal(await transaction.$executeRawUnsafe(`DELETE FROM "NotificationSubscription" WHERE "id"='subscription_valid'`), 1);
    });
    record('destination rotation and valid subscription dispatch', 'version+1 update and prod subscription insert/delete committed');
    await expectRejected(client, { name: 'subscription row-shape dispatch', protocol: 2, sql: `INSERT INTO "NotificationSubscription" ("id","projectId","destinationId","environmentId","environmentKind","eventCode","updatedAt") VALUES ('subscription_bad','project_existing','destination_main','env_prod_project_existing','dev','backup.failed',CURRENT_TIMESTAMP)`, error: /NOTIFICATION_ENVIRONMENT_INVALID/ });

    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "BackupPolicy" ("id","organizationId","projectId","environmentId","resourceId","createdByUserId","updatedAt") VALUES ('policy_main','org_preflight','project_existing','env_prod_project_existing','resource_existing','user_preflight',CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'scheduled NULL format', protocol: 2, sql: [
      `INSERT INTO "BackupPolicyRun" ("id","policyId","organizationId","projectId","environmentId","resourceId","scheduledAtUtc","policyVersion","policySnapshot","updatedAt") VALUES ('run_null_format','policy_main','org_preflight','project_existing','env_prod_project_existing','resource_existing',TIMESTAMP '2031-01-09 18:00:00',1,'${snapshot}'::jsonb,CURRENT_TIMESTAMP)`,
      `INSERT INTO "ResourceBackup" ("id","resourceId","status","createdAt","organizationId","projectId","engine","provider","sourceGeneration","sourceProvenance","sourceSpec","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt","origin","policyId","policyRunId","policyVersion","scheduledAtUtc","policySnapshot","environmentId") VALUES ('scheduled_null_format','resource_existing','QUEUED',CURRENT_TIMESTAMP,'org_preflight','project_existing','postgres','local','${generation}','{}','{}','user_preflight','null-format','fingerprint',CURRENT_TIMESTAMP,'scheduled','policy_main','run_null_format',1,TIMESTAMP '2031-01-09 18:00:00','${snapshot}'::jsonb,'env_prod_project_existing')`,
    ], error: /ResourceBackup_scheduled_policy_check/ });
    await insertScheduled(client, '1', null);
    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`UPDATE "ResourceBackup" SET "status"='RUNNING',"startedAt"=TIMESTAMP '2031-01-01 18:01:00' WHERE "id"='scheduled_1'`);
      await transaction.$executeRawUnsafe(`UPDATE "ResourceBackup" SET "status"='VERIFYING' WHERE "id"='scheduled_1'`);
      await transaction.$executeRawUnsafe(`UPDATE "ResourceBackup" SET "status"='READY',"artifactKey"='scheduled/artifact.v1',"artifactChecksum"='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',"artifactSize"=256,"encryptionKeyVersion"='key-v1',"winningAttempt"=1,"readyAt"=TIMESTAMP '2031-01-01 18:05:00' WHERE "id"='scheduled_1'`);
    });
    const scheduled = await client.$queryRawUnsafe(`SELECT "formatVersion","expiresAt","sourceProvenance","artifactKey" FROM "ResourceBackup" WHERE "id"='scheduled_1'`);
    assert.equal(scheduled[0].formatVersion, 1);
    assert.equal(scheduled[0].expiresAt, null);
    assert.deepEqual(scheduled[0].sourceProvenance, { source: 'scheduled' });
    assert.equal(scheduled[0].artifactKey, 'scheduled/artifact.v1');
    record('scheduled format-1 lifecycle', 'QUEUED→RUNNING→VERIFYING→READY retained provenance/artifact and no age expiry');

    await insertScheduled(client, '2', `'bad/artifact',NULL,1,'key-v1',1,TIMESTAMP '2031-01-02 18:05:00',NULL`).then(() => assert.fail('NULL READY checksum accepted'), (error) => assert.match(String(error), /ResourceBackup_ready_complete/));
    record('malformed NULL READY artifact', 'native READY completeness constraint rejected NULL checksum');
    await expectRejected(client, { name: 'scheduled provenance guard', protocol: 2, sql: `UPDATE "ResourceBackup" SET "sourceProvenance"='{"changed":true}' WHERE "id"='scheduled_1'`, error: /RECOVERY_PROVENANCE_IMMUTABLE/ });
    await expectRejected(client, { name: 'scheduled artifact guard', protocol: 2, sql: `UPDATE "ResourceBackup" SET "artifactKey"='changed' WHERE "id"='scheduled_1'`, error: /RECOVERY_ARTIFACT_IMMUTABLE/ });
    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "ResourceRecoveryPin" ("id","resourceId","backupId","kind") VALUES ('pin_scheduled','resource_existing','scheduled_1','ARTIFACT_SOURCE')`);
      await transaction.$executeRawUnsafe(`INSERT INTO "ResourceRestore" ("id","organizationId","projectId","backupId","sourceResourceId","targetResourceId","engine","provider","sourceGeneration","requestedByUserId","requestIdempotencyKey","requestFingerprint","updatedAt") VALUES ('restore_scheduled','org_preflight','project_existing','scheduled_1','resource_existing','resource_restore_target','postgres','local','${generation}','user_preflight','restore-replay','restore-fingerprint',CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'scheduled deletion guard', protocol: 2, sql: `DELETE FROM "ResourceBackup" WHERE "id"='scheduled_1'`, error: /RECOVERY_CLEANUP_PENDING/ });
    record('scheduled restore and pin eligibility', 'format-1 restore and ARTIFACT_SOURCE pin inserts committed');

    await protocol2(client, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO "WorkflowJob" ("id","type","targetType","targetId","payload","operationalProtocolVersion","createdAt","updatedAt") VALUES ('job_v2','operational.backup','resource','resource_existing','{}',2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    });
    await expectRejected(client, { name: 'scoped stale protocol demotion', protocol: 2, sql: `UPDATE "WorkflowJob" SET "operationalProtocolVersion"=1 WHERE "id"='job_v2'`, error: /OPERATIONAL_PROTOCOL_2_REQUIRED/ });
    await protocol2(client, (transaction) => executeFixture(transaction, 'typed-positive'));
    record('typed branch positive controls', 'installation version, preview, intent, attempt, policy/run, reservation, object, upload and part committed native insert/update controls');
    for (const [section, sql] of fixtureSections) {
      if (section.startsWith('reject ')) {
        const [, name, code] = section.split(' ');
        await expectRejected(client, { name: `typed ${name}`, protocol: 2, sql, error: new RegExp(`\\b${code}\\b`, 'u') });
      }
    }
    const occurrenceUpdate = `UPDATE public."ResourceBackup" SET "updatedAt"=TIMESTAMP '2031-01-01 19:00:00' WHERE "id"='scheduled_1'`;
    const publicGuard = await guardDefinition(client);
    const originalSearchPath = await client.$queryRawUnsafe('SHOW search_path');
    await protocol2(client, async (transaction) => assert.equal(await transaction.$executeRawUnsafe(occurrenceUpdate), 1));
    record('occurrence UPDATE positive control', 'unchanged origin fields matched the real public policy-run occurrence');
    await assert.rejects(protocol2(client, async (transaction) => {
      // Fault injection only: no production-reachable stale-run state is claimed.
      await transaction.$executeRawUnsafe('CREATE TEMP TABLE "BackupPolicyRun" ON COMMIT DROP AS SELECT * FROM public."BackupPolicyRun"');
      assert.equal(await transaction.$executeRawUnsafe(`UPDATE pg_temp."BackupPolicyRun" SET "policyVersion"=2 WHERE "id"='run_1'`), 1);
      await transaction.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
      const [resolution] = await transaction.$queryRawUnsafe(`SELECT to_regclass('"BackupPolicyRun"')::oid::text AS resolved,to_regclass('pg_temp."BackupPolicyRun"')::oid::text AS temporary,to_regclass('public."BackupPolicyRun"')::oid::text AS original,(SELECT "policyVersion" FROM public."BackupPolicyRun" WHERE "id"='run_1') AS public_version`);
      assert.equal(resolution.resolved, resolution.temporary);
      assert.notEqual(resolution.temporary, resolution.original);
      assert.equal(resolution.public_version, 1);
      record('occurrence fault-injection relation resolution', { scope: 'FAULT_INJECTION_GUARD_EVALUATION', ...resolution });
      await transaction.$executeRawUnsafe(occurrenceUpdate);
    }), /BACKUP_POLICY_OCCURRENCE_INVALID/u);
    assert.deepEqual(await client.$queryRawUnsafe('SHOW search_path'), originalSearchPath);
    assert.deepEqual(await client.$queryRawUnsafe(`SELECT to_regclass('pg_temp."BackupPolicyRun"')::text AS temporary`), [{ temporary: null }]);
    assert.equal(await guardDefinition(client), publicGuard);
    await protocol2(client, async (transaction) => assert.equal(await transaction.$executeRawUnsafe(occurrenceUpdate), 1));
    record('occurrence UPDATE stale-row rejection', 'FAULT_INJECTION_GUARD_EVALUATION: exact occurrence error; temp/search_path rolled back; public UPDATE and003 guard restored');
    record('generic trigger dispatch', 'all13 state-guard table branches exercised with native positive controls and exact negative codes');
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanup = [];
    for (const [action, attempt] of [
      ['evidence-write', () => writeFileSync(join(evidenceDir, 'postgres-persistence.json'), `${JSON.stringify({ baseline: BASELINE, migrationSha256: MIGRATION_SHA256, migrations: MIGRATIONS, releaseSha: process.env.GITHUB_SHA ?? 'unpublished', postgresVersion, scope: 'focused-current-operational-migration', materialization, dispatch, scenarios: results }, null, 2)}\n`)],
      ...(client ? [['client-disconnect', () => client.$disconnect()]] : []),
      ['database-drop', () => admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)],
      ['role-drop', () => admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)],
      ['admin-disconnect', () => admin.$disconnect()],
      ['fixture-remove', () => rmSync(fixtureRoot, { recursive: true, force: true })],
      ['cleanup-report', () => t.diagnostic(JSON.stringify({ cleanup }))],
    ]) {
      try {
        await attempt();
        cleanup.push({ action, status: 'succeeded' });
      } catch (error) {
        let detail = error instanceof Error ? error.message : String(error);
        for (const secret of [databaseUrl.href, adminUrl.href, password, adminUrl.password].filter(Boolean)) detail = detail.replaceAll(secret, '[redacted]');
        detail = detail.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-dsn]').slice(-4_000);
        failures.push(new Error(`cleanup ${action} failed: ${detail}`));
        cleanup.push({ action, status: 'failed' });
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Preflight failures; see cleanup action outcomes', { cause: failures[0] });
});

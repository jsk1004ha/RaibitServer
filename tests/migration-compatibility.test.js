import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { checkAdditiveSql, checkCrd, checkMigrationContract, checkReviewedTriggerSql, digest, projectRoot } from '../scripts/check-migration-contract.mjs';

const manifest = JSON.parse(readFileSync(new URL('../prisma/migration-contract.json', import.meta.url), 'utf8'));
const crds = JSON.parse(readFileSync(new URL('../test-fixtures/contracts/crd-schema-v1.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

test('deployment lineage nullable uniqueness migration gate', async t => {
  // Given: only a newly added nullable key may constrain existing Deployment rows.
  const add = 'ALTER TABLE "Deployment" ADD COLUMN "operationKey" TEXT;';
  const index = 'CREATE UNIQUE INDEX "lineage_unique" ON "Deployment"("serviceId", "operationKey");';
  const cases = [
    [add + index, true],
    [index + add, false],
    [add + 'CREATE UNIQUE INDEX "bad" ON "Service"("operationKey");', false],
    ['ALTER TABLE "Deployment" ADD COLUMN "operationKey" TEXT DEFAULT \'x\';' + index, false],
    ['ALTER TABLE "Deployment" ADD COLUMN "operationKey" TEXT NOT NULL;' + index, false],
    [add + index.replace('("serviceId", "operationKey")', '("serviceId")'), false],
    [add + index.replace(';', ' NULLS NOT DISTINCT;'), false],
    [add + index.replace('"operationKey")', 'lower("operationKey"))'), false],
  ];
  // When / Then: both the pure checker and actual CLI accept only the safe case.
  for (const [sql, accepted] of cases) await t.test(sql, child => {
    if (accepted) assert.doesNotThrow(() => checkAdditiveSql(sql));
    else assert.throws(() => checkAdditiveSql(sql));
    const root = fixture(child);
    const next = structuredClone(manifest);
    const id = '000017_lineage_gate_fixture';
    mkdirSync(join(root, 'prisma/migrations', id));
    writeFileSync(join(root, 'prisma/migrations', id, 'migration.sql'), sql);
    next.migrations.push({ id, sha256: digest(sql) });
    writeFileSync(join(root, 'prisma/migration-contract.json'), JSON.stringify(next));
    assert.equal(spawnSync(process.execPath, [join(projectRoot, 'scripts/check-migration-contract.mjs'), root], { encoding: 'utf8' }).status, accepted ? 0 : 1);
  });
});

function fixture(t, cleanup = true) {
  const root = mkdtempSync(join(tmpdir(), 'raibit-migration-'));
  if (cleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['prisma', 'infra/k8s', 'infra/operators', 'test-fixtures/contracts']) {
    cpSync(join(projectRoot, path), join(root, path), { recursive: true });
  }
  return root;
}

function runPrisma(args, url) {
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: 'true' }, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('migration compatibility gate is available before deployment', async () => {
  // Given the application checkout, when checking deployment prerequisites.
  // Then the compatibility gate must exist before any migration is applied.
  assert.equal(existsSync(new URL('../scripts/check-migration-contract.mjs', import.meta.url)), true);
});

test('checkout has ordered digests and a forward-fix deployment contract', () => {
  // Given the checkout, when checking the migration contract, then all artifacts agree.
  assert.deepEqual(checkMigrationContract(), { migrations: manifest.migrations.length, applicationCompatibilityFloor: '000008_git_source_binding', rollbackMode: 'forward-fix', crds: 2 });
});

test('reviewed trigger migrations reject comment-obscured mutation through checker and CLI', async t => {
  // Given: the reviewed trigger migrations and destructive bodies obscured by both SQL comment forms.
  for (const id of ['000014_resource_recovery', '000015_preview_lineage']) {
    const sql = readFileSync(new URL(`../prisma/migrations/${id}/migration.sql`, import.meta.url), 'utf8');
    await t.test(`safe reviewed migration: ${id}`, () => assert.doesNotThrow(() => checkReviewedTriggerSql(sql)));
  }
  const quotedKeywords = `CREATE FUNCTION quoted_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'THEN /* not a comment */ DELETE'; RAISE EXCEPTION $message$THEN -- not a comment
DELETE$message$; RETURN NEW; END
$$;
CREATE TRIGGER "quoted_guard" BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION quoted_guard();`;
  await t.test('safe quoted comment markers and DML words', () => assert.doesNotThrow(() => checkReviewedTriggerSql(quotedKeywords)));
  const hostileBodies = [
    'BEGIN IF true THEN /* comment */ DELETE FROM "User"; END IF; RETURN NEW; END',
    'BEGIN IF true THEN -- comment\nDELETE FROM "User"; END IF; RETURN NEW; END',
  ];
  // When / Then: direct validation and the deployment CLI both fail closed for each bypass form.
  for (const [index, body] of hostileBodies.entries()) await t.test(`comment bypass ${index + 1}`, child => {
    const sql = `CREATE FUNCTION recovery_backup_guard() RETURNS trigger LANGUAGE plpgsql AS $$\n${body}\n$$;\nCREATE TRIGGER "ResourceBackup_guard" BEFORE INSERT ON "ResourceBackup" FOR EACH ROW EXECUTE FUNCTION recovery_backup_guard();`;
    assert.throws(() => checkReviewedTriggerSql(sql), /may not mutate rows/);
    const root = fixture(child);
    writeFileSync(join(root, 'prisma/migrations/000014_resource_recovery/migration.sql'), sql);
    const next = structuredClone(manifest);
    next.migrations.find(entry => entry.id === '000014_resource_recovery').sha256 = digest(sql);
    writeFileSync(join(root, 'prisma/migration-contract.json'), JSON.stringify(next));
    const cli = spawnSync(process.execPath, [join(projectRoot, 'scripts/check-migration-contract.mjs'), root], { encoding: 'utf8' });
    assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stderr, /may not mutate rows/);
  });
});

test('reject destructive migration matrix before apply', async (t) => {
  // Given hostile SQL, when the offline gate runs, then it rejects before any DB operation.
  for (const sql of ['DROP TABLE "User";', 'ALTER TABLE "User" DROP COLUMN "email";', 'TRUNCATE "User";',
    'ALTER TABLE "User" RENAME COLUMN "name" TO "label";', 'ALTER TABLE "User" ALTER COLUMN "name" SET NOT NULL;',
    'ALTER TABLE "User" ADD COLUMN "required" TEXT NOT NULL;', 'ALTER TABLE "User" ADD COLUMN "required" TEXT NOT NULL DEFAULT \'x\';',
    'DO $$ BEGIN EXECUTE \'DROP TABLE "User"\'; END $$;', 'ALTER TABLE "User" ADD COLUMN "x" TEXT; /* hidden */ DROP TABLE "User";']) {
    await t.test(sql, () => assert.throws(() => checkAdditiveSql(sql)));
  }
  for (const entry of crds) {
    for (const mutation of ['storage-version', 'storage-flag', 'required', 'field-type', 'removed-field']) {
      await t.test(`${entry.document.spec.names.kind}: ${mutation}`, () => {
        const next = structuredClone(entry.document);
        const version = next.spec.versions[0];
        const spec = version.schema.openAPIV3Schema.properties.spec;
        switch (mutation) {
          case 'storage-version': version.name = 'v2'; break;
          case 'storage-flag': version.storage = false; break;
          case 'required': spec.required = ['newRequired']; break;
          case 'field-type': spec.properties[Object.keys(spec.properties)[0]].type = 'integer'; break;
          case 'removed-field': delete spec.properties[Object.keys(spec.properties)[0]]; break;
          default: assert.fail('unknown fixture');
        }
        assert.throws(() => checkCrd(entry.document, next));
      });
    }
  }
  for (const mutation of ['missing-digest', 'wrong-digest', 'reordered', 'rollback', 'deploy-order', 'down-file']) {
    await t.test(mutation, (child) => {
      const root = fixture(child);
      const next = structuredClone(manifest);
      switch (mutation) {
        case 'missing-digest': delete next.migrations[0].sha256; break;
        case 'wrong-digest': next.migrations[0].sha256 = '0'.repeat(64); break;
        case 'reordered': next.migrations.reverse(); break;
        case 'rollback': next.rollbackMode = 'down'; break;
        case 'deploy-order': next.deploymentOrder.reverse(); break;
        case 'down-file': writeFileSync(join(root, 'prisma/migrations/000010_user_bans/down.sql'), 'DROP TABLE "User";'); break;
        default: assert.fail('unknown fixture');
      }
      writeFileSync(join(root, 'prisma/migration-contract.json'), JSON.stringify(next));
      assert.throws(() => checkMigrationContract(root));
      const cli = spawnSync(process.execPath, [join(projectRoot, 'scripts/check-migration-contract.mjs'), root], { encoding: 'utf8' });
      assert.equal(cli.status, 1, 'the deployment CLI must fail closed too');
    });
  }
  for (const sql of ['DROP TABLE "User";', 'ALTER TABLE "User" ADD COLUMN "required" TEXT NOT NULL;']) {
    await t.test(`appended migration rejected: ${sql}`, (child) => {
      const root = fixture(child);
      const next = structuredClone(manifest);
      const id = '000017_rejected_fixture';
      mkdirSync(join(root, 'prisma/migrations', id));
      writeFileSync(join(root, 'prisma/migrations', id, 'migration.sql'), sql);
      next.migrations.push({ id, sha256: digest(sql) });
      writeFileSync(join(root, 'prisma/migration-contract.json'), JSON.stringify(next));
      assert.throws(() => checkMigrationContract(root));
    });
  }
});

test('accept nullable forward expansion and optional CRD fields in the current version', () => {
  // Given additive fixtures, when checked, then old consumers retain their contract.
  checkAdditiveSql('ALTER TABLE "User" ADD COLUMN "futureNote" TEXT; CREATE INDEX "User_futureNote_idx" ON "User"("futureNote");');
  checkAdditiveSql('CREATE TABLE "FutureNotes" ("id" TEXT PRIMARY KEY, "note" TEXT);');
  for (const entry of crds) {
    const next = structuredClone(entry.document);
    next.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.compatibilityNote = { type: 'string' };
    checkCrd(entry.document, next);
  }
});

test('index gate rejects N-1 uniqueness restrictions and unsupported index grammar', async (t) => {
  // Given digest-valid future migrations, when the gate/CLI runs, then unsafe indexes never reach apply.
  for (const sql of [
    'CREATE UNIQUE INDEX "User_name_unique" ON "User"("name");',
    'CREATE UNIQUE INDEX "User_name_unique" ON "User"("name") WHERE "name" IS NOT NULL;',
    'CREATE INDEX "User_email_idx" ON "User"(lower("email"));',
    'CREATE INDEX "User_email_idx" ON "User"("email") UNSUPPORTED;',
    'CREATE INDEX "User_email_idx" ON "User"("email") WHERE arbitrary_function();',
    'CREATE INDEX "User_email_idx" ON "User";',
  ]) {
    await t.test(sql, (child) => {
      const root = fixture(child);
      const next = structuredClone(manifest);
      const id = '000017_index_fixture';
      mkdirSync(join(root, 'prisma/migrations', id));
      writeFileSync(join(root, 'prisma/migrations', id, 'migration.sql'), sql);
      next.migrations.push({ id, sha256: digest(sql) });
      writeFileSync(join(root, 'prisma/migration-contract.json'), JSON.stringify(next));
      assert.equal(spawnSync(process.execPath, [join(projectRoot, 'scripts/check-migration-contract.mjs'), root], { encoding: 'utf8' }).status, 1);
      assert.throws(() => checkMigrationContract(root));
    });
  }
});

test('index gate preserves additive non-unique indexes and new-table uniqueness', () => {
  // Given old tables and a new table, when checked, then only the new table gains uniqueness constraints.
  checkAdditiveSql('CREATE INDEX IF NOT EXISTS "User_name_idx" ON "User"("name", "email") WHERE "name" IS NOT NULL AND "email" IS NOT NULL;');
  checkAdditiveSql('CREATE TABLE "Environments" ("id" TEXT NOT NULL, "name" TEXT NOT NULL DEFAULT \'\', CONSTRAINT "Environments_pkey" PRIMARY KEY ("id"), CONSTRAINT "Environments_name_key" UNIQUE ("name")); CREATE UNIQUE INDEX "Environments_id_name_key" ON "Environments"("id", "name");');
});

test('fresh install and 000008 upgrade preserve N-1 Prisma readers/writers through forward-fix', { skip: !process.env.RAIBITSERVER_TEST_DATABASE_URL }, async (t) => {
  // Given an explicitly supplied disposable DB, isolate every scenario in owned schemas.
  const { PrismaClient } = await import('@prisma/client');
  const baseUrl = process.env.RAIBITSERVER_TEST_DATABASE_URL;
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  t.after(() => admin.$disconnect());
  for (const fromSnapshot of [false, true]) {
    await t.test(fromSnapshot ? 'upgrade-000008-N-1-forward-fix' : 'fresh-install', async (child) => {
      const root = fixture(child, false);
      const schema = `migration_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(baseUrl);
      url.searchParams.set('schema', schema);
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      let current;
      let previous;
      child.after(async () => {
        await previous?.$disconnect();
        await current?.$disconnect();
        await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        rmSync(root, { recursive: true, force: true });
        child.diagnostic(`cleanup schema=${schema} directory=${root}`);
      });
      const migrationRoot = join(root, 'prisma/migrations');
      if (fromSnapshot) {
        for (const entry of manifest.migrations.filter((entry) => entry.id > manifest.applicationCompatibilityFloor)) rmSync(join(migrationRoot, entry.id), { recursive: true });
      }
      runPrisma(['migrate', 'deploy', '--schema', join(root, 'prisma/schema.prisma')], url.href);
      current = new PrismaClient({ datasourceUrl: url.href });
      if (!fromSnapshot) {
        const user = await current.user.create({ data: { email: `${schema}@example.test` } });
        assert.equal(user.studentId, '');
        assert.equal(user.clubMemberClaim, false);
        assert.equal(user.bannedAt, null);
        return;
      }
      // Generate a real N-1 client from the complete schema minus the exact 000009/10 additions.
      const previousSchema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')
        .replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  engineType = "binary"\n  output = "./n-minus-one-client"')
        .replace(/^\s*(studentId|clubMemberClaim|bannedAt|banExpiresAt|banReason|bannedByUserId)\s+.*$/gm, '')
        .replace(/^\s*@@index\(\[bannedAt, banExpiresAt\]\).*$/gm, '');
      const previousPath = join(root, 'prisma/previous.prisma');
      writeFileSync(previousPath, previousSchema);
      runPrisma(['generate', '--schema', previousPath], url.href);
      const { PrismaClient: PreviousClient } = await import(pathToFileURL(join(root, 'prisma/n-minus-one-client/index.js')).href);
      previous = new PreviousClient({ datasourceUrl: url.href });
      const before = await previous.user.create({ data: { email: `${schema}@example.test`, name: 'N-1 preserved user' } });
      const preHash = digest(JSON.stringify(before));
      for (const entry of manifest.migrations.filter((entry) => entry.id > manifest.applicationCompatibilityFloor)) cpSync(join(projectRoot, 'prisma/migrations', entry.id), join(migrationRoot, entry.id), { recursive: true });
      // When migration deploy runs before the new application, then the old client still reads/writes.
      runPrisma(['migrate', 'deploy', '--schema', join(root, 'prisma/schema.prisma')], url.href);
      const postHash = digest(JSON.stringify(await previous.user.findUniqueOrThrow({ where: { id: before.id } })));
      assert.equal(postHash, preHash);
      assert.equal((await previous.user.create({ data: { email: `${schema}-after@example.test` } })).role, 'USER');
      const expanded = await current.user.findUniqueOrThrow({ where: { id: before.id } });
      assert.equal(expanded.studentId, '');
      assert.equal(expanded.clubMemberClaim, false);
      const fix = 'ALTER TABLE "User" ADD COLUMN "compatibilityNote" TEXT;';
      checkAdditiveSql(fix);
      mkdirSync(join(migrationRoot, '000011_forward_fix'));
      writeFileSync(join(migrationRoot, '000011_forward_fix/migration.sql'), fix);
      runPrisma(['migrate', 'deploy', '--schema', join(root, 'prisma/schema.prisma')], url.href);
      assert.equal(digest(JSON.stringify(await previous.user.findUniqueOrThrow({ where: { id: before.id } }))), preHash);
      assert.equal((await previous.user.update({ where: { id: before.id }, data: { name: 'N-1 writer after forward-fix' } })).name, 'N-1 writer after forward-fix');
      const columns = await current.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'User' AND column_name IN ('studentId', 'bannedAt', 'compatibilityNote') ORDER BY column_name`);
      assert.deepEqual(columns.map((row) => row.column_name), ['bannedAt', 'compatibilityNote', 'studentId']);
      child.diagnostic(JSON.stringify({ scenario: '000008-upgrade-forward-fix', previousSchemaSha256: digest(previousSchema), preHash, postHash, forwardFixHash: preHash }));
    });
  }
});

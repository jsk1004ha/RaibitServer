import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReviewedTriggerSql, digest, projectRoot } from '../scripts/check-migration-contract.mjs';

const manifest = JSON.parse(readFileSync(new URL('../prisma/migration-contract.json', import.meta.url), 'utf8'));
const reviewedRecovery = readFileSync(new URL('../prisma/migrations/000014_resource_recovery/migration.sql', import.meta.url), 'utf8');
const declaration = (body, delimiter = '$$', table = '"User"') => `CREATE OR REPLACE FUNCTION reviewed_guard() RETURNS trigger LANGUAGE plpgsql AS ${delimiter}\n${body}\n${delimiter};\nCREATE TRIGGER "reviewed_guard" BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reviewed_guard();`;

function withFirstGuardPrefix(fragment, delimiter = '$$') {
  const header = 'CREATE FUNCTION recovery_backup_guard() RETURNS trigger LANGUAGE plpgsql AS $$';
  let sql = reviewedRecovery.replace(header, () => `CREATE OR REPLACE FUNCTION recovery_backup_guard() RETURNS trigger LANGUAGE plpgsql AS ${delimiter}`)
    .replace("BEGIN\n  IF TG_OP='DELETE'", () => `BEGIN\n  ${fragment}\n  IF TG_OP='DELETE'`);
  if (delimiter !== '$$') sql = sql.replace('END $$;\nCREATE TRIGGER "ResourceBackup_guard"', () => `END ${delimiter};\nCREATE TRIGGER "ResourceBackup_guard"`);
  return sql;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'raibit-trigger-grammar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['prisma', 'infra/k8s', 'infra/operators', 'test-fixtures/contracts']) cpSync(join(projectRoot, path), join(root, path), { recursive: true });
  return root;
}

test('reviewed trigger grammar is closed through checker and CLI', async t => {
  const verify = async (name, sql, cliSql, accepted, migrationId) => t.test(name, child => {
    if (accepted) assert.doesNotThrow(() => checkReviewedTriggerSql(sql, migrationId));
    else assert.throws(() => checkReviewedTriggerSql(sql, migrationId));
    const root = fixture(child);
    writeFileSync(join(root, 'prisma/migrations/000014_resource_recovery/migration.sql'), cliSql);
    const next = structuredClone(manifest);
    next.migrations.find(entry => entry.id === '000014_resource_recovery').sha256 = digest(cliSql);
    writeFileSync(join(root, 'prisma/migration-contract.json'), JSON.stringify(next));
    const cli = spawnSync(process.execPath, [join(projectRoot, 'scripts/check-migration-contract.mjs'), root], { encoding: 'utf8' });
    assert.equal(cli.status, accepted ? 0 : 1, `${cli.stdout}\n${cli.stderr}`);
  });
  // Given: genuine reviewed migrations and every supported lexical form.
  for (const id of ['000014_resource_recovery', '000015_preview_lineage']) {
    const sql = readFileSync(new URL(`../prisma/migrations/${id}/migration.sql`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => checkReviewedTriggerSql(sql, id));
  }
  const safe = [
    ['nested comments and doubled double-quoted identifier', declaration('BEGIN /* outer /* nested */ comment */ RETURN NEW; END', '$$', '"Odd""Table"'), withFirstGuardPrefix('/* outer /* nested */ comment */')],
    ['untagged function body with tagged dollar string', declaration('BEGIN RAISE EXCEPTION $message$DELETE /* text */$message$; RETURN NEW; END'), withFirstGuardPrefix('RAISE EXCEPTION $message$DELETE /* text */$message$;')],
    ['tagged function body with untagged dollar string', declaration('BEGIN RAISE EXCEPTION $$UPDATE -- text$$; RETURN NEW; END', '$function$'), withFirstGuardPrefix('RAISE EXCEPTION $$UPDATE -- text$$;', '$function$')],
    ['escape string with backslash-escaped apostrophe', declaration("BEGIN RAISE EXCEPTION E'it\\'s DELETE'; RETURN NEW; END"), withFirstGuardPrefix("RAISE EXCEPTION E'it\\'s DELETE';")],
  ];
  for (const [name, sql, cliSql] of safe) await verify(`accepts ${name}`, `${sql}\n/* trailing /* nested */ trivia */`, cliSql, true);
  const obscuredMutations = [
    ['block comment', 'IF true THEN /* comment */ DELETE FROM "User"; END IF;'],
    ['line comment', 'IF true THEN -- comment\nDELETE FROM "User"; END IF;'],
  ];
  for (const [name, statement] of obscuredMutations) await verify(`rejects body mutation after ${name}`, declaration(`BEGIN ${statement} RETURN NEW; END`), withFirstGuardPrefix(statement), false);

  // When / Then: executable exterior statements and unterminated lexical forms fail at both boundaries.
  const base = declaration('BEGIN RETURN NEW; END').replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
  const rejected = [
    ['exterior DELETE', 'DELETE FROM "User";'],
    ['exterior INSERT', 'INSERT INTO "User" (id) VALUES (\'x\');'],
    ['exterior UPDATE', 'UPDATE "User" SET id=\'x\';'],
    ['exterior CREATE TABLE', 'CREATE TABLE pwned(id TEXT);'],
    ['exterior unsafe ALTER', 'ALTER TABLE "User" ALTER COLUMN id SET NOT NULL;'],
    ['unterminated block comment', '/* outer /* inner */'],
    ['unterminated tagged dollar quote', '$tag$unfinished'],
    ['unterminated untagged dollar quote', '$$unfinished'],
    ['unterminated single quote', '\'unfinished'],
    ['unterminated double quote', '"unfinished'],
    ['unterminated E string', "E'unfinished\\"],
  ];
  for (const [name, suffix] of rejected) await verify(`rejects ${name}`, `${base}\n${suffix}`, `${reviewedRecovery}\n${suffix}`, false);
  const extraDeclaration = declaration('BEGIN RETURN NEW; END');
  await verify('rejects an extra function and trigger declaration', `${reviewedRecovery}\n${extraDeclaration}`, `${reviewedRecovery}\n${extraDeclaration}`, false, '000014_resource_recovery');
  const unfinishedFunction = 'CREATE FUNCTION reviewed_guard() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END;';
  await verify('rejects unterminated function dollar body', unfinishedFunction, reviewedRecovery.replace('END $$;\nCREATE TRIGGER "ResourceBackup_guard"', 'END;\nCREATE TRIGGER "ResourceBackup_guard"'), false);
});

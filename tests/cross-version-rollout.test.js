import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { checkAdditiveSql, checkCrd, checkMigrationContract, digest, projectRoot } from '../scripts/check-migration-contract.mjs';

const nMinusOneRef = 'ea2b6274f4920d273880ca97201113ce84cf030a';
const binaryVariables = [
  'RAIBITSERVER_N_MINUS_ONE_API_BINARY',
  'RAIBITSERVER_N_MINUS_ONE_BUILDER_BINARY',
  'RAIBITSERVER_N_MINUS_ONE_ORCHESTRATOR_BINARY',
  'RAIBITSERVER_N_MINUS_ONE_PROVISIONER_BINARY',
  'RAIBITSERVER_CURRENT_API_BINARY',
  'RAIBITSERVER_CURRENT_BUILDER_BINARY',
  'RAIBITSERVER_CURRENT_ORCHESTRATOR_BINARY',
  'RAIBITSERVER_CURRENT_PROVISIONER_BINARY',
];
const requiredRuntimeVariables = [
  'RAIBITSERVER_TEST_DATABASE_URL',
  'RAIBITSERVER_CROSS_VERSION_RUNNER',
  ...binaryVariables,
];
const rolloutStages = ['fresh', '000008', 'n-minus-one', 'migrated-old-read-write', 'current-new-features', 'application-rollback', 'forward-fix'];

function git(args) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function gitFile(ref, path) {
  return git(['show', `${ref}:${path}`]);
}

function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runtimeQualification(env = process.env) {
  const missing = requiredRuntimeVariables.filter((name) => !env[name]);
  for (const name of binaryVariables.concat('RAIBITSERVER_CROSS_VERSION_RUNNER')) {
    if (env[name] && (!existsSync(env[name]) || !statSync(env[name]).isFile())) missing.push(`${name}:not-a-file`);
  }
  return missing.length === 0 ? { status: 'READY', missing: [] } : { status: 'NOT_RUN', missing: [...new Set(missing)].sort() };
}

function verifyRuntimeResult(result, binaries) {
  assert.equal(result.version, 1);
  assert.equal(result.status, 'PASS');
  assert.equal(result.nMinusOneRef, nMinusOneRef);
  assert.equal(result.migrationDigest, checkMigrationContract().migrationDigest);
  assert.deepEqual(result.stages.map((entry) => entry.stage), rolloutStages);
  for (const entry of result.stages) {
    assert.match(entry.rowHash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.rowCount) && entry.rowCount >= 0);
  }
  const byStage = Object.fromEntries(result.stages.map((entry) => [entry.stage, entry]));
  assert.equal(byStage['migrated-old-read-write'].preservedRowHash, byStage['n-minus-one'].rowHash);
  assert.equal(byStage['application-rollback'].preservedRowHash, byStage['current-new-features'].rowHash);
  assert.equal(byStage['forward-fix'].preservedRowHash, byStage['application-rollback'].rowHash);
  assert.deepEqual(result.binaries, binaries);
  assert.match(result.databaseIdentityHash, /^[a-f0-9]{64}$/);
}

function validRuntimeResult(migrationDigest) {
  const stages = rolloutStages.map((stage) => ({ stage, rowCount: 1, rowHash: digest(stage) }));
  const byStage = Object.fromEntries(stages.map((entry) => [entry.stage, entry]));
  byStage['migrated-old-read-write'].preservedRowHash = byStage['n-minus-one'].rowHash;
  byStage['application-rollback'].preservedRowHash = byStage['current-new-features'].rowHash;
  byStage['forward-fix'].preservedRowHash = byStage['application-rollback'].rowHash;
  return { version: 1, status: 'PASS', nMinusOneRef, migrationDigest, stages, binaries: [], databaseIdentityHash: digest('disposable-db') };
}

test('cross-version matrix uses an immutable N-1 source and preserves old CR schemas', () => {
  assert.equal(git(['rev-parse', `${nMinusOneRef}^{commit}`]).trim(), nMinusOneRef);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', nMinusOneRef, 'HEAD'], { cwd: projectRoot }).status, 0);
  const oldManifest = JSON.parse(gitFile(nMinusOneRef, 'prisma/migration-contract.json'));
  const currentManifest = JSON.parse(readFileSync(join(projectRoot, 'prisma/migration-contract.json'), 'utf8'));
  assert.equal(oldManifest.migrations.at(-1).id, '000016_pem_context_indexes');
  assert.deepEqual(currentManifest.migrations.filter((entry) => entry.id === '000019_github_source_mutation_idempotency'), [{ id: '000019_github_source_mutation_idempotency', sha256: '771d79c2bb5ac0dcb1d6a467c89ee7f67abea552e91b902fe67e293c977bb9e5' }]);
  assert.equal(digest(gitFile(nMinusOneRef, 'prisma/schema.prisma')), '31b9db46b73929aa48995c9f0ec46369ac118426ef2e139871e032a85a94225e');
  for (const path of ['infra/k8s/appservice-crd.yaml', 'infra/operators/manageddatabase-crd.yaml']) {
    checkCrd(parse(gitFile(nMinusOneRef, path)), parse(readFileSync(join(projectRoot, path), 'utf8')));
  }
});

test('cross-version runtime reports NOT_RUN unless disposable DB and actual binaries are explicit', (t) => {
  const qualification = runtimeQualification();
  if (qualification.status === 'NOT_RUN') {
    t.diagnostic(JSON.stringify({ scenario: 'cross-version-runtime', ...qualification }));
    assert.ok(qualification.missing.length > 0);
    return;
  }
  const binaries = binaryVariables.map((variable) => ({ variable, sha256: fileDigest(process.env[variable]) }));
  const migrationDigest = checkMigrationContract().migrationDigest;
  const runner = spawnSync(process.env.RAIBITSERVER_CROSS_VERSION_RUNNER, [], {
    cwd: projectRoot,
    env: { ...process.env, RAIBITSERVER_N_MINUS_ONE_REF: nMinusOneRef, RAIBITSERVER_MIGRATION_DIGEST: migrationDigest },
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(runner.status, 0, 'cross-version runner failed');
  assert.equal(runner.stdout.includes(process.env.RAIBITSERVER_TEST_DATABASE_URL), false, 'runner output exposed the database URL');
  const result = JSON.parse(runner.stdout);
  verifyRuntimeResult(result, binaries);
  t.diagnostic(JSON.stringify({ scenario: 'cross-version-runtime', status: 'PASS', migrationDigest: checkMigrationContract().migrationDigest, stages: result.stages }));
});

test('cross-version adversarial matrix blocks incomplete or incompatible releases', async (t) => {
  const contract = checkMigrationContract();
  await t.test('missing runtime prerequisites', () => {
    assert.equal(runtimeQualification({}).status, 'NOT_RUN');
  });
  await t.test('runtime migration digest mismatch', () => {
    assert.throws(() => verifyRuntimeResult({ version: 1, status: 'PASS', nMinusOneRef, migrationDigest: '0'.repeat(64) }, []));
  });
  for (const sql of [
    'ALTER TABLE "Domain" ADD COLUMN "organizationId" TEXT NOT NULL;',
    'ALTER TABLE "Domain" DROP COLUMN "projectId";',
    'UPDATE "Domain" SET "projectId" = NULL;',
  ]) {
    await t.test(sql, () => assert.throws(() => checkAdditiveSql(sql)));
  }
  await t.test('old CR object required-field mutation', () => {
    const old = parse(gitFile(nMinusOneRef, 'infra/k8s/appservice-crd.yaml'));
    const current = structuredClone(old);
    current.spec.versions[0].schema.openAPIV3Schema.properties.spec.required = ['compatibilityRequired'];
    assert.throws(() => checkCrd(old, current));
  });
  await t.test('half-apply', () => {
    const result = validRuntimeResult(contract.migrationDigest);
    result.stages = result.stages.slice(0, 3);
    assert.throws(() => verifyRuntimeResult(result, []));
  });
  await t.test('crash', () => {
    const result = validRuntimeResult(contract.migrationDigest);
    result.status = 'FAIL';
    assert.throws(() => verifyRuntimeResult(result, []));
  });
  await t.test('new-data-rollback', () => {
    const result = validRuntimeResult(contract.migrationDigest);
    result.stages.find((entry) => entry.stage === 'application-rollback').preservedRowHash = digest('lost-new-data');
    assert.throws(() => verifyRuntimeResult(result, []));
  });
  assert.match(contract.migrationDigest, /^[a-f0-9]{64}$/);
});

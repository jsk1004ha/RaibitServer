import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { componentSample } from '../scripts/production-evidence/run-component.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const engines = ['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey'];
const clients = ['psql', 'mysql', 'mariadb', 'mongosh', 'redis-cli', 'valkey-cli'];
const keys = ['DATABASE_URL', 'MYSQL_URL', 'MARIADB_URL', 'MONGODB_URI', 'REDIS_URL', 'VALKEY_URL'];
const stages = ['createdAt', 'readyAt', 'attachedAt', 'healthAt', 'sentinelAt', 'detachedAt', 'consumerRemovedAt', 'providerDeleteStartedAt', 'objectsDeletedAt', 'rowDeletedAt', 'cleanupAt'];
const lifecycleAssertions = ['provision', 'authenticated_health', 'attach_query', 'detach', 'resource_delete'];
function cli(file, options = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/verify-production-evidence.mjs'), ...options, file], { encoding: 'utf8' });
}
async function specimen(t) {
  const directory = await mkdtemp(path.join(process.env.RAIBITSERVER_TEST_EVIDENCE_ROOT ?? tmpdir(), 'task14-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = Date.now() - 2000;
  const { manifest } = componentSample('resources', new Date(base).toISOString());
  const fragment = manifest.fragments[0];
  fragment.resourceScope = { kind: 'lifecycle-only', engineReceiptPaths: engines.map(engine => `${engine}.json`), sqliteReceiptPath: 'sqlite.json' };
  const receipts = engines.map((engine, index) => {
    const identity = { ...manifest.identity, resourceId: `resource-${engine}` };
    const nonce = randomUUID();
    const checksum = digest({ runId: identity.runId, engine, resourceId: identity.resourceId, nonce });
    return {
      schema: 'raibitserver.resource-lifecycle/v1', engine, level: 'L3', provenance: 'fixture', identity,
      providerImage: `registry.example/${engine}@sha256:${digest(engine)}`, namespace: 'shared-tenant',
      objects: { workloadUid: randomUUID(), podUid: randomUUID(), pvcUid: randomUUID(), secretUid: randomUUID(), secretName: `connection-${engine}`, secretImmutable: true, storageBound: true, workloadReady: true },
      attachment: { id: `attachment-${engine}`, serviceId: identity.serviceId, deploymentId: identity.deploymentId, namespace: 'shared-tenant', consumerPodUid: 'shared-consumer-pod', secretName: `connection-${engine}`, key: keys[index], secretUid: '' },
      native: { kind: 'engine-native', client: clients[index], namespace: 'shared-tenant', consumerPodUid: 'shared-consumer-pod', secretUid: '', authenticated: true, healthExitCode: 0, writeExitCode: 0, readExitCode: 0, nonce, inputSha256: checksum, readSha256: checksum },
      times: Object.fromEntries(stages.map((stage, position) => [stage, new Date(base + 10 + position * 10).toISOString()])),
      deletion: { attachmentsRemaining: 0, injectedRefsRemaining: 0, consumerRemoved: true, providerObjectsRemaining: 0, resourceRowsRemaining: 0 }, cleanup: 'PASS',
    };
  });
  for (const receipt of receipts) receipt.attachment.secretUid = receipt.native.secretUid = receipt.objects.secretUid;
  // The six engine rows are synthetic contract data. Only this isolated SQLite operation is real.
  const databasePath = path.join(directory, 'isolated.db'), databaseId = randomUUID();
  const value = JSON.stringify({ databaseId, engine: 'sqlite', runId: manifest.identity.runId });
  const sqliteTimes = { createdAt: new Date().toISOString() };
  const database = new DatabaseSync(databasePath);
  let readValue;
  try {
    database.exec('CREATE TABLE sentinel (value TEXT NOT NULL)'); database.prepare('INSERT INTO sentinel VALUES (?)').run(value);
    sqliteTimes.writtenAt = new Date().toISOString(); readValue = database.prepare('SELECT value FROM sentinel').get().value; sqliteTimes.readAt = new Date().toISOString();
  }
  finally { database.close(); }
  await rm(databasePath);
  await assert.rejects(stat(databasePath), { code: 'ENOENT' });
  sqliteTimes.removedAt = new Date().toISOString();
  const sqlite = { schema: 'raibitserver.sqlite-lifecycle/v1', engine: 'sqlite', level: 'L1', provenance: 'local', identity: manifest.identity,
    databaseId, times: sqliteTimes, inputSha256: digest(value), readSha256: digest(readValue), writeCount: 1, readCount: 1, cleanup: 'PASS', fileRemoved: true };
  manifest.observedAt = fragment.observedAt = new Date().toISOString();
  const records = new Map([...receipts.map(receipt => [`${receipt.engine}.json`, receipt]), ['sqlite.json', sqlite]]);
  fragment.artifacts = [...records].map(([file, record]) => ({ path: file, sha256: digest(`${JSON.stringify(record)}\n`), redacted: true }));
  fragment.assertions = lifecycleAssertions.map(id => ({ id, status: 'PASS', artifactPaths: [...records.keys()] }));
  fragment.cleanup.assertions[0].artifactPaths = [...records.keys()];
  manifest.cleanup.assertions[0].artifactPaths = [...records.keys()];
  return { directory, manifest, records, receipts, sqlite };
}
async function persist(sample) {
  for (const [file, record] of sample.records) {
    const bytes = `${JSON.stringify(record)}\n`;
    await writeFile(path.join(sample.directory, file), bytes);
    const artifact = sample.manifest.fragments[0].artifacts.find(item => item.path === file);
    if (artifact) artifact.sha256 = digest(bytes);
  }
  const file = path.join(sample.directory, 'manifest.json');
  await writeFile(file, JSON.stringify(sample.manifest));
  return file;
}
test('Given six fixture engines and real isolated SQLite, When public lifecycle component verification runs, Then only component validity succeeds', async t => {
  const sample = await specimen(t);
  const result = cli(await persist(sample), ['--fragment', 'resources']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).releaseEligible, false);
  assert.equal(sample.sqlite.inputSha256, sample.sqlite.readSha256);
  t.diagnostic(JSON.stringify({ ...sample.sqlite, fixtureEngineCount: 6, nativeEngines: 'NOT_RUN' }));
  if (process.env.RAIBITSERVER_TASK14_SQLITE_RECEIPT) await writeFile(process.env.RAIBITSERVER_TASK14_SQLITE_RECEIPT, JSON.stringify({ ...sample.sqlite, fixtureEngineCount: 6, nativeEngines: 'NOT_RUN' }), { flag: 'wx' });
});
const mutations = [
  ['missing engine', 'invalid_resource_scope', s => s.manifest.fragments[0].resourceScope.engineReceiptPaths.pop()],
  ['duplicate engine path', 'reused_engine_receipt', s => { s.manifest.fragments[0].resourceScope.engineReceiptPaths[1] = 'postgresql.json'; }],
  ['duplicate engine identity', 'reused_engine_receipt', s => { s.receipts[1].engine = 'postgresql'; }],
  ['renamed copied receipt', 'reused_engine_receipt', s => { Object.assign(s.receipts[1], structuredClone(s.receipts[0]), { engine: 'mysql' }); }],
  ['wrong engine client', 'native_evidence_mismatch', s => { s.receipts[1].native.client = 'psql'; }],
  ['contract query', 'invalid_engine_receipt', s => { s.receipts[0].native.kind = 'provider-contract'; }],
  ['unauthenticated', 'invalid_engine_receipt', s => { s.receipts[0].native.authenticated = false; }],
  ['wrong password', 'invalid_engine_receipt', s => { s.receipts[0].native.healthExitCode = 1; }],
  ['write failure', 'invalid_engine_receipt', s => { s.receipts[0].native.writeExitCode = 1; }],
  ['read failure', 'invalid_engine_receipt', s => { s.receipts[0].native.readExitCode = 1; }],
  ['forged checksum', 'native_evidence_mismatch', s => { s.receipts[0].native.readSha256 = 'a'.repeat(64); }],
  ['changed nonce', 'native_evidence_mismatch', s => { s.receipts[0].native.nonce = randomUUID(); }],
  ['tag image', 'invalid_engine_receipt', s => { s.receipts[0].providerImage = 'registry.example/postgres:latest'; }],
  ['replacement secret', 'attachment_identity_mismatch', s => { s.receipts[0].attachment.secretUid = randomUUID(); }],
  ['wrong ref name', 'attachment_identity_mismatch', s => { s.receipts[0].attachment.secretName = 'other'; }],
  ['wrong ref key', 'attachment_identity_mismatch', s => { s.receipts[0].attachment.key = 'MYSQL_URL'; }],
  ['foreign service', 'attachment_identity_mismatch', s => { s.receipts[0].attachment.serviceId = 'foreign'; }],
  ['foreign deployment', 'attachment_identity_mismatch', s => { s.receipts[0].attachment.deploymentId = 'foreign'; }],
  ['foreign attachment namespace', 'attachment_identity_mismatch', s => { s.receipts[0].attachment.namespace = 'foreign'; }],
  ['foreign native consumer', 'native_evidence_mismatch', s => { s.receipts[0].native.consumerPodUid = 'foreign'; }],
  ['foreign native namespace', 'native_evidence_mismatch', s => { s.receipts[0].native.namespace = 'foreign'; }],
  ['foreign native Secret', 'native_evidence_mismatch', s => { s.receipts[0].native.secretUid = randomUUID(); }],
  ['attach before ready', 'lifecycle_order_mismatch', s => { s.receipts[0].times.attachedAt = s.receipts[0].times.createdAt; }],
  ['provider delete before consumer removal', 'lifecycle_order_mismatch', s => { s.receipts[0].times.providerDeleteStartedAt = s.receipts[0].times.detachedAt; }],
  ['row deleted before objects', 'lifecycle_order_mismatch', s => { s.receipts[0].times.rowDeletedAt = s.receipts[0].times.createdAt; }],
  ['outside run', 'stale_state', s => { s.receipts[0].times.createdAt = new Date(Date.now() - 20_000).toISOString(); }],
  ['fixture relabeled credentialed', 'level_mismatch', s => { s.receipts[0].provenance = 'credentialed'; }],
  ['kind relabeled L3', 'invalid_engine_receipt', s => { s.receipts[0].provenance = 'kind'; }],
  ['SQLite as engine', 'invalid_engine_receipt', s => { s.receipts[0].engine = 'sqlite'; }],
  ['SQLite as L3', 'invalid_sqlite_receipt', s => { s.sqlite.level = 'L3'; }],
  ['SQLite wrong read', 'native_evidence_mismatch', s => { s.sqlite.readSha256 = 'a'.repeat(64); }],
  ['SQLite retained file', 'invalid_sqlite_receipt', s => { s.sqlite.fileRemoved = false; }],
  ['SQLite replayed database', 'native_evidence_mismatch', s => { s.sqlite.databaseId = randomUUID(); }],
  ['SQLite outside run', 'stale_state', s => { s.sqlite.times.createdAt = new Date(Date.now() - 20_000).toISOString(); }],
  ['SQLite wrong order', 'lifecycle_order_mismatch', s => { s.sqlite.times.writtenAt = new Date(Date.parse(s.sqlite.times.removedAt) + 100).toISOString(); }],
  ['engine cleanup missing', 'cleanup_failed', s => { s.receipts[0].cleanup = 'NOT_RUN'; }],
  ['SQLite cleanup failed', 'cleanup_failed', s => { s.sqlite.cleanup = 'FAIL'; }],
  ['SQLite receipt as engine path', 'reused_engine_receipt', s => { s.manifest.fragments[0].resourceScope.sqliteReceiptPath = 'postgresql.json'; }],
  ['missing engine artifact', 'missing_artifact', s => { s.manifest.fragments[0].resourceScope.engineReceiptPaths[0] = 'missing.json'; }],
  ['escaped receipt', 'invalid_resource_scope', s => { s.manifest.fragments[0].resourceScope.engineReceiptPaths[0] = '../outside.json'; }],
];
for (const field of ['workloadUid', 'podUid', 'pvcUid', 'secretUid']) mutations.push([`copied ${field}`, 'reused_engine_receipt', s => { s.receipts[1].objects[field] = s.receipts[0].objects[field]; }]);
for (const field of ['secretImmutable', 'storageBound', 'workloadReady']) mutations.push([`false ${field}`, 'invalid_engine_receipt', s => { s.receipts[0].objects[field] = false; }]);
for (const field of ['attachmentsRemaining', 'injectedRefsRemaining', 'providerObjectsRemaining', 'resourceRowsRemaining']) mutations.push([`remaining ${field}`, 'invalid_engine_receipt', s => { s.receipts[0].deletion[field] = 1; }]);
for (const field of ['runId', 'environmentFingerprint', 'sourceCommitSha', 'migrationDigest', 'operatorContractDigest', 'operatorInputFingerprint', 'organizationId', 'projectId', 'serviceId', 'deploymentId']) mutations.push([`mixed ${field}`, 'identity_mismatch', s => {
  s.receipts[0].identity[field] = field === 'runId' ? randomUUID() : field === 'sourceCommitSha' ? 'a'.repeat(40) : field.endsWith('Id') ? 'foreign' : 'a'.repeat(64);
}]);
for (const [name, reason, mutate] of mutations) test(`Given ${name}, When the physical CLI verifies lifecycle receipts, Then ${reason}`, async t => {
  const sample = await specimen(t); mutate(sample);
  const result = cli(await persist(sample));
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), reason);
});
for (const profile of ['train-a', 'final']) for (const declared of ['component', profile]) for (const selected of [false, true]) test(`Given lifecycle-only ${declared}, When requesting ${profile} with fragment=${selected}, Then release scope is rejected`, async t => {
  const sample = await specimen(t); sample.manifest.profile = declared;
  const result = cli(await persist(sample), ['--profile', profile, ...(selected ? ['--fragment', 'resources'] : [])]);
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'resource_scope_mismatch');
});
for (const profile of ['train-a', 'final']) test(`Given declared ${profile} lifecycle-only, When narrowing flags to component, Then original release scope cannot be hidden`, async t => {
  const sample = await specimen(t); sample.manifest.profile = profile;
  const result = cli(await persist(sample), ['--profile', 'component', '--fragment', 'resources']);
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'resource_scope_mismatch');
});
test('Given no explicit lifecycle discriminator, When backup assertions are absent, Then full-resource validation is not narrowed', async t => {
  const sample = await specimen(t); delete sample.manifest.fragments[0].resourceScope;
  const result = cli(await persist(sample));
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'missing_assertion');
});
test('Given a modified physical receipt, When its old digest is retained, Then content binding fails', async t => {
  const sample = await specimen(t), file = await persist(sample);
  await writeFile(path.join(sample.directory, 'mysql.json'), '{}');
  const result = cli(file); assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'artifact_digest_mismatch');
});
test('Given a symlinked receipt, When physical evidence is verified, Then the path boundary fails', async t => {
  const sample = await specimen(t), file = await persist(sample);
  await rm(path.join(sample.directory, 'mysql.json'));
  await symlink(path.join(sample.directory, 'postgresql.json'), path.join(sample.directory, 'mysql.json'));
  const result = cli(file); assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'invalid_artifact');
});

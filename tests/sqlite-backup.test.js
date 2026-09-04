import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { backupSQLite, SQLiteBackupError } from '../packages/core/src/sqlite-backup.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'raibit-sqlite-backup-'));
  const providerRoot = join(directory, 'provider');
  await mkdir(providerRoot);
  const sourcePath = join(directory, 'source.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec('CREATE TABLE sentinel (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE records (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  source.prepare('INSERT INTO sentinel(key,value) VALUES (?,?)').run('canary', 'raibit');
  source.prepare('INSERT INTO records(note) VALUES (?)').run('preserved row');
  source.close();
  return {
    directory,
    providerRoot,
    sourcePath,
    targetPath: join(providerRoot, 'backup.sqlite'),
    timeoutMs: 5_000,
    expectedTables: ['sentinel', 'records'],
    sentinel: { table: 'sentinel', keyColumn: 'key', valueColumn: 'value', key: 'canary', value: 'raibit' },
  };
}

test('backupSQLite returns an L1 receipt only after native backup verification', async t => {
  // Given
  const input = await fixture();
  t.after(() => rm(input.directory, { recursive: true, force: true }));
  const sourceBefore = await readFile(input.sourcePath);

  // When
  const receipt = await backupSQLite(input);

  // Then
  assert.deepEqual(
    { engine: receipt.engine, truthLevel: receipt.truthLevel, method: receipt.method, integrity: receipt.integrity, schemaVerified: receipt.schemaVerified, sentinelVerified: receipt.sentinelVerified, sourcePreserved: receipt.sourcePreserved, targetFresh: receipt.targetFresh, publishesReady: receipt.publishesReady, artifactDisposition: receipt.artifactDisposition },
    { engine: 'sqlite', truthLevel: 'L1', method: 'VACUUM INTO', integrity: 'ok', schemaVerified: true, sentinelVerified: true, sourcePreserved: true, targetFresh: true, publishesReady: false, artifactDisposition: 'requires-encrypted-upload' },
  );
  assert.match(receipt.checksum, /^[a-f0-9]{64}$/);
  assert.equal(receipt.bytes, (await stat(input.targetPath)).size);
  assert.deepEqual(await readFile(input.sourcePath), sourceBefore);
  const restored = new DatabaseSync(input.targetPath, { readOnly: true });
  assert.equal(restored.prepare('SELECT note FROM records').get().note, 'preserved row');
  restored.close();
});

test('backupSQLite rejects unsafe paths, corrupt data, and unverifiable contents without publishing', async t => {
  // Given
  const base = await fixture();
  t.after(() => rm(base.directory, { recursive: true, force: true }));
  const existing = join(base.providerRoot, 'existing.sqlite');
  await writeFile(existing, 'owned');
  const corrupt = join(base.directory, 'corrupt.sqlite');
  await writeFile(corrupt, 'not sqlite');
  const cases = [
    ['source is target', { ...base, targetPath: base.sourcePath }, 'invalid_input'],
    ['target escapes provider root', { ...base, targetPath: join(base.directory, 'outside.sqlite') }, 'invalid_input'],
    ['target already exists', { ...base, targetPath: existing }, 'target_exists'],
    ['SQL identifier injection', { ...base, targetPath: join(base.providerRoot, 'identifier.sqlite'), sentinel: { ...base.sentinel, table: 'sentinel;DROP' } }, 'invalid_input'],
    ['missing schema', { ...base, targetPath: join(base.providerRoot, 'schema.sqlite'), expectedTables: ['sentinel', 'missing'] }, 'verification_failed'],
    ['corrupt source', { ...base, sourcePath: corrupt, targetPath: join(base.providerRoot, 'corrupt.sqlite') }, 'backup_failed'],
    ['sentinel mismatch', { ...base, targetPath: join(base.providerRoot, 'wrong.sqlite'), sentinel: { ...base.sentinel, value: 'wrong' } }, 'verification_failed'],
  ];

  // When / Then
  for (const [name, input, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(backupSQLite(input), error => error instanceof SQLiteBackupError && error.code === code);
      if (input.targetPath !== existing && input.targetPath !== input.sourcePath) await assert.rejects(stat(input.targetPath), { code: 'ENOENT' });
    });
  }
  assert.equal((await readFile(existing)).toString(), 'owned');
});

test('backupSQLite cancellation is bounded and leaves no target', async t => {
  // Given
  const input = await fixture();
  t.after(() => rm(input.directory, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();

  // When / Then
  await assert.rejects(backupSQLite({ ...input, signal: controller.signal }), error => error instanceof SQLiteBackupError && error.code === 'cancelled');
  await assert.rejects(stat(input.targetPath), { code: 'ENOENT' });
});

test('backupSQLite bounds a locked source and preserves its identity', async t => {
  // Given
  const input = await fixture();
  const locker = new DatabaseSync(input.sourcePath);
  locker.exec('BEGIN EXCLUSIVE');
  const started = Date.now();

  // When / Then
  try {
    await assert.rejects(
      backupSQLite({ ...input, timeoutMs: 75 }),
      error => error instanceof SQLiteBackupError && (error.code === 'timeout' || error.code === 'backup_failed'),
    );
    assert.ok(Date.now() - started < 2_000);
    await assert.rejects(stat(input.targetPath), { code: 'ENOENT' });
    assert.equal(locker.prepare('SELECT value FROM sentinel WHERE key=?').get('canary').value, 'raibit');
  } finally {
    locker.close();
    await rm(input.directory, { recursive: true, force: true });
  }
});

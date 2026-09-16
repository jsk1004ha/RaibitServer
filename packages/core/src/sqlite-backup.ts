import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite from 'node:sqlite';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

export type SQLiteBackupInput = {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly providerRoot: string;
  readonly timeoutMs: number;
  readonly expectedTables: readonly string[];
  readonly sentinel: {
    readonly table: string;
    readonly keyColumn: string;
    readonly valueColumn: string;
    readonly key: string;
    readonly value: string;
  };
  readonly signal?: AbortSignal;
};

export type SQLiteBackupReceipt = {
  readonly engine: 'sqlite';
  readonly truthLevel: 'L1';
  readonly method: 'VACUUM INTO';
  readonly integrity: 'ok';
  readonly schemaVerified: true;
  readonly sentinelVerified: true;
  readonly sourcePreserved: true;
  readonly targetFresh: true;
  readonly publishesReady: false;
  readonly artifactDisposition: 'requires-encrypted-upload';
  readonly checksumAlgorithm: 'sha256';
  readonly checksum: string;
  readonly bytes: number;
  readonly targetPath: string;
};

export type SQLiteBackupErrorCode = 'invalid_input' | 'target_exists' | 'cancelled' | 'timeout' | 'backup_failed' | 'verification_failed';

export class SQLiteBackupError extends Error {
  readonly name = 'SQLiteBackupError';
  readonly code: SQLiteBackupErrorCode;
  constructor(code: SQLiteBackupErrorCode, options?: ErrorOptions) {
    super(`SQLite backup failed: ${code}`, options);
    this.code = code;
  }
}

function runWorker(sourcePath: string, outputPath: string, timeoutMs: number): void {
  const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec(`PRAGMA busy_timeout=${timeoutMs}`);
    source.exec(`VACUUM INTO '${outputPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

if (process.argv[2] === '--sqlite-backup-worker') {
  try {
    runWorker(process.argv[3], process.argv[4], Number(process.argv[5]));
  } catch (error) {
    process.exitCode = error instanceof Error ? 1 : 2;
  }
}

function validate(input: SQLiteBackupInput): void {
  const identifiers = [input.sentinel.table, input.sentinel.keyColumn, input.sentinel.valueColumn, ...input.expectedTables];
  if (!path.isAbsolute(input.sourcePath) || !path.isAbsolute(input.targetPath) || !path.isAbsolute(input.providerRoot)
    || path.resolve(input.sourcePath) === path.resolve(input.targetPath) || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS || input.expectedTables.length === 0
    || !identifiers.every(name => IDENTIFIER.test(name)) || input.sentinel.key.length === 0 || input.sentinel.value.length === 0) {
    throw new SQLiteBackupError('invalid_input');
  }
}

async function assertFreshTarget(input: SQLiteBackupInput): Promise<void> {
  const [root, parent] = await Promise.all([fs.realpath(input.providerRoot), fs.realpath(path.dirname(input.targetPath))]);
  const relative = path.relative(root, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SQLiteBackupError('invalid_input');
  try {
    await fs.lstat(input.targetPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new SQLiteBackupError('backup_failed', { cause: error });
  }
  throw new SQLiteBackupError('target_exists');
}

async function boundedVacuum(sourcePath: string, outputPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SQLiteBackupError('cancelled');
  const modulePath = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const child = spawn(process.execPath, [modulePath, '--sqlite-backup-worker', sourcePath, outputPath, String(timeoutMs)], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let reason: SQLiteBackupErrorCode | undefined;
    const stop = (code: SQLiteBackupErrorCode) => {
      reason = code;
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => reject(new SQLiteBackupError('backup_failed', { cause: error })));
    child.once('exit', code => code === 0 && reason === undefined ? resolve() : reject(new SQLiteBackupError(reason ?? 'backup_failed')));
    child.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

async function checksum(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function verify(input: SQLiteBackupInput, outputPath: string): void {
  const target = new sqlite.DatabaseSync(outputPath, { readOnly: true });
  try {
    const integrity = target.prepare('PRAGMA integrity_check').get();
    const schemas = input.expectedTables.map(table => target.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table));
    const { table, keyColumn, valueColumn, key, value } = input.sentinel;
    const sentinel = target.prepare(`SELECT "${valueColumn}" AS value FROM "${table}" WHERE "${keyColumn}"=?`).get(key);
    if (integrity?.integrity_check !== 'ok' || schemas.some(schema => typeof schema?.sql !== 'string') || sentinel?.value !== value) {
      throw new SQLiteBackupError('verification_failed');
    }
  } finally {
    target.close();
  }
}

export async function backupSQLite(input: SQLiteBackupInput): Promise<SQLiteBackupReceipt> {
  validate(input);
  await assertFreshTarget(input);
  const sourceBefore = await fs.stat(input.sourcePath);
  const workRoot = await fs.mkdtemp(path.join(path.dirname(input.targetPath), '.raibit-backup-'));
  const outputPath = path.join(workRoot, 'artifact.sqlite');
  try {
    await boundedVacuum(input.sourcePath, outputPath, input.timeoutMs, input.signal);
    verify(input, outputPath);
    const [sourceAfter, output, digest] = await Promise.all([fs.stat(input.sourcePath), fs.stat(outputPath), checksum(outputPath)]);
    if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino) throw new SQLiteBackupError('verification_failed');
    await fs.chmod(outputPath, 0o400);
    try {
      await fs.link(outputPath, input.targetPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new SQLiteBackupError('target_exists');
      throw new SQLiteBackupError('backup_failed', { cause: error });
    }
    return { engine: 'sqlite', truthLevel: 'L1', method: 'VACUUM INTO', integrity: 'ok', schemaVerified: true, sentinelVerified: true, sourcePreserved: true, targetFresh: true, publishesReady: false, artifactDisposition: 'requires-encrypted-upload', checksumAlgorithm: 'sha256', checksum: digest, bytes: output.size, targetPath: input.targetPath };
  } catch (error) {
    if (error instanceof SQLiteBackupError) throw error;
    throw new SQLiteBackupError('backup_failed', { cause: error });
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

import { constants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { assertSafeArtifactWriter, isPrivateArtifactWriterMetadata } from './safe-artifact-writer.mjs';

const SAFE_PART = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const transactions = new WeakMap();
const activeTransaction = new AsyncLocalStorage();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
function fail(reason = 'invalid_journal') { throw new EvidenceError(reason); }

export const isPrivateJournalMetadata = (relativePath) => isPrivateArtifactWriterMetadata(relativePath)
  || /^(?:bindings\/\d{6}--[a-f0-9]{16}|cleanup-intents\/\d{6}--(?:intent|outcome)--[a-f0-9]{12})\.json\.(?:pending|commit)$/.test(relativePath);

export async function withJournalTransaction(writer, operation, runDirectory) {
  assertSafeArtifactWriter(writer, runDirectory);
  if (typeof operation !== 'function') fail();
  if (activeTransaction.getStore() === writer) return operation();
  const previous = transactions.get(writer) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  transactions.set(writer, gate);
  await previous;
  try { return await activeTransaction.run(writer, operation); }
  finally {
    release();
    if (transactions.get(writer) === gate) transactions.delete(writer);
  }
}

async function physicalDirectory(directory, create) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) fail();
  if (create) await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  });
  try {
    const [stat, resolved] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(resolved, directory)) fail();
    return Object.freeze({ path: directory, dev: stat.dev, ino: stat.ino });
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fail();
    throw error;
  }
}

async function physicalFile(file) {
  try {
    const [stat, resolved, bytes] = await Promise.all([lstat(file), realpath(file), readFile(file)]);
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(resolved, file) || bytes.length === 0) fail();
    return bytes;
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fail();
    throw error;
  }
}

async function optionalPhysicalFile(file) {
  try { await lstat(file); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  return physicalFile(file);
}

async function optionalPhysicalDirectory(directory) {
  try { await lstat(directory); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  await physicalDirectory(directory, false);
  return true;
}

export async function journalScope(runDirectory, identity, directoryName, create = false, unsafeFixture = false) {
  if (!unsafeFixture && (process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number')) fail('journal_platform_not_release_safe');
  if (!isRecord(identity) || typeof identity.runId !== 'string' || !SAFE_PART.test(identity.runId) || !SAFE_PART.test(directoryName)) fail();
  await physicalDirectory(runDirectory, false);
  let run;
  try { run = JSON.parse((await physicalFile(path.join(runDirectory, 'run.json'))).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail(); throw error; }
  if (!isRecord(run) || run.schema !== 'raibitserver.evidence-run/v1' || !isRecord(run.identity)
    || digest(run.identity) !== digest(identity) || path.basename(runDirectory) !== identity.runId) fail('identity_mismatch');
  const directory = path.join(runDirectory, directoryName);
  await physicalDirectory(directory, create);
  return Object.freeze({ directory, runIdentitySha256: digest(identity) });
}

export async function validateJournalRoot(runDirectory, identity, writer, unsafeFixture = false) {
  assertSafeArtifactWriter(writer, runDirectory);
  if (!unsafeFixture && (process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number')) fail('journal_platform_not_release_safe');
  if (!isRecord(identity) || typeof identity.runId !== 'string' || !SAFE_PART.test(identity.runId)) fail();
  await physicalDirectory(runDirectory, false);
  let run;
  try { run = JSON.parse((await physicalFile(path.join(runDirectory, 'run.json'))).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail(); throw error; }
  if (!isRecord(run) || run.schema !== 'raibitserver.evidence-run/v1' || !isRecord(run.identity)
    || digest(run.identity) !== digest(identity) || path.basename(runDirectory) !== identity.runId) fail('identity_mismatch');
}

export async function initializeJournalDirectories(runDirectory, identity, writer, unsafeFixture = false) {
  await validateJournalRoot(runDirectory, identity, writer, unsafeFixture);
  const directories = ['bindings', 'cleanup-intents'].map((name) => path.join(runDirectory, name));
  const present = await Promise.all(directories.map(optionalPhysicalDirectory));
  if (present[0] !== present[1]) fail('journal_write_poisoned');
  if (!present[0]) {
    for (const directory of directories) await physicalDirectory(directory, true);
    if (!unsafeFixture) {
      await syncDirectory(runDirectory);
      for (const directory of directories) await syncDirectory(directory);
    }
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function parseMarker(bytes, schema, relative, sha256) {
  let marker;
  try { marker = JSON.parse(bytes.toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail('journal_write_poisoned'); throw error; }
  if (!exactKeys(marker, ['schema', 'path', 'sha256']) || marker.schema !== schema || marker.path !== relative || marker.sha256 !== sha256) {
    fail('journal_write_poisoned');
  }
}

export async function exclusiveJournalWrite(runDirectory, relative, value, writer, unsafeFixture = false) {
  assertSafeArtifactWriter(writer, runDirectory);
  const parts = relative.split('/');
  const [directoryName, fileName] = parts;
  if (parts.length !== 2 || !SAFE_PART.test(fileName.replace(/\.json$/, '').replaceAll('--', '-')) || !fileName.endsWith('.json')) fail();
  assertRedacted(value);
  const directory = path.join(runDirectory, directoryName);
  const target = path.join(directory, fileName);
  const commitRelative = `${relative}.commit`; const pendingRelative = `${relative}.pending`;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const [existing, commit, pending] = await Promise.all([
    optionalPhysicalFile(target), optionalPhysicalFile(`${target}.commit`), optionalPhysicalFile(`${target}.pending`),
  ]);
  if (existing || commit || pending) {
    if (!existing || !commit || !pending || !existing.equals(bytes)) fail('journal_write_poisoned');
    parseMarker(commit, 'raibitserver.production-evidence-journal-commit/v1', relative, digest(existing));
    parseMarker(pending, 'raibitserver.production-evidence-journal-pending/v1', relative, digest(bytes));
    return Object.freeze({ path: target, sha256: digest(existing) });
  }
  try {
    await writer.writeJson(pendingRelative, { schema: 'raibitserver.production-evidence-journal-pending/v1', path: relative, sha256: digest(bytes) });
    if (!unsafeFixture) await syncDirectory(directory);
    await writer.writeJson(relative, value);
    if (!unsafeFixture) await syncDirectory(directory);
    await writer.writeJson(commitRelative, { schema: 'raibitserver.production-evidence-journal-commit/v1', path: relative, sha256: digest(bytes) });
    if (!unsafeFixture) await syncDirectory(directory);
  } catch { fail('journal_write_poisoned'); }
  const physical = await physicalFile(target);
  if (!physical.equals(bytes)) fail('journal_digest_mismatch');
  return Object.freeze({ path: target, sha256: digest(physical) });
}

export async function journalFiles(directory, pattern) {
  const before = await physicalDirectory(directory, false);
  const names = await readdir(directory);
  const records = names.filter((name) => !name.endsWith('.commit') && !name.endsWith('.pending'));
  if (records.some((name) => !pattern.test(name)) || names.length !== records.length * 3
    || records.some((name) => !names.includes(`${name}.commit`) || !names.includes(`${name}.pending`))) fail('journal_write_poisoned');
  const files = await Promise.all(records.sort().map(async (name) => {
    const relative = `${path.basename(directory)}/${name}`;
    const [bytes, commit, pending] = await Promise.all([
      physicalFile(path.join(directory, name)), physicalFile(path.join(directory, `${name}.commit`)), physicalFile(path.join(directory, `${name}.pending`)),
    ]);
    parseMarker(commit, 'raibitserver.production-evidence-journal-commit/v1', relative, digest(bytes));
    parseMarker(pending, 'raibitserver.production-evidence-journal-pending/v1', relative, digest(bytes));
    return { name, bytes };
  }));
  const after = await physicalDirectory(directory, false);
  if (before.dev !== after.dev || before.ino !== after.ino) fail();
  return files;
}

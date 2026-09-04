import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';

const SAFE_PART = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function fail(reason = 'invalid_journal') { throw new EvidenceError(reason); }
function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  return value;
}

async function physicalDirectory(directory, create) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) fail();
  if (create) await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  });
  try {
    const [stat, resolved] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(resolved, directory)) fail();
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

export async function journalScope(runDirectory, identity, directoryName, create = false) {
  if (!isRecord(identity) || typeof identity.runId !== 'string' || !SAFE_PART.test(identity.runId) || !SAFE_PART.test(directoryName)) fail();
  await physicalDirectory(runDirectory, false);
  const runFile = path.join(runDirectory, 'run.json');
  let run;
  try { run = JSON.parse((await physicalFile(runFile)).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail(); throw error; }
  if (!isRecord(run) || run.schema !== 'raibitserver.evidence-run/v1' || !isRecord(run.identity)
    || digest(run.identity) !== digest(identity) || path.basename(runDirectory) !== identity.runId) fail('identity_mismatch');
  const directory = path.join(runDirectory, directoryName);
  if (create) await physicalDirectory(directory, true);
  else await physicalDirectory(directory, false);
  return Object.freeze({ directory, runIdentitySha256: digest(identity) });
}

export async function exclusiveJournalWrite(directory, fileName, value) {
  if (!SAFE_PART.test(fileName.replace(/\.json$/, '').replaceAll('--', '-')) || !fileName.endsWith('.json')) fail();
  assertRedacted(value);
  const target = path.join(directory, fileName);
  if (!samePath(path.dirname(target), directory)) fail();
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  let handle;
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await physicalFile(target);
    if (!existing.equals(bytes)) fail('journal_digest_mismatch');
    return Object.freeze({ path: target, sha256: digest(existing) });
  } finally {
    if (handle) await handle.close();
  }
  const physical = await physicalFile(target);
  if (!physical.equals(bytes)) fail('journal_digest_mismatch');
  return Object.freeze({ path: target, sha256: digest(physical) });
}

export async function journalFiles(directory, pattern) {
  const names = await readdir(directory);
  if (names.some((name) => !pattern.test(name))) fail();
  return Promise.all(names.sort().map(async (name) => ({ name, bytes: await physicalFile(path.join(directory, name)) })));
}

function parseBinding(record, expected, parsePayload) {
  const keys = ['schema', 'sequence', 'runIdentitySha256', 'role', 'bindingId', 'payload', 'payloadSha256', 'createdAt', 'entrySha256'];
  if (!exactKeys(record, keys) || record.schema !== 'raibitserver.production-evidence-binding/v1'
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.runIdentitySha256 !== expected
    || !SAFE_PART.test(record.role) || !SAFE_PART.test(record.bindingId) || !isIso(record.createdAt)
    || !SHA256.test(record.payloadSha256) || record.payloadSha256 !== digest(record.payload) || !SHA256.test(record.entrySha256)) fail();
  const { entrySha256, ...unsigned } = record;
  if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
  assertRedacted(record);
  const parsedPayload = parsePayload(record.payload);
  if (parsedPayload === undefined || digest(parsedPayload) !== digest(record.payload)) fail();
  return immutable({ ...record, payload: parsedPayload });
}

async function readBindings(options, create = false) {
  const parsePayload = options.parsePayload ?? ((value) => value);
  if (typeof parsePayload !== 'function') fail();
  const scope = await journalScope(options.runDirectory, options.identity, 'bindings', create);
  const files = await journalFiles(scope.directory, /^\d{6}--[a-z0-9][a-z0-9._-]{0,127}--[a-z0-9][a-z0-9._-]{0,127}\.json$/);
  const entries = [];
  const keys = new Set();
  for (const [index, file] of files.entries()) {
    let raw;
    try { raw = JSON.parse(file.bytes.toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(); throw error; }
    const entry = parseBinding(raw, scope.runIdentitySha256, parsePayload);
    const expectedName = `${String(entry.sequence).padStart(6, '0')}--${entry.role}--${entry.bindingId}.json`;
    const logicalKey = `${entry.role}:${entry.bindingId}`;
    if (entry.sequence !== index + 1 || file.name !== expectedName || keys.has(logicalKey)
      || (index > 0 && Date.parse(entry.createdAt) <= Date.parse(entries[index - 1].createdAt))
      || !file.bytes.equals(Buffer.from(`${JSON.stringify(raw)}\n`))) fail();
    keys.add(logicalKey); entries.push(entry);
  }
  return { scope, entries: Object.freeze(entries), files };
}

export async function loadBindings(options) { return (await readBindings(options)).entries; }

export async function appendBinding(options) {
  const required = ['runDirectory', 'identity', 'role', 'bindingId', 'payload', 'createdAt'];
  if (!isRecord(options) || Object.keys(options).some((key) => ![...required, 'parsePayload'].includes(key))
    || required.some((key) => !Object.hasOwn(options, key))
    || !SAFE_PART.test(options.role) || !SAFE_PART.test(options.bindingId) || !isIso(options.createdAt)) fail();
  const parsePayload = options.parsePayload ?? ((value) => value);
  if (typeof parsePayload !== 'function') fail();
  const payload = parsePayload(options.payload);
  if (payload === undefined || digest(payload) !== digest(options.payload)) fail();
  assertRedacted(payload);
  const loaded = await readBindings(options, true);
  const existingIndex = loaded.entries.findIndex((entry) => entry.role === options.role && entry.bindingId === options.bindingId);
  if (existingIndex >= 0) {
    const existing = loaded.entries[existingIndex];
    if (existing.createdAt !== options.createdAt || digest(existing.payload) !== digest(payload)) fail('binding_conflict');
    return Object.freeze({ path: path.join(loaded.scope.directory, loaded.files[existingIndex].name), sha256: digest(loaded.files[existingIndex].bytes), entry: existing });
  }
  if (loaded.entries.length > 0 && Date.parse(options.createdAt) <= Date.parse(loaded.entries.at(-1).createdAt)) fail();
  const unsigned = { schema: 'raibitserver.production-evidence-binding/v1', sequence: loaded.entries.length + 1,
    runIdentitySha256: loaded.scope.runIdentitySha256, role: options.role, bindingId: options.bindingId,
    payload, payloadSha256: digest(payload), createdAt: options.createdAt };
  const entry = immutable({ ...unsigned, entrySha256: digest(unsigned) });
  const name = `${String(entry.sequence).padStart(6, '0')}--${entry.role}--${entry.bindingId}.json`;
  return Object.freeze({ ...(await exclusiveJournalWrite(loaded.scope.directory, name, entry)), entry });
}

export async function bindingJournalSnapshot(options) {
  const entries = await loadBindings(options);
  return immutable({ schema: 'raibitserver.production-evidence-binding-journal-snapshot/v1',
    runIdentitySha256: digest(options.identity), entryCount: entries.length, entriesSha256: digest(entries) });
}

export function reduceBindings(entries) {
  const reduced = {};
  for (const entry of entries) {
    const key = `${entry.role}:${entry.bindingId}`;
    if (Object.hasOwn(reduced, key)) fail('binding_conflict');
    reduced[key] = entry.payload;
  }
  return immutable(reduced);
}

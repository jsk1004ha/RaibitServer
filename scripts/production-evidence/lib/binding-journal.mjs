import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { exclusiveJournalWrite, journalFiles, journalScope, withJournalTransaction } from './journal-io.mjs';
import { parseEvidenceBindingPayload } from './binding-graph.mjs';
export { resolveBindingGraph } from './binding-graph.mjs';
export { isPrivateJournalMetadata } from './journal-io.mjs';
export { isPrivateArtifactWriterMetadata } from './safe-artifact-writer.mjs';

const SAFE_PART = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function fail(reason = 'invalid_journal') { throw new EvidenceError(reason); }
function validateReadOptions(options) {
  if (!exactKeys(options, ['runDirectory', 'identity', 'writer'])) fail();
}
function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  return value;
}

export function parseEvidenceBindingEntry(record, expected) {
  const keys = ['schema', 'sequence', 'runIdentitySha256', 'role', 'bindingId', 'payload', 'payloadSha256', 'createdAt', 'entrySha256'];
  if (!exactKeys(record, keys) || record.schema !== 'raibitserver.production-evidence-binding/v1'
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.runIdentitySha256 !== expected
    || !SAFE_PART.test(record.role) || !SAFE_PART.test(record.bindingId) || !isIso(record.createdAt)
    || !SHA256.test(record.payloadSha256) || record.payloadSha256 !== digest(record.payload) || !SHA256.test(record.entrySha256)) fail();
  const { entrySha256, ...unsigned } = record;
  if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
  assertRedacted(record);
  const parsedPayload = parseEvidenceBindingPayload(record.payload);
  return immutable({ ...record, payload: parsedPayload });
}

async function readBindings(options, create = false) {
  const scope = await journalScope(options.runDirectory, options.identity, 'bindings', create, options.unsafeFixture === true);
  const files = await journalFiles(scope.directory, /^\d{6}--[a-f0-9]{16}\.json$/);
  const entries = [];
  const keys = new Set();
  for (const [index, file] of files.entries()) {
    let raw;
    try { raw = JSON.parse(file.bytes.toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(); throw error; }
    const entry = parseEvidenceBindingEntry(raw, scope.runIdentitySha256);
    const expectedName = `${String(entry.sequence).padStart(6, '0')}--${entry.entrySha256.slice(0, 16)}.json`;
    const logicalKey = `${entry.role}:${entry.bindingId}`;
    if (entry.sequence !== index + 1 || file.name !== expectedName || keys.has(logicalKey)
      || (index > 0 && Date.parse(entry.createdAt) <= Date.parse(entries[index - 1].createdAt))
      || !file.bytes.equals(Buffer.from(`${JSON.stringify(raw)}\n`))) fail();
    keys.add(logicalKey); entries.push(entry);
  }
  return { scope, entries: Object.freeze(entries), files };
}

async function load(options) { return (await readBindings(options)).entries; }
export async function loadBindings(options) {
  validateReadOptions(options);
  return withJournalTransaction(options?.writer, () => load({ ...options, unsafeFixture: false }), options?.runDirectory);
}
export async function loadBindingsFixtureUnsafe(options) {
  validateReadOptions(options);
  return withJournalTransaction(options?.writer, () => load({ ...options, unsafeFixture: true }), options?.runDirectory);
}

async function append(options) {
  const required = ['runDirectory', 'identity', 'role', 'bindingId', 'payload', 'createdAt'];
  if (!isRecord(options) || Object.keys(options).some((key) => ![...required, 'unsafeFixture', 'writer'].includes(key))
    || required.some((key) => !Object.hasOwn(options, key))
    || !SAFE_PART.test(options.role) || !SAFE_PART.test(options.bindingId) || !isIso(options.createdAt)) fail();
  const payload = parseEvidenceBindingPayload(options.payload);
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
  const name = `${String(entry.sequence).padStart(6, '0')}--${entry.entrySha256.slice(0, 16)}.json`;
  return Object.freeze({ ...(await exclusiveJournalWrite(options.runDirectory, `bindings/${name}`, entry, options.writer, options.unsafeFixture === true)), entry });
}
export async function appendBinding(options) {
  return withJournalTransaction(options?.writer, () => append({ ...options, unsafeFixture: false }), options?.runDirectory);
}
export async function appendBindingFixtureUnsafe(options) {
  return withJournalTransaction(options?.writer, () => append({ ...options, unsafeFixture: true }), options?.runDirectory);
}

async function snapshot(options) {
  const entries = await load(options);
  return immutable({ schema: 'raibitserver.production-evidence-binding-journal-snapshot/v1',
    runIdentitySha256: digest(options.identity), entryCount: entries.length, entriesSha256: digest(entries) });
}
export async function bindingJournalSnapshot(options) {
  validateReadOptions(options);
  return withJournalTransaction(options?.writer, () => snapshot({ ...options, unsafeFixture: false }), options?.runDirectory);
}
export async function bindingJournalSnapshotFixtureUnsafe(options) {
  validateReadOptions(options);
  return withJournalTransaction(options?.writer, () => snapshot({ ...options, unsafeFixture: true }), options?.runDirectory);
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

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ProductionEvidenceSchema, VerifiedBindingJournalSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { parseEvidenceBindingEntry } from './binding-journal.mjs';
import { parseCleanupIntentRecord, parseCleanupOutcomeRecord, validateIntentScope } from './binding-graph.mjs';
import { journalFiles } from './journal-io.mjs';
import { loadReceiptState, verifyCandidateArtifacts } from './receipt-authority-files.mjs';
import { STEP_NAMES } from './step-contract.mjs';
import { verifyReceiptProvenance } from './receipt-provenance.mjs';
import { snapshotJournalData } from './journal-data-snapshot.mjs';

const fail = (reason) => { throw new EvidenceError(reason); };
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
export const SEAL_FILE = 'evidence-seal.json';

export async function durableBytes(file, fixture) {
  if (!fixture && (process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number')) fail('receipt_platform_not_release_safe');
  const target = path.resolve(file), before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !same(await realpath(target), target)
    || before.size < 1 || before.size > 4 * 1024 * 1024) fail('invalid_durable_file');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) fail('invalid_durable_file');
    const bytes = await handle.readFile(), after = await lstat(target);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length || after.mtimeMs !== opened.mtimeMs
      || !same(await realpath(target), target)) fail('invalid_durable_file');
    return bytes;
  } finally { await handle.close(); }
}

export function durableJson(bytes) {
  assertRedacted(bytes.toString('utf8'));
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail('invalid_durable_file'); throw error; }
}

export async function inventoryDurableRun(root, fixture) {
  const files = [], values = new Map();
  let totalBytes = 0;
  async function visit(relative) {
    const directory = path.join(root, relative), before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || !same(await realpath(directory), directory)) fail('invalid_durable_file');
    for (const name of (await readdir(directory)).sort()) {
      if (!relative && [SEAL_FILE, '.raibit-evidence-writer-session'].includes(name)) continue;
      if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name) || (!relative && name === 'work')) fail('invalid_durable_file');
      const child = relative ? `${relative}/${name}` : name, target = path.join(root, child), stat = await lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { await visit(child); continue; }
      const bytes = await durableBytes(target, fixture); totalBytes += bytes.length;
      if (files.length >= 4096 || totalBytes > 64 * 1024 * 1024) fail('durable_evidence_limit');
      const value = durableJson(bytes);
      if (!fixture && /"fixture"\s*:\s*true/.test(bytes.toString('utf8'))) fail('fixture_not_release_evidence');
      files.push({ path: child, sha256: digest(bytes), bytes: bytes.length }); values.set(child, value);
    }
    const after = await lstat(directory);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) fail('invalid_durable_file');
  }
  await visit('');
  return { files: files.sort((left, right) => left.path.localeCompare(right.path)), values };
}

async function readBindingEntries(root, identity) {
  const files = await journalFiles(path.join(root, 'bindings'), /^\d{6}--[a-f0-9]{16}\.json$/), entries = [], keys = new Set();
  for (const [index, file] of files.entries()) {
    const raw = durableJson(file.bytes), entry = parseEvidenceBindingEntry(raw, digest(identity)), key = `${entry.role}:${entry.bindingId}`;
    if (entry.sequence !== index + 1 || file.name !== `${String(entry.sequence).padStart(6, '0')}--${entry.entrySha256.slice(0, 16)}.json`
      || keys.has(key) || (index && Date.parse(entry.createdAt) <= Date.parse(entries.at(-1).createdAt))
      || !file.bytes.equals(Buffer.from(`${JSON.stringify(raw)}\n`))) fail('invalid_journal');
    keys.add(key); entries.push(entry);
  }
  return entries;
}

async function readCleanupEntries(root, { identity, bindings, operatorInputs }) {
  const files = await journalFiles(path.join(root, 'cleanup-intents'), /^\d{6}--(?:intent|outcome)--[a-f0-9]{12}\.json$/);
  const entries = [], intents = new Map(), outcomes = new Set();
  let previousAt = 0;
  for (const [index, file] of files.entries()) {
    const raw = durableJson(file.bytes);
    const entry = raw.entryType === 'intent' ? parseCleanupIntentRecord(raw, digest(identity)) : parseCleanupOutcomeRecord(raw, digest(identity));
    const at = Date.parse(entry.createdAt ?? entry.resolvedAt);
    if (entry.sequence !== index + 1 || file.name !== `${String(entry.sequence).padStart(6, '0')}--${entry.entryType}--${entry.entrySha256.slice(0, 12)}.json`
      || at <= previousAt || !file.bytes.equals(Buffer.from(`${JSON.stringify(raw)}\n`))) fail('invalid_journal');
    if (entry.entryType === 'intent') {
      if (intents.has(entry.intentId) || entry.bindingEntryCount > bindings.length) fail('intent_conflict');
      const prefix = bindings.slice(0, entry.bindingEntryCount);
      if (digest(prefix) !== entry.bindingsDigest) fail('invalid_binding_reference');
      const runtime = entry.approvedRuntimeSelectorSha256 === null ? null : { context: operatorInputs.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT,
        namespace: operatorInputs.secretRefs.find(reference => reference.role === 'runtime')?.namespace };
      const expected = validateIntentScope({ ...entry, identity, approvedRuntimeSelector: runtime }, prefix);
      if (expected.runtimeDigest !== entry.approvedRuntimeSelectorSha256) fail('invalid_binding_reference');
      intents.set(entry.intentId, entry);
    } else {
      const intent = intents.get(entry.intentId);
      if (!intent || outcomes.has(entry.intentId) || entry.intentEntrySha256 !== intent.entrySha256 || at > Date.parse(intent.deadlineAt)) fail('outcome_conflict');
      outcomes.add(entry.intentId);
    }
    previousAt = at; entries.push(entry);
  }
  if (intents.size !== outcomes.size) fail('unresolved_cleanup_intent');
  return entries;
}

export async function readDurableEvidence(root, { fixture, operatorInputs }) {
  const inventory = await inventoryDurableRun(root, fixture);
  const parsed = ProductionEvidenceSchema.safeParse(inventory.values.get('manifest.json'));
  if (!parsed.success) fail('invalid_schema');
  const manifest = parsed.data, run = inventory.values.get('run.json');
  if (manifest.fixture !== fixture || path.basename(root) !== manifest.identity.runId || run?.schema !== 'raibitserver.evidence-run/v1'
    || digest(run.identity) !== digest(manifest.identity) || run.startedAt !== manifest.startedAt) fail('identity_mismatch');
  const state = await loadReceiptState(root, manifest.identity, fixture);
  if (state.entries.length !== STEP_NAMES.length || state.preparations.length !== state.entries.length) fail('incomplete_receipt_authority');
  const observations = [];
  const declared = new Map(manifest.fragments.flatMap(fragment => fragment.artifacts.map(artifact => [artifact.path, artifact.sha256])));
  for (const record of state.receipts) {
    if (record.receipt.fixture !== fixture || record.receipt.status !== 'PASS' || record.receipt.assertions.some(row => row.status !== 'PASS')
      || Date.parse(record.receipt.startedAt) < Date.parse(manifest.startedAt) || Date.parse(record.receipt.observedAt) > Date.parse(manifest.observedAt)) fail('incomplete_receipt_authority');
    for (const artifact of [record.descriptor, ...record.receipt.artifacts]) if (declared.get(artifact.path) !== artifact.sha256) fail('artifact_digest_mismatch');
    observations.push(...await verifyCandidateArtifacts(root, record.receipt, fixture));
  }
  for (const fragment of manifest.fragments) {
    if (digest(inventory.values.get(`${fragment.component}.json`)) !== digest(fragment)) fail('identity_mismatch');
    for (const artifact of fragment.artifacts) if (!inventory.files.some(file => file.path === artifact.path && file.sha256 === artifact.sha256)) fail('artifact_digest_mismatch');
  }
  const bindings = await readBindingEntries(root, manifest.identity), cleanup = await readCleanupEntries(root, { identity: manifest.identity, bindings, operatorInputs });
  const payloads = bindings.map(entry => entry.payload), journal = { schema: 'raibitserver.production-evidence-binding-journal-snapshot/v1', runIdentitySha256: digest(manifest.identity), entryCount: bindings.length, entriesSha256: digest(bindings) };
  let verifiedBindingJournal = null;
  if (bindings.length || !fixture) {
    const entries = payloads.filter(value => !value.kind.endsWith('-observation'));
    const parsed = VerifiedBindingJournalSchema.safeParse({ schema: 'raibitserver.verified-binding-journal/v1', journal, identityDigest: digest(manifest.identity), bindingsDigest: digest(entries), entries, observations: payloads.filter(value => value.kind.endsWith('-observation')) });
    if (!parsed.success) fail('invalid_binding_journal');
    verifiedBindingJournal = snapshotJournalData(parsed.data);
    verifyReceiptProvenance({ receipts: state.receipts, observations }, verifiedBindingJournal);
  }
  return { ...inventory, manifest, verifiedBindingJournal, committedReceiptsSha256: digest(state.receipts.map(record => ({ step: record.receipt.step,
    requestSha256: record.entry.requestSha256, receipt: record.receipt, descriptor: record.descriptor }))),
    receiptJournalSha256: digest(state.entries), bindingJournalSha256: digest(bindings), cleanupJournalSha256: digest(cleanup) };
}

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { exclusiveJournalWrite, journalFiles, journalScope } from './journal-io.mjs';
import { ALL_STEP_NAMES, parseStepReceipt, assertStepReceiptTimeBounds, stepNamesForIdentity } from './step-contract.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const PREPARATION = /^(\d{6})--([a-z-]+)\.json$/;
const RECEIPT = /^(\d{6})--([a-z-]+)\.json$/;
const STEP_BUDGET_MS = Object.freeze({
  'auth-source': 60_000, 'supply-chain': 45 * 60_000, runtime: 13 * 60_000, observability: 5 * 60_000,
  resources: 30 * 60_000, 'backup-sql': 30 * 60_000, 'backup-nosql': 30 * 60_000,
  preview: 10 * 60_000, rollback: 10 * 60_000, cleanup: 30_000,
  domains: 45 * 60_000,
});
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const fail = (reason) => { throw new EvidenceError(reason); };

export function receiptPath(step) {
  if (!ALL_STEP_NAMES.includes(step)) fail('invalid_step_contract');
  const component = ['resources', 'backup-sql', 'backup-nosql'].includes(step) ? 'resources'
    : step === 'rollback' ? 'operations' : step === 'domains' ? 'domains' : step === 'cleanup' ? 'cleanup' : 'lifecycle';
  return step === 'cleanup' ? 'cleanup/cleanup.json' : `artifacts/${component}/${step}.json`;
}

async function physicalBytes(root, relative, unsafeFixture, missingReason = 'missing_receipt') {
  if (!unsafeFixture && (process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number')) fail('receipt_platform_not_release_safe');
  const target = path.resolve(root, ...relative.split('/'));
  const within = path.relative(root, target);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) fail('invalid_receipt');
  let before; let resolved; let handle;
  try {
    [before, resolved] = await Promise.all([lstat(target), realpath(target)]);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (!unsafeFixture && (before.mode & 0o077) !== 0)
      || !samePath(resolved, target)) fail('invalid_receipt');
    handle = await open(target, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) fail('invalid_receipt');
    const bytes = await handle.readFile();
    const after = await lstat(target);
    if (!bytes.length || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || !samePath(await realpath(target), target)) fail('invalid_receipt');
    return bytes;
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fail(missingReason);
    fail('invalid_receipt');
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function exists(root, relative) {
  try { await lstat(path.join(root, ...relative.split('/'))); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

function parseJson(bytes, reason) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail(reason); throw error; }
}

function containsPrivateMarker(value) {
  if (Array.isArray(value)) return value.some(containsPrivateMarker);
  return value !== null && typeof value === 'object'
    && Object.entries(value).some(([key, child]) => /private|session|marker/i.test(key) || containsPrivateMarker(child));
}

function parsePreparation(value, index, previous, identity, stepNames) {
  const keys = ['schema', 'sequence', 'step', 'runIdentitySha256', 'operatorInputFingerprint', 'requestSha256', 'startedAt', 'deadlineAt', 'previousEntrySha256', 'entrySha256'];
  if (!exact(value, keys) || value.schema !== 'raibitserver.production-evidence-receipt-preparation/v1'
    || value.sequence !== index + 1 || value.step !== stepNames[index] || value.runIdentitySha256 !== digest(identity)
    || value.operatorInputFingerprint !== identity.operatorInputFingerprint || !SHA256.test(value.requestSha256)
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt
    || typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt
    || Date.parse(value.deadlineAt) <= Date.parse(value.startedAt)
    || Date.parse(value.deadlineAt) - Date.parse(value.startedAt) > STEP_BUDGET_MS[value.step]
    || value.previousEntrySha256 !== previous) fail('invalid_receipt_journal');
  const { entrySha256, ...unsigned } = value;
  if (!SHA256.test(entrySha256) || entrySha256 !== digest(unsigned)) fail('receipt_digest_mismatch');
  return value;
}

function parseReceiptEntry(value, index, previous, preparation, identitySha256, stepNames) {
  const keys = ['schema', 'sequence', 'step', 'runIdentitySha256', 'requestSha256', 'preparationEntrySha256', 'receiptPath', 'receiptSha256', 'previousEntrySha256', 'entrySha256'];
  if (!exact(value, keys) || value.schema !== 'raibitserver.production-evidence-receipt-entry/v1'
    || value.sequence !== index + 1 || value.step !== stepNames[index] || value.runIdentitySha256 !== identitySha256
    || value.requestSha256 !== preparation.requestSha256 || value.preparationEntrySha256 !== preparation.entrySha256
    || value.receiptPath !== receiptPath(value.step) || !SHA256.test(value.receiptSha256)
    || value.previousEntrySha256 !== previous) fail('invalid_receipt_journal');
  const { entrySha256, ...unsigned } = value;
  if (!SHA256.test(entrySha256) || entrySha256 !== digest(unsigned)) fail('receipt_digest_mismatch');
  return value;
}

export async function initializeReceiptDirectories(runDirectory, identity, unsafeFixture) {
  await journalScope(runDirectory, identity, 'receipt-requests', true, unsafeFixture);
  await journalScope(runDirectory, identity, 'receipts', true, unsafeFixture);
}

export async function loadReceiptState(runDirectory, identity, unsafeFixture) {
  const identitySha256 = digest(identity);
  const stepNames = stepNamesForIdentity(identity);
  const preparationsDirectory = (await journalScope(runDirectory, identity, 'receipt-requests', false, unsafeFixture)).directory;
  const receiptsDirectory = (await journalScope(runDirectory, identity, 'receipts', false, unsafeFixture)).directory;
  const [preparationFiles, receiptFiles] = await Promise.all([journalFiles(preparationsDirectory, PREPARATION), journalFiles(receiptsDirectory, RECEIPT)]);
  if (preparationFiles.length > stepNames.length || receiptFiles.length > preparationFiles.length
    || preparationFiles.length > receiptFiles.length + 1) fail('invalid_receipt_journal');
  let previous = null;
  const preparations = preparationFiles.map(({ name, bytes }, index) => {
    if (name !== `${String(index + 1).padStart(6, '0')}--${stepNames[index]}.json`) fail('invalid_receipt_order');
    const entry = parsePreparation(parseJson(bytes, 'invalid_receipt_journal'), index, previous, identity, stepNames);
    previous = entry.entrySha256; return entry;
  });
  previous = null;
  const entries = receiptFiles.map(({ name, bytes }, index) => {
    if (name !== `${String(index + 1).padStart(6, '0')}--${stepNames[index]}.json`) fail('invalid_receipt_order');
    const entry = parseReceiptEntry(parseJson(bytes, 'invalid_receipt_journal'), index, previous, preparations[index], identitySha256, stepNames);
    previous = entry.entrySha256; return entry;
  });
  const receipts = [];
  for (const [index, entry] of entries.entries()) {
    const bytes = await physicalBytes(runDirectory, entry.receiptPath, unsafeFixture);
    if (digest(bytes) !== entry.receiptSha256) fail('receipt_digest_mismatch');
    const receipt = parseStepReceipt(parseJson(bytes, 'invalid_step_contract'));
    assertStepReceiptTimeBounds(receipt, preparations[index].deadlineAt);
    if (receipt.startedAt !== preparations[index].startedAt) fail('invalid_receipt_journal');
    if (receipt.schema !== 'raibitserver.production-evidence-step-receipt/v2' || receipt.step !== entry.step
      || receipt.requestSha256 !== entry.requestSha256 || digest(receipt.identity) !== identitySha256) fail('identity_mismatch');
    receipts.push({ preparation: preparations[index], entry, receipt, descriptor: { path: entry.receiptPath, sha256: entry.receiptSha256, redacted: true } });
  }
  for (const [index, step] of stepNames.entries()) {
    if ((await exists(runDirectory, receiptPath(step))) !== (index < entries.length)) fail('invalid_receipt_journal');
  }
  return { preparations, entries, receipts };
}

export async function appendPreparation(runDirectory, value, writer, unsafeFixture) {
  return exclusiveJournalWrite(runDirectory, `receipt-requests/${String(value.sequence).padStart(6, '0')}--${value.step}.json`, value, writer, unsafeFixture);
}

export async function appendReceiptEntry(runDirectory, value, writer, unsafeFixture) {
  return exclusiveJournalWrite(runDirectory, `receipts/${String(value.sequence).padStart(6, '0')}--${value.step}.json`, value, writer, unsafeFixture);
}

export async function verifyCandidateArtifacts(runDirectory, receipt, unsafeFixture) {
  const descriptors = new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact]));
  if (descriptors.size !== receipt.artifacts.length) fail('invalid_receipt_artifact');
  const observations = [];
  for (const assertion of receipt.assertions) {
    const owner = assertion.id;
    for (const referencedPath of assertion.artifactPaths) {
    const artifact = descriptors.get(referencedPath);
    if (!artifact || artifact.path === receiptPath(receipt.step)
      || !/^(?:artifacts\/(?:lifecycle|resources|operations|domains)\/|cleanup\/)[a-z0-9][a-z0-9_-]*\.json$/.test(artifact.path)) fail('invalid_receipt_artifact');
    const bytes = await physicalBytes(runDirectory, artifact.path, unsafeFixture, 'missing_receipt_artifact');
    if (bytes.length > 1024 * 1024 || digest(bytes) !== artifact.sha256) fail('receipt_artifact_digest_mismatch');
    const value = parseJson(bytes, 'invalid_receipt_artifact');
    assertRedacted(value);
    if (containsPrivateMarker(value)) fail('invalid_receipt_artifact');
    if (value.step !== undefined && value.step !== receipt.step) fail('invalid_receipt_artifact');
    if (value.schema === 'raibitserver.production-evidence-observation/v1'
      && (value.step !== receipt.step || value.assertion !== assertion.id || value.status !== assertion.status)) fail('invalid_receipt_artifact');
    observations.push({ step: receipt.step, assertion: owner, descriptor: artifact, value });
    }
  }
  return observations;
}

import path from 'node:path';
import { assertRedacted, digest, EvidenceError } from './operator-inputs.mjs';
import { bindingJournalSnapshot, exclusiveJournalWrite, journalFiles, journalScope } from './binding-journal.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROUTE = /^\/apis?\/[A-Za-z0-9._~:/-]+$/;
const MUTATION_KINDS = Object.freeze(new Set([
  'control-plane-create-project', 'control-plane-import-repository', 'control-plane-create-deployment', 'control-plane-create-resource',
  'control-plane-rollback', 'control-plane-preview-cleanup', 'control-plane-delete-project', 'control-plane-delete-resource',
  'kubernetes-apply-pod', 'kubernetes-apply-network-policy',
]));

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function fail(reason = 'invalid_journal') { throw new EvidenceError(reason); }
function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  return value;
}
function validSelector(value) {
  return isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) => SAFE_ID.test(key)
    && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') && String(item).length > 0 && String(item).length <= 256);
}
function validRoute(value) {
  if (typeof value !== 'string' || !ROUTE.test(value) || value.includes('//') || value.includes('%') || value.includes('?') || value.includes('#')) return false;
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}
function parseIntent(record, expectedIdentityDigest, parsePayload) {
  const keys = ['schema', 'entryType', 'sequence', 'runIdentitySha256', 'intentId', 'mutationKind', 'organizationId', 'projectId',
    'resourceName', 'relativeRoute', 'recoverySelector', 'createdAt', 'deadlineAt', 'selectorSha256', 'entrySha256'];
  if (!exactKeys(record, keys) || record.schema !== 'raibitserver.production-evidence-cleanup-journal/v1' || record.entryType !== 'intent'
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.runIdentitySha256 !== expectedIdentityDigest
    || !SAFE_NAME.test(record.intentId) || !MUTATION_KINDS.has(record.mutationKind) || !SAFE_ID.test(record.organizationId)
    || !SAFE_ID.test(record.projectId) || !SAFE_NAME.test(record.resourceName) || !validRoute(record.relativeRoute)
    || !validSelector(record.recoverySelector) || !isIso(record.createdAt) || !isIso(record.deadlineAt)
    || Date.parse(record.deadlineAt) <= Date.parse(record.createdAt) || !SHA256.test(record.selectorSha256)
    || record.selectorSha256 !== digest(record.recoverySelector) || !SHA256.test(record.entrySha256)) fail();
  const { entrySha256, ...unsigned } = record;
  if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
  assertRedacted(record);
  const parsed = parsePayload(record);
  if (parsed === undefined || digest(parsed) !== digest(record)) fail();
  return immutable(parsed);
}
function parseOutcome(record, expectedIdentityDigest, parsePayload) {
  const keys = ['schema', 'entryType', 'sequence', 'runIdentitySha256', 'intentId', 'intentEntrySha256', 'actualId', 'actualUid',
    'responseSha256', 'resolvedAt', 'entrySha256'];
  if (!exactKeys(record, keys) || record.schema !== 'raibitserver.production-evidence-cleanup-journal/v1' || record.entryType !== 'outcome'
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.runIdentitySha256 !== expectedIdentityDigest
    || !SAFE_NAME.test(record.intentId) || !SHA256.test(record.intentEntrySha256) || !SAFE_ID.test(record.actualId)
    || !(record.actualUid === null || SAFE_ID.test(record.actualUid)) || !SHA256.test(record.responseSha256)
    || !isIso(record.resolvedAt) || !SHA256.test(record.entrySha256)) fail();
  const { entrySha256, ...unsigned } = record;
  if (entrySha256 !== digest(unsigned)) fail('journal_digest_mismatch');
  assertRedacted(record);
  const parsed = parsePayload(record);
  if (parsed === undefined || digest(parsed) !== digest(record)) fail();
  return immutable(parsed);
}

async function readCleanup(options, create = false) {
  const parseIntentPayload = options.parseIntent ?? ((value) => value);
  const parseOutcomePayload = options.parseOutcome ?? ((value) => value);
  if (typeof parseIntentPayload !== 'function' || typeof parseOutcomePayload !== 'function') fail();
  const scope = await journalScope(options.runDirectory, options.identity, 'cleanup-intents', create);
  const files = await journalFiles(scope.directory, /^\d{6}--(?:intent|outcome)--[a-z0-9][a-z0-9.-]{0,127}\.json$/);
  const entries = [];
  const intents = new Map();
  const outcomes = new Map();
  let previousAt = 0;
  for (const [index, file] of files.entries()) {
    let raw;
    try { raw = JSON.parse(file.bytes.toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail(); throw error; }
    const entry = raw?.entryType === 'intent' ? parseIntent(raw, scope.runIdentitySha256, parseIntentPayload)
      : raw?.entryType === 'outcome' ? parseOutcome(raw, scope.runIdentitySha256, parseOutcomePayload) : fail();
    const at = Date.parse(entry.entryType === 'intent' ? entry.createdAt : entry.resolvedAt);
    const expectedName = `${String(entry.sequence).padStart(6, '0')}--${entry.entryType}--${entry.intentId}.json`;
    if (entry.sequence !== index + 1 || expectedName !== file.name || at <= previousAt || !file.bytes.equals(Buffer.from(`${JSON.stringify(raw)}\n`))) fail();
    if (entry.entryType === 'intent') {
      if (intents.has(entry.intentId)) fail('intent_conflict');
      intents.set(entry.intentId, entry);
    } else {
      const intent = intents.get(entry.intentId);
      if (!intent || outcomes.has(entry.intentId) || entry.intentEntrySha256 !== intent.entrySha256
        || at > Date.parse(intent.deadlineAt)) fail('outcome_conflict');
      outcomes.set(entry.intentId, entry);
    }
    previousAt = at; entries.push(entry);
  }
  return { scope, entries: Object.freeze(entries), files, intents, outcomes };
}

export async function loadCleanupJournal(options) {
  const loaded = await readCleanup(options);
  const pending = [...loaded.intents.values()].filter((intent) => !loaded.outcomes.has(intent.intentId));
  const resolved = [...loaded.intents.values()].filter((intent) => loaded.outcomes.has(intent.intentId))
    .map((intent) => immutable({ intent, outcome: loaded.outcomes.get(intent.intentId) }));
  return immutable({ entries: loaded.entries, pending, resolved });
}

export async function cleanupJournalSnapshot(options) {
  const journal = await loadCleanupJournal(options);
  return immutable({ schema: 'raibitserver.production-evidence-cleanup-journal-snapshot/v1',
    runIdentitySha256: digest(options.identity), entryCount: journal.entries.length, entriesSha256: digest(journal.entries) });
}

export async function productionEvidenceJournalSnapshot(options) {
  const [bindings, cleanup] = await Promise.all([bindingJournalSnapshot(options), cleanupJournalSnapshot(options)]);
  const unsigned = { schema: 'raibitserver.production-evidence-journal-set-snapshot/v1', runIdentitySha256: digest(options.identity),
    bindingEntriesSha256: bindings.entriesSha256, cleanupEntriesSha256: cleanup.entriesSha256 };
  return immutable({ ...unsigned, journalSha256: digest(unsigned) });
}

export async function appendCleanupIntent(options) {
  const keys = ['runDirectory', 'identity', 'intentId', 'mutationKind', 'organizationId', 'projectId', 'resourceName',
    'relativeRoute', 'recoverySelector', 'createdAt', 'deadlineAt'];
  if (!isRecord(options) || keys.some((key) => !Object.hasOwn(options, key))
    || Object.keys(options).some((key) => ![...keys, 'parseIntent', 'parseOutcome'].includes(key))
    || !SAFE_NAME.test(options.intentId) || !MUTATION_KINDS.has(options.mutationKind)
    || !SAFE_ID.test(options.organizationId) || !SAFE_ID.test(options.projectId) || !SAFE_NAME.test(options.resourceName)
    || !validRoute(options.relativeRoute) || !validSelector(options.recoverySelector) || !isIso(options.createdAt) || !isIso(options.deadlineAt)
    || Date.parse(options.deadlineAt) <= Date.parse(options.createdAt)) fail();
  assertRedacted(options);
  const runMark = options.identity.runId;
  if (!options.resourceName.includes(runMark) && !options.resourceName.includes(digest(options.identity).slice(0, 12))) fail();
  const loaded = await readCleanup(options, true);
  const existing = loaded.intents.get(options.intentId);
  if (existing) {
    const requested = { mutationKind: options.mutationKind, organizationId: options.organizationId, projectId: options.projectId,
      resourceName: options.resourceName, relativeRoute: options.relativeRoute, recoverySelector: options.recoverySelector,
      createdAt: options.createdAt, deadlineAt: options.deadlineAt };
    const recorded = Object.fromEntries(Object.keys(requested).map((key) => [key, existing[key]]));
    if (digest(requested) !== digest(recorded)) fail('intent_conflict');
    const index = loaded.entries.findIndex((entry) => entry === existing);
    return Object.freeze({ ...existing, path: path.join(loaded.scope.directory, loaded.files[index].name), sha256: digest(loaded.files[index].bytes) });
  }
  const last = loaded.entries.at(-1);
  if (last && Date.parse(options.createdAt) <= Date.parse(last.entryType === 'intent' ? last.createdAt : last.resolvedAt)) fail();
  const unsigned = { schema: 'raibitserver.production-evidence-cleanup-journal/v1', entryType: 'intent', sequence: loaded.entries.length + 1,
    runIdentitySha256: loaded.scope.runIdentitySha256, intentId: options.intentId, mutationKind: options.mutationKind,
    organizationId: options.organizationId, projectId: options.projectId, resourceName: options.resourceName,
    relativeRoute: options.relativeRoute, recoverySelector: options.recoverySelector, createdAt: options.createdAt,
    deadlineAt: options.deadlineAt, selectorSha256: digest(options.recoverySelector) };
  const entry = immutable({ ...unsigned, entrySha256: digest(unsigned) });
  const parsed = parseIntent(entry, loaded.scope.runIdentitySha256, options.parseIntent ?? ((value) => value));
  if (digest(parsed) !== digest(entry)) fail();
  await exclusiveJournalWrite(loaded.scope.directory, `${String(entry.sequence).padStart(6, '0')}--intent--${entry.intentId}.json`, entry);
  return entry;
}

export async function appendCleanupOutcome(options) {
  const keys = ['runDirectory', 'identity', 'intentId', 'actualId', 'actualUid', 'responseSha256', 'resolvedAt'];
  if (!isRecord(options) || keys.some((key) => !Object.hasOwn(options, key))
    || Object.keys(options).some((key) => ![...keys, 'parseIntent', 'parseOutcome'].includes(key))
    || !SAFE_NAME.test(options.intentId) || !SAFE_ID.test(options.actualId)
    || !(options.actualUid === null || SAFE_ID.test(options.actualUid)) || !SHA256.test(options.responseSha256) || !isIso(options.resolvedAt)) fail();
  const loaded = await readCleanup(options);
  const intent = loaded.intents.get(options.intentId);
  if (!intent || Date.parse(options.resolvedAt) <= Date.parse(intent.createdAt) || Date.parse(options.resolvedAt) > Date.parse(intent.deadlineAt)) fail('outcome_conflict');
  const existing = loaded.outcomes.get(options.intentId);
  if (existing) {
    const requested = { actualId: options.actualId, actualUid: options.actualUid, responseSha256: options.responseSha256, resolvedAt: options.resolvedAt };
    const recorded = Object.fromEntries(Object.keys(requested).map((key) => [key, existing[key]]));
    if (digest(requested) !== digest(recorded)) fail('outcome_conflict');
    return existing;
  }
  const last = loaded.entries.at(-1);
  if (last && Date.parse(options.resolvedAt) <= Date.parse(last.entryType === 'intent' ? last.createdAt : last.resolvedAt)) fail('outcome_conflict');
  const unsigned = { schema: 'raibitserver.production-evidence-cleanup-journal/v1', entryType: 'outcome', sequence: loaded.entries.length + 1,
    runIdentitySha256: loaded.scope.runIdentitySha256, intentId: options.intentId, intentEntrySha256: intent.entrySha256,
    actualId: options.actualId, actualUid: options.actualUid, responseSha256: options.responseSha256, resolvedAt: options.resolvedAt };
  const entry = immutable({ ...unsigned, entrySha256: digest(unsigned) });
  const parsed = parseOutcome(entry, loaded.scope.runIdentitySha256, options.parseOutcome ?? ((value) => value));
  if (digest(parsed) !== digest(entry)) fail();
  await exclusiveJournalWrite(loaded.scope.directory, `${String(entry.sequence).padStart(6, '0')}--outcome--${entry.intentId}.json`, entry);
  return entry;
}

export function resolveCleanupRecovery(intent, candidates) {
  if (!isRecord(intent) || intent.entryType !== 'intent' || !validSelector(intent.recoverySelector)
    || !SHA256.test(intent.selectorSha256) || digest(intent.recoverySelector) !== intent.selectorSha256 || !SHA256.test(intent.entrySha256)
    || !Array.isArray(candidates)) fail();
  const { entrySha256, ...unsigned } = intent;
  if (digest(unsigned) !== entrySha256) fail('journal_digest_mismatch');
  if (candidates.length === 0) return immutable({ status: 'absent' });
  if (candidates.length > 1) fail('ambiguous_recovery');
  const candidate = candidates[0];
  if (!exactKeys(candidate, ['id', 'uid', 'selector']) || !SAFE_ID.test(candidate.id) || !SAFE_ID.test(candidate.uid)
    || !validSelector(candidate.selector) || digest(candidate.selector) !== intent.selectorSha256) fail('recovery_mismatch');
  assertRedacted(candidate);
  return immutable({ status: 'exact', candidate });
}

import { digest, EvidenceError } from './operator-inputs.mjs';
import {
  appendBinding, appendBindingFixtureUnsafe, bindingJournalSnapshot, bindingJournalSnapshotFixtureUnsafe, loadBindings,
  loadBindingsFixtureUnsafe,
} from './binding-journal.mjs';
import {
  appendCleanupIntent, appendCleanupIntentFixtureUnsafe, appendCleanupOutcome, appendCleanupOutcomeFixtureUnsafe,
  cleanupJournalSnapshot, cleanupJournalSnapshotFixtureUnsafe, loadCleanupJournal, loadCleanupJournalFixtureUnsafe,
  productionEvidenceJournalSnapshot, productionEvidenceJournalSnapshotFixtureUnsafe,
} from './cleanup-intent-journal.mjs';
import { initializeJournalDirectories } from './journal-io.mjs';
import { VerifiedBindingJournalSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { snapshotJournalData } from './journal-data-snapshot.mjs';

const authorities = new WeakSet();
const authorityWriters = new WeakSet();
const verifiedBindingJournals = new WeakMap();
const verifiedBindingSnapshots = new WeakSet();
const observationKinds = new Set([
  'builder-deployment-observation', 'github-webhook-observation',
  'controlled-fixture-observation', 'github-pull-request-observation',
]);
const fail = () => { throw new EvidenceError('invalid_journal_authority'); };
const bind = (base, input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ['runDirectory', 'identity', 'writer', 'unsafeFixture'].some((key) => Object.hasOwn(input, key))) fail();
  return { ...base, ...input };
};

export function assertJournalAuthority(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !authorities.has(value)) fail();
  return value;
}

export function assertVerifiedBindingJournal(value, authority) {
  assertJournalAuthority(authority);
  if (!value || typeof value !== 'object' || verifiedBindingJournals.get(value) !== authority) fail();
  return value;
}

export function assertVerifiedBindingSnapshot(value, identity) {
  if (!value || !verifiedBindingSnapshots.has(value) || value.runIdentitySha256 !== digest(identity)) fail();
  return value;
}

async function verifyBindingJournal(authority, loadEntries, loadSnapshot, identity) {
  const physicalEntries = await loadEntries();
  const journal = await loadSnapshot();
  if (journal.entryCount !== physicalEntries.length) fail();
  const payloads = physicalEntries.map(({ payload }) => payload);
  const entries = payloads.filter(({ kind }) => !observationKinds.has(kind));
  const observations = payloads.filter(({ kind }) => observationKinds.has(kind));
  const parsed = VerifiedBindingJournalSchema.safeParse({
    schema: 'raibitserver.verified-binding-journal/v1',
    journal,
    identityDigest: digest(identity),
    bindingsDigest: digest(entries),
    entries,
    observations,
  });
  if (!parsed.success) fail();
  const verified = snapshotJournalData(parsed.data);
  verifiedBindingJournals.set(verified, authority);
  return verified;
}

async function create(options, unsafeFixture) {
  if (!options || Object.keys(options).length !== 3 || !Object.hasOwn(options, 'runDirectory')
    || !Object.hasOwn(options, 'identity') || !Object.hasOwn(options, 'genuineSafeWriter')) fail();
  const { runDirectory, identity, genuineSafeWriter: writer } = options;
  if ((typeof writer !== 'object' && typeof writer !== 'function') || writer === null || authorityWriters.has(writer)) fail();
  authorityWriters.add(writer);
  await initializeJournalDirectories(runDirectory, identity, writer, unsafeFixture);
  const bindingOptions = () => ({ runDirectory, identity, writer });
  const cleanupOptions = (input = {}) => ({ runDirectory, identity, writer, approvedRuntimeSelector: input.approvedRuntimeSelector ?? null });
  let authority;
  const loadBindingEntries = () => (unsafeFixture ? loadBindingsFixtureUnsafe : loadBindings)(bindingOptions());
  const loadBindingSnapshot = () => (unsafeFixture ? bindingJournalSnapshotFixtureUnsafe : bindingJournalSnapshot)(bindingOptions());
  authority = Object.freeze({
    appendBinding: (input) => (unsafeFixture ? appendBindingFixtureUnsafe : appendBinding)(bind(bindingOptions(), input)),
    appendCleanupIntent: (input) => (unsafeFixture ? appendCleanupIntentFixtureUnsafe : appendCleanupIntent)(bind(bindingOptions(), input)),
    appendOutcome: (input) => (unsafeFixture ? appendCleanupOutcomeFixtureUnsafe : appendCleanupOutcome)(bind(bindingOptions(), input)),
    loadBindings: loadBindingEntries,
    loadCleanup: (input) => (unsafeFixture ? loadCleanupJournalFixtureUnsafe : loadCleanupJournal)(cleanupOptions(input)),
    bindingSnapshot: loadBindingSnapshot,
    async verifiedBindingSnapshot() {
      const entries = await loadBindingEntries();
      const snapshot = Object.freeze({ schema: 'raibitserver.production-evidence-verified-binding-snapshot/v1',
        runIdentitySha256: digest(identity), bindings: Object.freeze(entries.map(({ payload }) => payload)) });
      verifiedBindingSnapshots.add(snapshot); return snapshot;
    },
    verifyBindingJournal: () => verifyBindingJournal(authority, loadBindingEntries, loadBindingSnapshot, identity),
    cleanupSnapshot: (input) => (unsafeFixture ? cleanupJournalSnapshotFixtureUnsafe : cleanupJournalSnapshot)(cleanupOptions(input)),
    snapshot: (input) => (unsafeFixture ? productionEvidenceJournalSnapshotFixtureUnsafe : productionEvidenceJournalSnapshot)(cleanupOptions(input)),
  });
  authorities.add(authority);
  return authority;
}

export const createJournalAuthority = (options) => create(options, false);
export const createJournalAuthorityFixtureUnsafe = (options) => create(options, true);

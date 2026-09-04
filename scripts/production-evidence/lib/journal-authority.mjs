import { EvidenceError } from './operator-inputs.mjs';
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

const authorities = new WeakSet();
const authorityWriters = new WeakSet();
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

async function create(options, unsafeFixture) {
  if (!options || Object.keys(options).length !== 3 || !Object.hasOwn(options, 'runDirectory')
    || !Object.hasOwn(options, 'identity') || !Object.hasOwn(options, 'genuineSafeWriter')) fail();
  const { runDirectory, identity, genuineSafeWriter: writer } = options;
  if ((typeof writer !== 'object' && typeof writer !== 'function') || writer === null || authorityWriters.has(writer)) fail();
  authorityWriters.add(writer);
  await initializeJournalDirectories(runDirectory, identity, writer, unsafeFixture);
  const bindingOptions = () => ({ runDirectory, identity, writer });
  const cleanupOptions = (input = {}) => ({ runDirectory, identity, writer, approvedRuntimeSelector: input.approvedRuntimeSelector ?? null });
  const authority = Object.freeze({
    appendBinding: (input) => (unsafeFixture ? appendBindingFixtureUnsafe : appendBinding)(bind(bindingOptions(), input)),
    appendCleanupIntent: (input) => (unsafeFixture ? appendCleanupIntentFixtureUnsafe : appendCleanupIntent)(bind(bindingOptions(), input)),
    appendOutcome: (input) => (unsafeFixture ? appendCleanupOutcomeFixtureUnsafe : appendCleanupOutcome)(bind(bindingOptions(), input)),
    loadBindings: () => (unsafeFixture ? loadBindingsFixtureUnsafe : loadBindings)(bindingOptions()),
    loadCleanup: (input) => (unsafeFixture ? loadCleanupJournalFixtureUnsafe : loadCleanupJournal)(cleanupOptions(input)),
    bindingSnapshot: () => (unsafeFixture ? bindingJournalSnapshotFixtureUnsafe : bindingJournalSnapshot)(bindingOptions()),
    cleanupSnapshot: (input) => (unsafeFixture ? cleanupJournalSnapshotFixtureUnsafe : cleanupJournalSnapshot)(cleanupOptions(input)),
    snapshot: (input) => (unsafeFixture ? productionEvidenceJournalSnapshotFixtureUnsafe : productionEvidenceJournalSnapshot)(cleanupOptions(input)),
  });
  authorities.add(authority);
  return authority;
}

export const createJournalAuthority = (options) => create(options, false);
export const createJournalAuthorityFixtureUnsafe = (options) => create(options, true);

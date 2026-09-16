import { assertVerifiedBindingJournal } from './journal-authority.mjs';
import { digest, EvidenceError } from './operator-inputs.mjs';
import { assertDurableReceiptProof } from './durable-receipt-authority.mjs';

export function readVerifiedBindingJournal(manifest, options) {
  if (!manifest.bindingJournal || !manifest.bindingsDigest || !manifest.capabilitySnapshot
    || (!options.durableReceiptProof && (!options.journalAuthority || !options.verifiedBindingJournal))) {
    throw new EvidenceError('missing_binding_journal');
  }

  let journal;
  try {
    journal = options.durableReceiptProof
      ? assertDurableReceiptProof(options.durableReceiptProof, manifest).verifiedBindingJournal
      : assertVerifiedBindingJournal(options.verifiedBindingJournal, options.journalAuthority);
  } catch {
    throw new EvidenceError('invalid_binding_journal');
  }

  if (digest(journal.journal) !== digest(manifest.bindingJournal)
    || journal.identityDigest !== digest(manifest.identity)
    || journal.bindingsDigest !== manifest.bindingsDigest
    || digest(journal.entries) !== journal.bindingsDigest
    || journal.entries.length + journal.observations.length !== journal.journal.entryCount
    || manifest.fragments.some((fragment) => fragment.bindingsDigest !== manifest.bindingsDigest)) {
    throw new EvidenceError('binding_journal_mismatch');
  }
  return journal;
}

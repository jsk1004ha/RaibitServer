#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyManifest } from './production-evidence/lib/manifest.mjs';
import { digest, EvidenceError, loadOperatorContract, readJson } from './production-evidence/lib/operator-inputs.mjs';
import { checkRun, verifyArtifacts, verifyFragmentFiles, verifyRunReceipts } from './production-evidence/lib/run.mjs';
import { verifyResourceLifecycle } from './production-evidence/lib/resource-lifecycle.mjs';
import { assertReceiptAuthority } from './production-evidence/lib/receipt-authority.mjs';
import { verifyReceiptProvenance } from './production-evidence/lib/receipt-provenance.mjs';

export async function verifyEvidenceFile(file, options = {}) {
  await loadOperatorContract();
  const resolved = path.resolve(file);
  const manifest = await readJson(resolved);
  if (options.receiptAuthority) {
    const authority = assertReceiptAuthority(options.receiptAuthority);
    const snapshot = await authority.snapshot();
    if (snapshot.runIdentitySha256 !== digest(manifest.identity)) throw new EvidenceError('identity_mismatch');
    if (options.verifiedBindingJournal) verifyReceiptProvenance(await authority.loadProgression({ journalAuthority: options.journalAuthority }), options.verifiedBindingJournal);
  } else if (!options.fragment && !manifest.fixture && ['train-a', 'final'].includes(manifest.profile)) throw new EvidenceError('receipt_authority_unavailable');
  const result = verifyManifest(manifest, options);
  if (!result.valid) throw new EvidenceError(result.reason);
  if (!manifest.fixture) await checkRun(path.dirname(resolved), manifest, options.now);
  await verifyArtifacts(path.dirname(resolved), manifest);
  await verifyResourceLifecycle(path.dirname(resolved), manifest);
  if ((manifest.profile === 'train-a' || manifest.profile === 'final') && !options.fragment) {
    await verifyFragmentFiles(path.dirname(resolved), manifest);
    await verifyRunReceipts(path.dirname(resolved), manifest, options.now);
  } else if (options.fragment) {
    await verifyFragmentFiles(path.dirname(resolved), manifest);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const args = process.argv.slice(2);
  const options = {};
  for (const flag of ['--fragment', '--profile']) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(flag) !== index) throw new EvidenceError('invalid_arguments');
      options[flag.slice(2)] = args[index + 1]; args.splice(index, 2);
    }
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new EvidenceError('invalid_arguments');
  const file = path.resolve(args[0]);
  const result = await verifyEvidenceFile(file, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
  process.exitCode = 1;
}

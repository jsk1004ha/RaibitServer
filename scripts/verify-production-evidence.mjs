#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyManifest } from './production-evidence/lib/manifest.mjs';
import { digest, EvidenceError, loadOperatorContract, readJson } from './production-evidence/lib/operator-inputs.mjs';
import { checkRun, verifyArtifacts, verifyFragmentFiles, verifyRunReceipts } from './production-evidence/lib/run.mjs';
import { verifyResourceLifecycle } from './production-evidence/lib/resource-lifecycle.mjs';
import { assertReceiptAuthority } from './production-evidence/lib/receipt-authority.mjs';
import { verifyReceiptProvenance } from './production-evidence/lib/receipt-provenance.mjs';
import { verifyDurableEvidenceFile } from './production-evidence/lib/durable-receipt-authority.mjs';
import { parseCiInvocation } from './production-evidence/lib/ci-invocation.mjs';

const publicResult = ({ valid, releaseEligible, reason, manifestDigest }) => ({ valid, releaseEligible, reason, manifestDigest });

export function assertDistinctFinalEvidence({ candidateManifest, acceptedManifest, candidateResult, acceptedResult, acceptedBefore, acceptedAfter }) {
  if (candidateManifest.profile !== 'final' || acceptedManifest.profile !== 'final'
    || candidateManifest.fixture || acceptedManifest.fixture || !candidateResult.valid || !acceptedResult.valid
    || !candidateResult.releaseEligible || !acceptedResult.releaseEligible) {
    throw new EvidenceError('invalid_final_evidence');
  }
  if (candidateManifest.identity.sourceCommitSha !== acceptedManifest.identity.sourceCommitSha) throw new EvidenceError('final_source_mismatch');
  if (candidateManifest.identity.runId === acceptedManifest.identity.runId
    || candidateResult.manifestDigest === acceptedResult.manifestDigest) throw new EvidenceError('reused_evidence_run');
  if (!Buffer.isBuffer(acceptedBefore) || !Buffer.isBuffer(acceptedAfter) || !acceptedBefore.equals(acceptedAfter)) {
    throw new EvidenceError('accepted_evidence_mutated');
  }
  return Object.freeze({ ...publicResult(candidateResult), distinctFromManifestDigest: acceptedResult.manifestDigest });
}

export async function verifyEvidenceFile(file, options = {}) {
  if (Object.hasOwn(options, 'durableReceiptProof')) throw new EvidenceError('invalid_arguments');
  await loadOperatorContract();
  const resolved = path.resolve(file);
  const manifest = await readJson(resolved);
  if (Object.hasOwn(options, 'expectedIdentity') && digest(options.expectedIdentity) !== digest(manifest.identity)) throw new EvidenceError('identity_mismatch');
  let verificationOptions = options;
  if (options.receiptAuthority) {
    const authority = assertReceiptAuthority(options.receiptAuthority);
    const snapshot = await authority.snapshot();
    if (snapshot.runIdentitySha256 !== digest(manifest.identity)) throw new EvidenceError('identity_mismatch');
    if (options.verifiedBindingJournal) verifyReceiptProvenance(await authority.loadProgression({ journalAuthority: options.journalAuthority }), options.verifiedBindingJournal);
  } else if (!options.fragment && !manifest.fixture && ['train-a', 'final'].includes(manifest.profile)) {
    let durable;
    try { durable = await verifyDurableEvidenceFile(resolved, { expectedIdentity: Object.hasOwn(options, 'expectedIdentity') ? options.expectedIdentity : manifest.identity,
      ...(options.expectedCi === undefined ? {} : { expectedCi: options.expectedCi }), ...(options.now === undefined ? {} : { now: options.now }) }); }
    catch (error) { if (error instanceof Error && error.code === 'ENOENT') throw new EvidenceError('receipt_authority_unavailable'); throw error; }
    verificationOptions = { ...options, durableReceiptProof: durable.durableReceiptProof };
  }
  const result = verifyManifest(manifest, verificationOptions);
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
  return publicResult(result);
}

export async function verifyDistinctEvidenceFiles(candidateFile, acceptedFile, options = {}) {
  const acceptedPath = path.resolve(acceptedFile), acceptedBefore = await readFile(acceptedPath);
  const acceptedManifest = await readJson(acceptedPath);
  const candidatePath = path.resolve(candidateFile), candidateManifest = await readJson(candidatePath);
  const candidateResult = await verifyEvidenceFile(candidatePath, { profile: 'final',
    ...(options.expectedIdentity === undefined ? {} : { expectedIdentity: options.expectedIdentity }),
    ...(options.expectedCi === undefined ? {} : { expectedCi: options.expectedCi }) });
  const acceptedResult = await verifyEvidenceFile(acceptedPath, { profile: 'final', expectedIdentity: acceptedManifest.identity,
    now: Date.parse(acceptedManifest.observedAt), ...(options.acceptedCi === undefined ? {} : { expectedCi: options.acceptedCi }) });
  const acceptedAfter = await readFile(acceptedPath);
  return assertDistinctFinalEvidence({ candidateManifest, acceptedManifest, candidateResult, acceptedResult, acceptedBefore, acceptedAfter });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const args = process.argv.slice(2), values = new Map(), positional = [];
  const flags = new Set(['--fragment', '--profile', '--distinct-from', '--expected-ci', '--accepted-ci']);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (!flags.has(value) || values.has(value) || !args[index + 1] || args[index + 1].startsWith('--')) throw new EvidenceError('invalid_arguments');
    values.set(value, args[++index]);
  }
  if (positional.length !== 1 || !positional[0] || (values.has('--accepted-ci') && !values.has('--distinct-from'))
    || (values.has('--distinct-from') && (values.has('--fragment') || (values.has('--profile') && values.get('--profile') !== 'final')))) {
    throw new EvidenceError('invalid_arguments');
  }
  const file = path.resolve(positional[0]);
  const expectedInvocation = values.has('--expected-ci') ? parseCiInvocation(await readJson(path.resolve(values.get('--expected-ci')))) : undefined;
  const acceptedInvocation = values.has('--accepted-ci') ? parseCiInvocation(await readJson(path.resolve(values.get('--accepted-ci')))) : undefined;
  if (expectedInvocation && acceptedInvocation && digest(expectedInvocation) === digest(acceptedInvocation)) throw new EvidenceError('reused_ci_invocation');
  const expectedCi = expectedInvocation?.execution, acceptedCi = acceptedInvocation?.execution;
  const result = values.has('--distinct-from')
    ? await verifyDistinctEvidenceFiles(file, path.resolve(values.get('--distinct-from')), { expectedCi, acceptedCi })
    : await verifyEvidenceFile(file, { ...(values.has('--fragment') ? { fragment: values.get('--fragment') } : {}),
      ...(values.has('--profile') ? { profile: values.get('--profile') } : {}), ...(expectedCi === undefined ? {} : { expectedCi }) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
  process.exitCode = 1;
}

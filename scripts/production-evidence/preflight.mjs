#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { EvidenceError, APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, loadOperatorContract, parseOperatorInputs, inputsFromEnvironment, verifyApprovedSnapshot, digest, readJson } from './lib/operator-inputs.mjs';

export { parseOperatorInputs, inputsFromEnvironment };
export async function preflight(value, options = {}) {
  try {
    const approvalRequested = Object.hasOwn(options, 'approvedInputPath');
    if (approvalRequested && (typeof options.approvedInputPath !== 'string' || !options.approvedInputPath)) throw new EvidenceError('missing_approved_input');
    const contract = approvalRequested ? await verifyApprovedSnapshot(options.approvedInputPath) : await loadOperatorContract();
    const inputs = parseOperatorInputs(value, contract);
    if (!options.inspectSecretReference) throw new EvidenceError('missing_credentials');
    for (const reference of inputs.secretRefs) {
      // Adapter returns metadata/key availability only; Secret data never enters this contract.
      const observation = await options.inspectSecretReference(reference);
      if (!observation || observation.available !== true || typeof observation.uid !== 'string' || !observation.uid || observation.keysPresent !== true) throw new EvidenceError('missing_credentials');
    }
    return { status: 'PASS', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: digest(inputs) };
  } catch (error) {
    if (error instanceof EvidenceError) return { status: 'NOT_RUN', releaseEligible: false, reason: error.reason };
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--contract' && args.length === 1) {
      await loadOperatorContract();
      process.stdout.write(`${JSON.stringify({ approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, releaseEligible: false })}\n`);
    } else if (args[0] === '--approved-input' && args.length === 2) {
      await verifyApprovedSnapshot(args[1]);
      process.stdout.write(`${JSON.stringify({ parity: true, approvedInputSha256: APPROVED_INPUT_SHA256, releaseEligible: false })}\n`);
    } else {
      if (args.length !== 1) throw new EvidenceError('invalid_arguments');
      const result = await preflight(await readJson(args[0], 'missing_approved_input'));
      if (result.status !== 'PASS') throw new EvidenceError(result.reason);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
    process.exitCode = 1;
  }
}

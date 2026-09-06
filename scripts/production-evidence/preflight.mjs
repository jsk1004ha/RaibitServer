#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceError, APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, loadOperatorContract, parseOperatorInputs, inputsFromEnvironment, verifyApprovedSnapshot, digest, readJson } from './lib/operator-inputs.mjs';
import { parseCiInvocation } from './lib/ci-invocation.mjs';

export { parseOperatorInputs, inputsFromEnvironment };
export function parseRequiredOperatorInputs(value, contract) {
  if (Array.isArray(value?.secretRefs) && !value.secretRefs.some(({ role }) => role === 'signing')) {
    const signing = contract.secretBindings.find(({ role }) => role === 'signing');
    if (!signing) throw new EvidenceError('operator_contract_digest_mismatch');
    parseOperatorInputs({ ...value, secretRefs: [...value.secretRefs, { role: signing.role, binding: signing.binding,
      kind: signing.kind, namespace: 'fixture-system', existingSecret: 'fixture-signing', keys: Object.values(signing.keyFields) }] }, contract);
    throw new EvidenceError('missing_secret_ref');
  }
  return parseOperatorInputs(value, contract);
}
export async function preflight(value, options = {}) {
  try {
    const approvalRequested = Object.hasOwn(options, 'approvedInputPath');
    if (approvalRequested && (typeof options.approvedInputPath !== 'string' || !options.approvedInputPath)) throw new EvidenceError('missing_approved_input');
    const contract = approvalRequested ? await verifyApprovedSnapshot(options.approvedInputPath) : await loadOperatorContract();
    const inputs = parseRequiredOperatorInputs(value, contract);
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
export async function runMissingSigningFixture({ fixture, ciReceipt, attemptDir }) {
  const contract = await loadOperatorContract(), value = await readJson(fixture, 'missing_approved_input');
  let observedReason = null;
  try { parseRequiredOperatorInputs(value, contract); }
  catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    observedReason = error.reason;
  }
  if (observedReason !== 'missing_secret_ref') throw new EvidenceError('invalid_fixture');
  const invocation = parseCiInvocation(await readJson(ciReceipt, 'ci_identity_mismatch'));
  await mkdir(attemptDir, { recursive: false, mode: 0o700 });
  const result = { schema: 'raibitserver.production-evidence-preflight/v1', status: 'NOT_RUN', reason: observedReason,
    releaseEligible: false, testOnly: true, approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST, ciInvocationSha256: digest(invocation) };
  const cleanup = { schema: 'raibitserver.production-evidence-preflight-cleanup/v1', status: 'PASS',
    reason: null, resourcesCreated: 0, resourcesRemaining: 0, testOnly: true,
    ciInvocationSha256: result.ciInvocationSha256 };
  await Promise.all([
    writeFile(path.join(attemptDir, 'preflight.json'), `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 }),
    writeFile(path.join(attemptDir, 'cleanup.json'), `${JSON.stringify(cleanup)}\n`, { flag: 'wx', mode: 0o600 }),
  ]);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--profile') {
      const values = new Map();
      if (args.length !== 8) throw new EvidenceError('invalid_arguments');
      for (let index = 0; index < args.length; index += 2) {
        if (values.has(args[index])) throw new EvidenceError('invalid_arguments');
        values.set(args[index], args[index + 1]);
      }
      if (values.get('--profile') !== 'train-a' || !['--fixture', '--ci-receipt', '--attempt-dir'].every((flag) => values.has(flag))
        || [values.get('--fixture'), values.get('--ci-receipt'), values.get('--attempt-dir')].some((value) => !path.isAbsolute(value))) throw new EvidenceError('invalid_arguments');
      const result = await runMissingSigningFixture({ fixture: values.get('--fixture'), ciReceipt: values.get('--ci-receipt'), attemptDir: values.get('--attempt-dir') });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 1;
    } else if (args[0] === '--contract' && args.length === 1) {
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

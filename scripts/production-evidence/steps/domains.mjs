import { pathToFileURL } from 'node:url';
import { executeCredentialedDomainProbes, loadDomainEvidenceInputs } from '../lib/cloudflare-domain-evidence.mjs';
import { validateDomainProof } from '../lib/domain-runner.mjs';
import { digest, EvidenceError } from '../lib/operator-inputs.mjs';
import { parseStepRequest, parseStepResult, STEP_ASSERTIONS } from '../lib/step-contract.mjs';
import { runFixedStepMain } from '../run-component.mjs';

const STEP = 'domains';

export async function execute(input, context) {
  const request = parseStepRequest(input, STEP);
  let status = 'PASS'; let reason = null; let proof = null;
  try {
    const extensionPath = process.env.RAIBITSERVER_PRODUCTION_DOMAIN_INPUTS_FILE;
    if (!extensionPath) throw new EvidenceError('domain_provider_contract_unavailable');
    const baseDomain = request.selectors.RAIBITSERVER_RELEASE_BASE_DOMAIN;
    const extension = await loadDomainEvidenceInputs(extensionPath, baseDomain);
    if (digest(extension) !== request.identity.domainInputDigest) throw new EvidenceError('domain_input_digest_mismatch');
    proof = validateDomainProof({ ...(await executeCredentialedDomainProbes({
      inputs: { selectors: request.selectors, secretRefs: request.secretRefs }, extension,
    })), domainInputDigest: request.identity.domainInputDigest }, { baseDomain });
  } catch (error) {
    reason = error instanceof EvidenceError ? error.reason : 'domain_evidence_failed';
    status = ['missing_credentials', 'domain_provider_contract_unavailable'].includes(reason) ? 'NOT_RUN' : 'FAIL';
  }
  const artifact = await context.writeArtifact('domains', 'domains-observation.json', {
    schema: 'raibitserver.production-domain-step-observation/v1', status, reason,
    domainInputDigest: request.identity.domainInputDigest, redacted: true,
  });
  return parseStepResult({ status, reason,
    assertions: STEP_ASSERTIONS.domains.map((id) => ({ id, status, artifactPaths: [artifact.path] })),
    artifacts: [artifact], cleanupInventory: [], ...(proof ? { domainProof: proof } : {}),
  }, STEP, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runFixedStepMain(STEP, process.argv.slice(2));
  process.exitCode = result.exitCode;
}

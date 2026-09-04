import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, DnsLabelSchema, OperatorInputValuesSchema, ClusterFingerprintSchema } from '../../../packages/schemas/src/production-evidence.ts';

export { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST };
export class EvidenceError extends Error {
  constructor(reason) { super(reason); this.name = 'EvidenceError'; this.reason = reason; }
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
export function assertRedacted(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~-]+|[a-z]+:\/\/[^\s/]+:[^\s/]+@|(?:^|["'\s{,])(?:password|token|secret|credential|authorization|api[_-]?key|private[_-]?key)["']?\s*[=:]\s*[^\s,;}]+|\b[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|CREDENTIAL|API_KEY)\s*=|"(?:data|stringData|env|environment)"\s*:)/i.test(text)) throw new EvidenceError('redaction');
}
export async function readJson(file, reason = 'missing_manifest') {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new EvidenceError('invalid_schema');
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new EvidenceError(reason);
    throw error;
  }
}
export async function loadOperatorContract() {
  const contract = await readJson(new URL('../../../test-fixtures/contracts/operator-inputs-v1.json', import.meta.url), 'missing_approved_input');
  if (contract.approvedInputSha256 !== APPROVED_INPUT_SHA256) throw new EvidenceError('approved_input_digest_mismatch');
  if (digest(contract) !== OPERATOR_CONTRACT_DIGEST) throw new EvidenceError('operator_contract_digest_mismatch');
  return contract;
}
export async function verifyApprovedSnapshot(file) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new EvidenceError('missing_approved_input');
    throw error;
  }
  if (digest(bytes).toUpperCase() !== APPROVED_INPUT_SHA256) throw new EvidenceError('approved_input_digest_mismatch');
  // Decode only after byte-level approval verification. No mutable draft fallback.
  const names = [...new Set(bytes.toString('utf8').match(/RAIBITSERVER_RELEASE_[A-Z_]+/g))];
  const contract = await loadOperatorContract();
  if (JSON.stringify(names.sort()) !== JSON.stringify(contract.selectors.map(({ name }) => name).sort())) throw new EvidenceError('operator_contract_digest_mismatch');
  return contract;
}
function validSelector(type, value) {
  switch (type) {
    case 'context': return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
    case 'dns-label': return DnsLabelSchema.safeParse(value).success;
    case 'hostname': return value.includes('.') && value.split('.').every((label) => DnsLabelSchema.safeParse(label).success);
    case 'oci-repository': return /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*$/.test(value);
    case 'github-repository': return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
    case 'positive-integer': return /^[1-9][0-9]*$/.test(value);
    case 'bucket': return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value);
    case 'https-url': {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
      catch (error) { if (error instanceof TypeError) return false; throw error; }
    }
    default: throw new EvidenceError('operator_contract_digest_mismatch');
  }
}
export function parseOperatorInputs(value, contract) {
  if (!value?.approvedInputSha256) throw new EvidenceError('missing_approved_input');
  if (value.approvedInputSha256 !== APPROVED_INPUT_SHA256) throw new EvidenceError('approved_input_digest_mismatch');
  if (digest(contract) !== OPERATOR_CONTRACT_DIGEST || value.operatorContractDigest !== OPERATOR_CONTRACT_DIGEST) throw new EvidenceError('operator_contract_digest_mismatch');
  assertRedacted(value);
  const parsed = OperatorInputValuesSchema.safeParse(value);
  if (!parsed.success) throw new EvidenceError('missing_credentials');
  const inputs = parsed.data;
  if (Object.keys(inputs.selectors).length !== contract.selectors.length || contract.selectors.some(({ name, type }) => !validSelector(type, inputs.selectors[name] ?? ''))) throw new EvidenceError('missing_credentials');
  if (inputs.secretRefs.length !== contract.secretBindings.length) throw new EvidenceError('missing_credentials');
  for (const binding of contract.secretBindings) {
    const refs = inputs.secretRefs.filter((item) => item.role === binding.role && item.binding === binding.binding && item.kind === binding.kind);
    if (refs.length !== 1) throw new EvidenceError('missing_credentials');
    switch (refs[0].kind) {
      case 'helm-existingSecret':
        if (Object.values(binding.keyFields).some((key) => !refs[0].keys.includes(key))) throw new EvidenceError('missing_credentials');
        break;
      case 'worker-secretKeyRef': break;
      default: throw new EvidenceError('missing_credentials');
    }
  }
  return Object.freeze(inputs);
}
export function inputsFromEnvironment(environment, secretRefs, contract) {
  return parseOperatorInputs({ schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST, secretRefs,
    selectors: Object.fromEntries(contract.selectors.map(({ name }) => [name, environment[name] ?? ''])),
  }, contract);
}
export function environmentFingerprint(value) {
  const result = ClusterFingerprintSchema.safeParse(value);
  if (!result.success) throw new EvidenceError('invalid_environment');
  assertRedacted(result.data);
  return digest(result.data);
}

export async function loadProductionInputs(attemptDir, environment = process.env) {
  if (!path.isAbsolute(attemptDir)) throw new EvidenceError('invalid_arguments');
  const approvedInputPath = path.join(path.dirname(attemptDir), 'inputs', 'approved-draft-input-v1.md');
  const contract = await verifyApprovedSnapshot(approvedInputPath);
  const refsPath = environment.RAIBITSERVER_PRODUCTION_EVIDENCE_SECRET_REFS_FILE;
  if (typeof refsPath !== 'string' || !path.isAbsolute(refsPath)) throw new EvidenceError('missing_credentials');
  const resolved = await realpath(refsPath);
  if (resolved !== path.resolve(refsPath) || !(await lstat(resolved)).isFile()) throw new EvidenceError('missing_credentials');
  const secretRefs = await readJson(resolved, 'missing_credentials');
  if (!Array.isArray(secretRefs)) throw new EvidenceError('missing_credentials');
  return inputsFromEnvironment(environment, secretRefs, contract);
}

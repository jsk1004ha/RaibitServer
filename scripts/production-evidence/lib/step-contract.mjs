import path from 'node:path';
import {
  APPROVED_INPUT_SHA256,
  DomainEvidenceProofSchema,
  EvidenceArtifactSchema,
  EvidenceIdentitySchema,
  OPERATOR_CONTRACT_DIGEST,
  OperatorInputValuesSchema,
} from '../../../packages/schemas/src/production-evidence.ts';
import { EvidenceError } from './operator-inputs.mjs';
import { assertVerifiedBindingSnapshot } from './journal-authority.mjs';

export const STEP_NAMES = Object.freeze([
  'auth-source', 'supply-chain', 'runtime', 'observability', 'resources',
  'backup-sql', 'backup-nosql', 'preview', 'rollback', 'cleanup',
]);
export const FINAL_STEP_NAMES = Object.freeze([
  ...STEP_NAMES.slice(0, -1), 'domains', 'cleanup',
]);
export const ALL_STEP_NAMES = Object.freeze([...new Set([...STEP_NAMES, ...FINAL_STEP_NAMES])]);
export function stepNamesForIdentity(identity) {
  return identity?.domainInputDigest ? FINAL_STEP_NAMES : STEP_NAMES;
}

export const STEP_ASSERTIONS = Object.freeze({
  'auth-source': ['github_source'],
  'supply-chain': ['image_digest', 'scan_policy', 'signature'],
  runtime: ['rollout', 'https', 'functional_write_read', 'trusted_proxy'],
  observability: ['runtime_logs', 'usage_quota_audit', 'metrics'],
  resources: ['provision', 'attach_query', 'resource_delete'],
  'backup-sql': ['backup_checksum', 'isolated_restore'],
  'backup-nosql': ['backup_checksum', 'isolated_restore'],
  preview: ['preview_cleanup'],
  rollback: ['rollback'],
  cleanup: ['component_cleanup', 'run_cleanup'],
  domains: ['ownership', 'tls_exact_san', 'route', 'revalidation', 'domain_delete'],
});
export const STEP_SECRET_ROLES = Object.freeze({
  'auth-source': ['github'], 'supply-chain': ['registry', 'scanner', 'signing', 'trust-root'], runtime: ['runtime', 'database'],
  observability: ['runtime'], resources: [], 'backup-sql': [], 'backup-nosql': [], preview: ['github', 'runtime'], rollback: ['runtime'], cleanup: [],
  domains: ['runtime'],
});
const requestSnapshots = new WeakMap();

function invalidSchema() {
  throw new EvidenceError('invalid_step_contract');
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isStatus(value) { return ['PASS', 'FAIL', 'NOT_RUN'].includes(value); }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validStrings(value) { return isRecord(value) && Object.values(value).every((item) => typeof item === 'string' && item.length > 0 && item.length <= 512); }
const KUBE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
function validAuthenticatedClient(value) {
  const keys = ['schema', 'namespace', 'podName', 'podUid', 'podResourceVersion', 'networkPolicyUid', 'networkPolicyResourceVersion',
    'apiServiceName', 'apiServiceUid', 'port', 'expiresAt'];
  return hasExactKeys(value, keys) && value.schema === 'raibitserver.production-evidence-client/v1'
    && [value.namespace, value.podName, value.apiServiceName].every((item) => typeof item === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item))
    && [value.podUid, value.podResourceVersion, value.networkPolicyUid, value.networkPolicyResourceVersion, value.apiServiceUid].every((item) => typeof item === 'string' && KUBE_ID.test(item))
    && value.port === 3000 && validIso(value.expiresAt);
}
function validAssertion(value) {
  return hasExactKeys(value, ['id', 'status', 'artifactPaths'])
    && typeof value.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value.id)
    && isStatus(value.status) && Array.isArray(value.artifactPaths) && value.artifactPaths.length > 0
    && value.artifactPaths.every((item) => typeof item === 'string' && item.length > 0);
}
function validInventory(value) {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'kubernetes':
      return hasExactKeys(value, ['type', 'apiVersion', 'kind', 'namespace', 'name', 'uid', 'resourceVersion', 'labels'])
        && [value.apiVersion, value.kind, value.namespace, value.name].every((item) => typeof item === 'string' && item.length > 0)
        && [value.uid, value.resourceVersion].every((item) => typeof item === 'string' && KUBE_ID.test(item))
        && hasExactKeys(value.labels, ['raibitserver.io/run-id']) && typeof value.labels['raibitserver.io/run-id'] === 'string';
    case 'control-plane':
      return hasExactKeys(value, ['type', 'resourceType', 'id', 'organizationId', 'projectId'])
        && ['project', 'preview', 'resource', 'restore-target', 'backup'].includes(value.resourceType)
        && [value.id, value.organizationId, value.projectId].every((item) => typeof item === 'string' && item.length > 0);
    case 'process':
      return hasExactKeys(value, ['type', 'pid', 'startedAt', 'commandSha256'])
        && Number.isSafeInteger(value.pid) && value.pid > 0 && validIso(value.startedAt)
        && typeof value.commandSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.commandSha256);
    case 'file':
      return hasExactKeys(value, ['type', 'path']) && typeof value.path === 'string' && path.isAbsolute(value.path);
    default: return false;
  }
}

function exactlyOne(values, predicate) {
  return values.filter(predicate).length === 1;
}

function controlPlaneItemIsBound(item, bindings) {
  if (!exactlyOne(bindings, (binding) => binding.kind === 'organization-membership' && binding.organizationId === item.organizationId)
    || !exactlyOne(bindings, (binding) => binding.kind === 'project' && binding.projectId === item.projectId
      && binding.organizationId === item.organizationId)) return false;
  switch (item.resourceType) {
    case 'project': return item.id === item.projectId;
    case 'preview': {
      const deployments = bindings.filter((binding) => binding.kind === 'deployment' && binding.role === 'preview' && binding.deploymentId === item.id);
      return deployments.length === 1 && exactlyOne(bindings, (binding) => binding.kind === 'service'
        && binding.serviceId === deployments[0].serviceId && binding.projectId === item.projectId);
    }
    case 'resource': return exactlyOne(bindings, (binding) => binding.kind === 'resource' && binding.role === 'source'
      && binding.resourceId === item.id && binding.projectId === item.projectId);
    case 'restore-target': return exactlyOne(bindings, (binding) => binding.kind === 'resource' && binding.role === 'restore-target'
      && binding.resourceId === item.id && binding.projectId === item.projectId);
    case 'backup': return exactlyOne(bindings, (binding) => binding.kind === 'backup' && binding.backupId === item.id)
      && exactlyOne(bindings, (binding) => binding.kind === 'resource' && binding.role === 'source'
        && binding.projectId === item.projectId && bindings.some((candidate) => candidate.kind === 'backup'
          && candidate.backupId === item.id && candidate.sourceResourceId === binding.resourceId));
    default: return false;
  }
}

function validateInventoryScope(inventory, request, verifiedBindingSnapshot) {
  const workRoot = path.resolve(request.runDirectory, 'work');
  const controlPlane = inventory.filter((item) => item.type === 'control-plane');
  let bindings = [];
  if (controlPlane.length > 0) {
    try { bindings = assertVerifiedBindingSnapshot(verifiedBindingSnapshot, request.identity).bindings; }
    catch (error) { if (error instanceof EvidenceError) invalidSchema(); throw error; }
  }
  for (const item of inventory) {
    if (item.type === 'kubernetes') {
      if (item.labels['raibitserver.io/run-id'] !== request.identity.runId) invalidSchema();
      if (request.state.cleanupNamespace && item.namespace !== request.state.cleanupNamespace) {
        const client = request.state.authenticatedClient;
        const isClientPod = item.kind === 'Pod' && item.namespace === client?.namespace && item.name === client?.podName
          && item.uid === client?.podUid && item.resourceVersion === client?.podResourceVersion;
        const isClientPolicy = item.kind === 'NetworkPolicy' && item.namespace === client?.namespace && item.name === `${client?.podName}-egress`
          && item.uid === client?.networkPolicyUid && item.resourceVersion === client?.networkPolicyResourceVersion;
        if (!isClientPod && !isClientPolicy) invalidSchema();
      }
    }
    if (item.type === 'control-plane' && !controlPlaneItemIsBound(item, bindings)) invalidSchema();
    if (item.type === 'file') {
      const relative = path.relative(workRoot, path.resolve(item.path));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalidSchema();
    }
  }
}

function assertTimeBounds(startedAt, observedAt, deadlineAt) {
  const started = Date.parse(startedAt);
  const observed = Date.parse(observedAt);
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(started) || !Number.isFinite(observed) || !Number.isFinite(deadline)
    || observed < started || observed > deadline || deadline - started > 4 * 60 * 60 * 1000) invalidSchema();
}

function assertAssertions(step, assertions) {
  const allowed = STEP_ASSERTIONS[step];
  const ids = assertions.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !allowed.includes(id))) invalidSchema();
}

export function parseStepRequest(value, expectedStep, verifiedBindingSnapshot = undefined) {
  verifiedBindingSnapshot ??= requestSnapshots.get(value);
  const keys = ['schema', 'step', 'identity', 'startedAt', 'deadlineAt', 'runDirectory', 'selectors', 'secretRefs', 'state'];
  if (!hasExactKeys(value, keys) || value.schema !== 'raibitserver.production-evidence-step-request/v1'
    || !ALL_STEP_NAMES.includes(value.step) || !EvidenceIdentitySchema.safeParse(value.identity).success
    || !stepNamesForIdentity(value.identity).includes(value.step)
    || !validIso(value.startedAt) || !validIso(value.deadlineAt) || !path.isAbsolute(value.runDirectory)
    || !validStrings(value.selectors) || !Array.isArray(value.secretRefs) || !isRecord(value.state)
    || (expectedStep !== undefined && value.step !== expectedStep)) invalidSchema();
  assertTimeBounds(value.startedAt, value.startedAt, value.deadlineAt);
  const operator = OperatorInputValuesSchema.safeParse({
    schema: 'raibitserver.operator-input-values/v1',
    approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: value.selectors,
    secretRefs: value.secretRefs,
  });
  if (!operator.success) invalidSchema();
  if (Object.hasOwn(value.state, 'cleanupNamespace')
    && (typeof value.state.cleanupNamespace !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.state.cleanupNamespace))) invalidSchema();
  if (Object.hasOwn(value.state, 'authenticatedClient') && !validAuthenticatedClient(value.state.authenticatedClient)) invalidSchema();
  if (Object.hasOwn(value.state, 'cleanupInventory')) {
    if (!Array.isArray(value.state.cleanupInventory) || !value.state.cleanupInventory.every(validInventory)) invalidSchema();
    validateInventoryScope(value.state.cleanupInventory, value, verifiedBindingSnapshot);
  }
  if (verifiedBindingSnapshot) requestSnapshots.set(value, assertVerifiedBindingSnapshot(verifiedBindingSnapshot, value.identity));
  return Object.freeze(value);
}

export function projectStepRequest(value, verifiedBindingSnapshot) {
  const roles = STEP_SECRET_ROLES[value.step];
  if (!roles) invalidSchema();
  return parseStepRequest({ ...value, secretRefs: value.secretRefs.filter(({ role }) => roles.includes(role)) }, value.step, verifiedBindingSnapshot);
}

export function parseStepResult(value, step, request, verifiedBindingSnapshot = undefined) {
  verifiedBindingSnapshot ??= requestSnapshots.get(request);
  const resultKeys = ['status', 'reason', 'assertions', 'artifacts', 'cleanupInventory'];
  const hasDomainProof = Object.hasOwn(value ?? {}, 'domainProof');
  if (!hasExactKeys(value, hasDomainProof ? [...resultKeys, 'domainProof'] : resultKeys) || !isStatus(value.status)
    || !(value.reason === null || (typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 256))
    || !Array.isArray(value.assertions) || value.assertions.length === 0 || !value.assertions.every(validAssertion)
    || !Array.isArray(value.artifacts) || value.artifacts.length === 0 || !value.artifacts.every((item) => EvidenceArtifactSchema.safeParse(item).success)
    || !Array.isArray(value.cleanupInventory) || !value.cleanupInventory.every(validInventory)) invalidSchema();
  const artifactPaths = value.artifacts.map(({ path: artifactPath }) => artifactPath);
  const referencedPaths = value.assertions.flatMap(({ artifactPaths: paths }) => paths);
  if (new Set(artifactPaths).size !== artifactPaths.length || artifactPaths.some((artifactPath) => !referencedPaths.includes(artifactPath))
    || referencedPaths.some((artifactPath) => !artifactPaths.includes(artifactPath))) invalidSchema();
  if (request !== undefined) validateInventoryScope(value.cleanupInventory, request, verifiedBindingSnapshot);
  assertAssertions(step, value.assertions);
  if (hasDomainProof) {
    const parsed = DomainEvidenceProofSchema.safeParse(value.domainProof);
    if (!parsed.success || step !== 'domains' || value.status !== 'PASS'
      || (request && value.domainProof.domainInputDigest !== request.identity.domainInputDigest)) invalidSchema();
  } else if (step === 'domains' && value.status === 'PASS') invalidSchema();
  if ((value.status === 'PASS') !== value.assertions.every(({ status }) => status === 'PASS')) invalidSchema();
  if ((value.status === 'PASS') !== (value.reason === null)) invalidSchema();
  return Object.freeze(value);
}

export function parseStepReceipt(value, request = undefined, verifiedBindingSnapshot = undefined) {
  const keys = ['schema', 'step', 'identity', 'startedAt', 'observedAt', 'status', 'reason', 'assertions', 'artifacts', 'cleanupInventory', 'redacted', 'fixture'];
  const version2 = value?.schema === 'raibitserver.production-evidence-step-receipt/v2';
  const hasDomainProof = Object.hasOwn(value ?? {}, 'domainProof');
  const receiptKeys = version2 ? [...keys, 'requestSha256'] : keys;
  if (!hasExactKeys(value, hasDomainProof ? [...receiptKeys, 'domainProof'] : receiptKeys) || (!version2 && value.schema !== 'raibitserver.production-evidence-step-receipt/v1')
    || (version2 && !/^[a-f0-9]{64}$/.test(value.requestSha256))
    || !ALL_STEP_NAMES.includes(value.step) || !EvidenceIdentitySchema.safeParse(value.identity).success
    || !stepNamesForIdentity(value.identity).includes(value.step)
    || !validIso(value.startedAt) || !validIso(value.observedAt) || value.redacted !== true || typeof value.fixture !== 'boolean') invalidSchema();
  if (hasDomainProof && value.domainProof.domainInputDigest !== value.identity.domainInputDigest) invalidSchema();
  parseStepResult({ status: value.status, reason: value.reason, assertions: value.assertions,
    artifacts: value.artifacts, cleanupInventory: value.cleanupInventory, ...(hasDomainProof ? { domainProof: value.domainProof } : {}) }, value.step, request, verifiedBindingSnapshot);
  if (request) {
    if (value.step !== request.step || value.startedAt !== request.startedAt || JSON.stringify(value.identity) !== JSON.stringify(request.identity)) invalidSchema();
    assertTimeBounds(value.startedAt, value.observedAt, request.deadlineAt);
  }
  return Object.freeze(value);
}

export function assertStepReceiptTimeBounds(receipt, deadlineAt) {
  assertTimeBounds(receipt.startedAt, receipt.observedAt, deadlineAt);
}

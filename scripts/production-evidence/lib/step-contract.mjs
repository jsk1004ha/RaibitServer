import path from 'node:path';
import {
  APPROVED_INPUT_SHA256,
  EvidenceArtifactSchema,
  EvidenceIdentitySchema,
  OPERATOR_CONTRACT_DIGEST,
  OperatorInputValuesSchema,
} from '../../../packages/schemas/src/production-evidence.ts';
import { EvidenceError } from './operator-inputs.mjs';

export const STEP_NAMES = Object.freeze([
  'auth-source', 'supply-chain', 'runtime', 'observability', 'resources',
  'backup-sql', 'backup-nosql', 'preview', 'rollback', 'cleanup',
]);

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
});

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
      return hasExactKeys(value, ['type', 'apiVersion', 'kind', 'namespace', 'name', 'uid', 'labels'])
        && [value.apiVersion, value.kind, value.namespace, value.name, value.uid].every((item) => typeof item === 'string' && item.length > 0)
        && hasExactKeys(value.labels, ['raibitserver.io/run-id']) && typeof value.labels['raibitserver.io/run-id'] === 'string';
    case 'control-plane':
      return hasExactKeys(value, ['type', 'resourceType', 'id', 'organizationId', 'projectId'])
        && ['project', 'preview', 'resource', 'restore-target', 'attachment'].includes(value.resourceType)
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

function validateInventoryScope(inventory, request) {
  const workRoot = path.resolve(request.runDirectory, 'work');
  for (const item of inventory) {
    if (item.type === 'kubernetes') {
      if (item.labels['raibitserver.io/run-id'] !== request.identity.runId) invalidSchema();
      if (request.state.cleanupNamespace && item.namespace !== request.state.cleanupNamespace) {
        const client = request.state.authenticatedClient;
        const isClientPod = item.kind === 'Pod' && item.namespace === client?.namespace && item.name === client?.podName && item.uid === client?.podUid;
        const isClientPolicy = item.kind === 'NetworkPolicy' && item.namespace === client?.namespace && item.name === `${client?.podName}-egress`;
        if (!isClientPod && !isClientPolicy) invalidSchema();
      }
    }
    if (item.type === 'control-plane' && (item.organizationId !== request.identity.organizationId || item.projectId !== request.identity.projectId
      || (item.resourceType === 'project' && item.id !== item.projectId))) invalidSchema();
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

export function parseStepRequest(value, expectedStep) {
  const keys = ['schema', 'step', 'identity', 'startedAt', 'deadlineAt', 'runDirectory', 'selectors', 'secretRefs', 'state'];
  if (!hasExactKeys(value, keys) || value.schema !== 'raibitserver.production-evidence-step-request/v1'
    || !STEP_NAMES.includes(value.step) || !EvidenceIdentitySchema.safeParse(value.identity).success
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
  if (Object.hasOwn(value.state, 'cleanupInventory')) {
    if (!Array.isArray(value.state.cleanupInventory) || !value.state.cleanupInventory.every(validInventory)) invalidSchema();
    validateInventoryScope(value.state.cleanupInventory, value);
  }
  return Object.freeze(value);
}

export function parseStepResult(value, step, request) {
  if (!hasExactKeys(value, ['status', 'reason', 'assertions', 'artifacts', 'cleanupInventory']) || !isStatus(value.status)
    || !(value.reason === null || (typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 256))
    || !Array.isArray(value.assertions) || value.assertions.length === 0 || !value.assertions.every(validAssertion)
    || !Array.isArray(value.artifacts) || value.artifacts.length === 0 || !value.artifacts.every((item) => EvidenceArtifactSchema.safeParse(item).success)
    || !Array.isArray(value.cleanupInventory) || !value.cleanupInventory.every(validInventory)) invalidSchema();
  const artifactPaths = value.artifacts.map(({ path: artifactPath }) => artifactPath);
  const referencedPaths = value.assertions.flatMap(({ artifactPaths: paths }) => paths);
  if (new Set(artifactPaths).size !== artifactPaths.length || artifactPaths.some((artifactPath) => !referencedPaths.includes(artifactPath))
    || referencedPaths.some((artifactPath) => !artifactPaths.includes(artifactPath))) invalidSchema();
  if (request !== undefined) validateInventoryScope(value.cleanupInventory, request);
  assertAssertions(step, value.assertions);
  if ((value.status === 'PASS') !== value.assertions.every(({ status }) => status === 'PASS')) invalidSchema();
  if ((value.status === 'PASS') !== (value.reason === null)) invalidSchema();
  return Object.freeze(value);
}

export function parseStepReceipt(value) {
  const keys = ['schema', 'step', 'identity', 'startedAt', 'observedAt', 'status', 'reason', 'assertions', 'artifacts', 'cleanupInventory', 'redacted', 'fixture'];
  if (!hasExactKeys(value, keys) || value.schema !== 'raibitserver.production-evidence-step-receipt/v1'
    || !STEP_NAMES.includes(value.step) || !EvidenceIdentitySchema.safeParse(value.identity).success
    || !validIso(value.startedAt) || !validIso(value.observedAt) || value.redacted !== true || typeof value.fixture !== 'boolean') invalidSchema();
  parseStepResult({ status: value.status, reason: value.reason, assertions: value.assertions,
    artifacts: value.artifacts, cleanupInventory: value.cleanupInventory }, value.step);
  return Object.freeze(value);
}

export function assertStepReceiptTimeBounds(receipt, deadlineAt) {
  assertTimeBounds(receipt.startedAt, receipt.observedAt, deadlineAt);
}

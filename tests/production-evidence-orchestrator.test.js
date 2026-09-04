import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseStepReceipt,
  parseStepRequest,
  parseStepResult,
  STEP_NAMES,
} from '../scripts/production-evidence/lib/step-contract.mjs';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST } from '../scripts/production-evidence/lib/operator-inputs.mjs';

const identity = () => ({
  runId: randomUUID(), environmentFingerprint: 'a'.repeat(64), sourceCommitSha: 'b'.repeat(40),
  migrationDigest: 'c'.repeat(64), approvedInputSha256: APPROVED_INPUT_SHA256,
  operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: 'd'.repeat(64),
  organizationId: 'org', projectId: 'project', serviceId: 'service', deploymentId: 'deployment', resourceId: 'resource',
});
const secretRefs = [{ kind: 'worker-secretKeyRef', role: 'scanner', binding: 'scanner', namespace: 'system', secretKeyRef: { name: 'scanner-ref', key: 'endpoint', optional: false } }];

test('Given a shared step request, When parsed for its fixed wrapper, Then the strict request is accepted', () => {
  const request = { schema: 'raibitserver.production-evidence-step-request/v1', step: 'runtime', identity: identity(),
    startedAt: '2026-09-04T00:00:00.000Z', deadlineAt: '2026-09-04T00:10:00.000Z', runDirectory: path.resolve('run'),
    selectors: { RAIBITSERVER_RELEASE_KUBE_CONTEXT: 'cluster' }, secretRefs, state: {} };
  assert.equal(parseStepRequest(request, 'runtime').step, 'runtime');
  assert.throws(() => parseStepRequest({ ...request, unexpected: true }, 'runtime'), { reason: 'invalid_step_contract' });
  assert.throws(() => parseStepRequest(request, 'preview'), { reason: 'invalid_step_contract' });
});

test('Given a step result, When assertions escape the step allowlist, Then validation fails closed', () => {
  const artifact = { path: 'artifacts/lifecycle/runtime.json', sha256: 'e'.repeat(64), redacted: true };
  const base = { status: 'PASS', reason: null, assertions: [{ id: 'rollout', status: 'PASS', artifactPaths: [artifact.path] }], artifacts: [artifact], cleanupInventory: [] };
  assert.equal(parseStepResult(base, 'runtime').status, 'PASS');
  assert.throws(() => parseStepResult({ ...base, assertions: [{ ...base.assertions[0], id: 'signature' }] }, 'runtime'), { reason: 'invalid_step_contract' });
});

test('Given every named production step, When dispatch contracts are enumerated, Then all ten fixed wrappers have a stable name', () => {
  assert.deepEqual(STEP_NAMES, ['auth-source', 'supply-chain', 'runtime', 'observability', 'resources', 'backup-sql', 'backup-nosql', 'preview', 'rollback', 'cleanup']);
});

test('Given a complete immutable receipt, When parsed, Then identity and redaction are retained', () => {
  const receipt = { schema: 'raibitserver.production-evidence-step-receipt/v1', step: 'rollback', identity: identity(),
    startedAt: '2026-09-04T00:00:00.000Z', observedAt: '2026-09-04T00:01:00.000Z', status: 'PASS', reason: null,
    assertions: [{ id: 'rollback', status: 'PASS', artifactPaths: ['artifacts/operations/rollback.json'] }],
    artifacts: [{ path: 'artifacts/operations/rollback.json', sha256: 'f'.repeat(64), redacted: true }], cleanupInventory: [], redacted: true, fixture: false };
  assert.equal(parseStepReceipt(receipt).identity.runId, receipt.identity.runId);
});

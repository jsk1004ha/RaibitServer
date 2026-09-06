import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  parseStepReceipt,
  parseStepRequest,
  parseStepResult,
  STEP_NAMES,
} from '../scripts/production-evidence/lib/step-contract.mjs';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { loadOperatorContract } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { orderCleanupInventory, runProductionEvidence } from '../scripts/production-evidence/lib/orchestrator.mjs';
import { createRunnerContext } from '../scripts/production-evidence/lib/run.mjs';
import { parseFixedStepArguments, runFixedStepMain, stepReceiptExitCode } from '../scripts/production-evidence/run-component.mjs';
import { STEP_ASSERTIONS } from '../scripts/production-evidence/lib/step-contract.mjs';
import { parseArguments, parseMatrix } from '../scripts/production-evidence/lib/public-cli.mjs';
import { buildIdentity } from '../scripts/production-evidence/lib/orchestrator-io.mjs';
import { assertVerifiedBindingSnapshot, createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { createUnsafeFixtureArtifactWriter } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';

const identity = () => ({
  runId: randomUUID(), environmentFingerprint: 'a'.repeat(64), sourceCommitSha: 'b'.repeat(40),
  migrationDigest: 'c'.repeat(64), approvedInputSha256: APPROVED_INPUT_SHA256,
  operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: 'd'.repeat(64),
});
const secretRefs = [{ kind: 'worker-secretKeyRef', role: 'scanner', binding: 'scanner', namespace: 'system', secretKeyRef: { name: 'scanner-ref', key: 'endpoint', optional: false } }];
const contract = await loadOperatorContract();
function inputs() {
  const values = ['fixture-context', 'fixture-prefix', 'fixture.example', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
  return { schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: Object.fromEntries(contract.selectors.map(({ name }, index) => [name, values[index]])),
    secretRefs: contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
      ? { role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`, keys: Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key'] }
      : { role, binding, kind, namespace: 'fixture-system', secretKeyRef: { name: `fixture-${role}`, key: 'fixture-key', optional: false } }) };
}
async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'raibit-orchestrator-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function passingStep(request, context) {
  const artifacts = [];
  const byComponent = new Map();
  for (const id of STEP_ASSERTIONS[request.step]) {
    const component = ['provision', 'attach_query', 'backup_checksum', 'isolated_restore', 'resource_delete'].includes(id) ? 'resources'
      : ['usage_quota_audit', 'trusted_proxy', 'metrics', 'rollback'].includes(id) ? 'operations'
        : id.endsWith('_cleanup') || id === 'run_cleanup' ? 'cleanup' : 'lifecycle';
    if (!byComponent.has(component)) {
      const artifact = await context.writeArtifact(component, `${request.step}-${component}.json`, { fixture: true, step: request.step, component, redacted: true });
      byComponent.set(component, artifact); artifacts.push(artifact);
    }
  }
  return { status: 'PASS', reason: null, assertions: STEP_ASSERTIONS[request.step].map((id) => {
    const component = ['provision', 'attach_query', 'backup_checksum', 'isolated_restore', 'resource_delete'].includes(id) ? 'resources'
      : ['usage_quota_audit', 'trusted_proxy', 'metrics', 'rollback'].includes(id) ? 'operations'
        : id.endsWith('_cleanup') || id === 'run_cleanup' ? 'cleanup' : 'lifecycle';
    return { id, status: 'PASS', artifactPaths: [byComponent.get(component).path] };
  }), artifacts, cleanupInventory: [] };
}

test('Given a shared step request, When parsed for its fixed wrapper, Then the strict request is accepted', () => {
  const request = { schema: 'raibitserver.production-evidence-step-request/v1', step: 'runtime', identity: identity(),
    startedAt: '2026-09-04T00:00:00.000Z', deadlineAt: '2026-09-04T00:10:00.000Z', runDirectory: path.resolve('run'),
    selectors: { RAIBITSERVER_RELEASE_KUBE_CONTEXT: 'cluster' }, secretRefs, state: {} };
  assert.equal(parseStepRequest(request, 'runtime').step, 'runtime');
  assert.throws(() => parseStepRequest({ ...request, unexpected: true }, 'runtime'), { reason: 'invalid_step_contract' });
  assert.throws(() => parseStepRequest(request, 'preview'), { reason: 'invalid_step_contract' });
});

test('Given genuine journal bindings, When cleanup inventory is scoped, Then tenant IDs and backup ownership come only from the verified snapshot', async (t) => {
  const runIdentity = identity(); const parent = await sandbox(t); const runDirectory = path.join(parent, runIdentity.runId);
  await mkdir(path.join(runDirectory, 'work'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: runIdentity,
    startedAt: '2026-09-04T00:00:00.000Z' }), { flag: 'wx', mode: 0o600 });
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory,
    allowedPaths: (relative) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(relative) });
  t.after(() => writer.close());
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory, identity: runIdentity, genuineSafeWriter: writer });
  await authority.appendBinding({ role: 'identity', bindingId: 'membership',
    payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'member-a', userId: 'user-a', role: 'OWNER' },
    createdAt: '2026-09-04T00:00:01.000Z' });
  await authority.appendBinding({ role: 'project', bindingId: 'primary',
    payload: { kind: 'project', projectId: 'project-a', organizationId: 'org-a' }, createdAt: '2026-09-04T00:00:02.000Z' });
  await authority.appendBinding({ role: 'resource', bindingId: 'source',
    payload: { kind: 'resource', role: 'source', engine: 'postgresql', resourceId: 'resource-a', projectId: 'project-a' },
    createdAt: '2026-09-04T00:00:03.000Z' });
  await authority.appendBinding({ role: 'backup', bindingId: 'source',
    payload: { kind: 'backup', engine: 'postgresql', backupId: 'backup-a', sourceResourceId: 'resource-a' },
    createdAt: '2026-09-04T00:00:04.000Z' });
  const verifiedBindings = await authority.verifiedBindingSnapshot();
  assert.equal(assertVerifiedBindingSnapshot(verifiedBindings, runIdentity), verifiedBindings);
  assert.equal(Object.isFrozen(verifiedBindings.bindings), true);
  assert.throws(() => assertVerifiedBindingSnapshot(structuredClone(verifiedBindings), runIdentity), { reason: 'invalid_journal_authority' });
  assert.throws(() => assertVerifiedBindingSnapshot(verifiedBindings, identity()), { reason: 'invalid_journal_authority' });
  const request = { schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: runIdentity,
    startedAt: '2026-09-04T00:00:00.000Z', deadlineAt: '2026-09-04T00:00:30.000Z', runDirectory,
    selectors: { RAIBITSERVER_RELEASE_KUBE_CONTEXT: 'cluster' }, secretRefs,
    state: { cleanupNamespace: 'tenant-run', authenticatedClient: { schema: 'raibitserver.production-evidence-client/v1', namespace: 'runtime', podName: 'evidence-client',
      podUid: 'client-uid', podResourceVersion: 'pod-rv-1', networkPolicyUid: 'policy-uid', networkPolicyResourceVersion: 'policy-rv-1',
      apiServiceName: 'raibit-api', apiServiceUid: 'service-uid', port: 3000, expiresAt: '2026-09-04T00:10:00.000Z' }, cleanupInventory: [] } };
  const project = { type: 'control-plane', resourceType: 'project', id: 'project-a', organizationId: 'org-a', projectId: 'project-a' };
  const backup = { type: 'control-plane', resourceType: 'backup', id: 'backup-a', organizationId: 'org-a', projectId: 'project-a' };
  const pod = { type: 'kubernetes', apiVersion: 'v1', kind: 'Pod', namespace: 'runtime', name: 'evidence-client', uid: 'client-uid', resourceVersion: 'pod-rv-1',
    labels: { 'raibitserver.io/run-id': request.identity.runId } };
  const policy = { type: 'kubernetes', apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace: 'runtime', name: 'evidence-client-egress',
    uid: 'policy-uid', resourceVersion: 'policy-rv-1', labels: { 'raibitserver.io/run-id': request.identity.runId } };
  const cleanupRequest = { ...request, state: { ...request.state, cleanupInventory: [project, backup, pod] } };
  assert.throws(() => parseStepRequest(cleanupRequest, 'cleanup'), { reason: 'invalid_step_contract' });
  assert.equal(parseStepRequest(cleanupRequest, 'cleanup', verifiedBindings).step, 'cleanup');
  assert.deepEqual(orderCleanupInventory([pod, project], request.state.authenticatedClient), [project, pod]);
  const foreign = { ...pod, name: 'foreign-pod', uid: 'foreign-uid' };
  assert.throws(() => parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [foreign] } }, 'cleanup', verifiedBindings), { reason: 'invalid_step_contract' });
  assert.throws(() => parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [{ ...backup, id: 'foreign-backup' }] } }, 'cleanup', verifiedBindings), { reason: 'invalid_step_contract' });
  const forgedAttachment = { type: 'control-plane', resourceType: 'attachment', id: 'attachment-a', organizationId: 'org-a', projectId: 'project-a' };
  assert.throws(() => parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [forgedAttachment] } }, 'cleanup', verifiedBindings), { reason: 'invalid_step_contract' });
  assert.equal(parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [pod, policy] } }, 'cleanup').step, 'cleanup');
  assert.throws(() => parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [{ ...pod, resourceVersion: undefined }] } }, 'cleanup'), { reason: 'invalid_step_contract' });
  assert.throws(() => parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [{ ...policy, resourceVersion: 'foreign-rv' }] } }, 'cleanup'), { reason: 'invalid_step_contract' });
});

test('Given fixture environment facts, When the run identity is built, Then it contains exactly the seven provenance fields', async () => {
  const value = await buildIdentity({ inputs: inputs(), runId: randomUUID(), root: process.cwd(), fixture: true });
  assert.deepEqual(Object.keys(value).sort(), ['approvedInputSha256', 'environmentFingerprint', 'migrationDigest', 'operatorContractDigest',
    'operatorInputFingerprint', 'runId', 'sourceCommitSha']);
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

test('Given public production arguments, When duplicates, unknowns, or mixed modes appear, Then parsing rejects them before any run', () => {
  const parent = path.resolve('attempt');
  assert.deepEqual(parseArguments(['--profile', 'train-a', '--scenario', 'happy', '--attempt-dir', parent]), { attemptDir: parent, scenario: 'happy', faultPath: undefined });
  for (const args of [
    ['--profile', 'train-a', '--profile', 'train-a', '--scenario', 'happy', '--attempt-dir', parent],
    ['--profile', 'other', '--scenario', 'happy', '--attempt-dir', parent],
    ['--profile', 'train-a', '--scenario', 'happy', '--fault-matrix', path.resolve('fault.json'), '--attempt-dir', parent],
    ['--profile', 'train-a', '--unknown', 'value', '--attempt-dir', parent],
  ]) assert.throws(() => parseArguments(args), { reason: 'invalid_arguments' });
});

test('Given the exported orchestrator, When scenario and fault mode are not the exact union, Then it rejects before setup', async () => {
  const base = { profile: 'train-a', attemptDir: path.resolve('attempt'), inputs: inputs(), executeStep: null,
    clock: { now: () => new Date() }, uuid: randomUUID, fixture: false };
  const fault = { id: 'runtime-failure', boundary: 'runtime', mode: 'command-failure', expectedReason: 'command_failure' };
  await assert.rejects(runProductionEvidence({ ...base, scenario: 'typo', faultMatrix: fault }), { reason: 'invalid_arguments' });
  await assert.rejects(runProductionEvidence({ ...base, scenario: null, faultMatrix: null }), { reason: 'invalid_arguments' });
  await assert.rejects(runProductionEvidence({ ...base, scenario: 'happy', faultMatrix: fault }), { reason: 'invalid_arguments' });
});

test('Given the public HTTP transport, When a caller supplies localhost, credentials, or an unsupported method, Then it fails before I/O', async () => {
  const context = createRunnerContext(path.resolve('run'), new Date(Date.now() + 60_000).toISOString());
  await assert.rejects(context.requestJson({ method: 'GET', url: 'http://127.0.0.1:18080/api/auth/me' }), { reason: 'invalid_request' });
  await assert.rejects(context.requestJson({ method: 'GET', url: 'https://user:pass@example.test/api/auth/me' }), { reason: 'invalid_request' });
  await assert.rejects(context.requestJson({ method: 'TRACE', url: 'https://example.test/' }), { reason: 'invalid_request' });
});

test('Given a fixed step wrapper, When arguments are parsed, Then no operator-selectable step is accepted', () => {
  const requestPath = path.resolve('request.json'), outputPath = path.resolve('output.json');
  assert.deepEqual(parseFixedStepArguments(['--request', requestPath, '--output', outputPath]), { requestPath, outputPath });
  assert.throws(() => parseFixedStepArguments(['--step', 'runtime', '--request', requestPath, '--output', outputPath]), { reason: 'invalid_arguments' });
});

test('Given a fixed runner result, When its process outcome is selected, Then PASS is 0, evidence failures are 1, and harness failures are 2', async () => {
  assert.equal(stepReceiptExitCode({ status: 'PASS' }), 0);
  assert.equal(stepReceiptExitCode({ status: 'FAIL' }), 1);
  assert.equal(stepReceiptExitCode({ status: 'NOT_RUN' }), 1);
  assert.throws(() => stepReceiptExitCode({ status: 'UNKNOWN' }), { reason: 'invalid_step_contract' });
  let stderr = '';
  const harness = await runFixedStepMain('runtime', ['--step', 'runtime'], { stderr: { write: (value) => { stderr += value; } } });
  assert.deepEqual(harness, { receipt: null, status: 'NOT_RUN', reason: 'direct_component_execution_forbidden', exitCode: 1 });
  assert.equal(stderr, 'direct_component_execution_forbidden\n');
});

test('Given a fault matrix, When its strict boundary or mode contract drifts, Then parsing fails closed', () => {
  const value = { schema: 'raibitserver.production-evidence-fault-matrix/v1', cases: [{ id: 'runtime-failure', boundary: 'runtime', mode: 'command-failure', expectedReason: 'command_failure' }] };
  assert.deepEqual(parseMatrix(value), value);
  assert.throws(() => parseMatrix({ ...value, cases: [{ ...value.cases[0], step: 'runtime' }] }), { reason: 'invalid_fault_matrix' });
  assert.throws(() => parseMatrix({ ...value, cases: [{ ...value.cases[0], expectedReason: 'chosen_by_fixture' }] }), { reason: 'invalid_fault_matrix' });
  assert.throws(() => parseMatrix({ ...value, cases: [{ ...value.cases[0], boundary: 'preflight' }] }), { reason: 'invalid_fault_matrix' });
  assert.throws(() => parseMatrix({ ...value, cases: [{ ...value.cases[0], boundary: 'verifier', mode: 'cleanup-leak', expectedReason: 'cleanup_failed' }] }), { reason: 'invalid_fault_matrix' });
});

test('Given a complete immutable receipt, When parsed, Then identity and redaction are retained', () => {
  const receipt = { schema: 'raibitserver.production-evidence-step-receipt/v1', step: 'rollback', identity: identity(),
    startedAt: '2026-09-04T00:00:00.000Z', observedAt: '2026-09-04T00:01:00.000Z', status: 'PASS', reason: null,
    assertions: [{ id: 'rollback', status: 'PASS', artifactPaths: ['artifacts/operations/rollback.json'] }],
    artifacts: [{ path: 'artifacts/operations/rollback.json', sha256: 'f'.repeat(64), redacted: true }], cleanupInventory: [], redacted: true, fixture: false };
  assert.equal(parseStepReceipt(receipt).identity.runId, receipt.identity.runId);
});

test('Given injected steps, When the complete run finishes, Then all ten committed receipts remain release ineligible', async (t) => {
  const attemptDir = await sandbox(t);
  const observed = new Date();
  const result = await runProductionEvidence({ profile: 'train-a', scenario: 'happy', faultMatrix: null, attemptDir, inputs: inputs(),
    executeStep: passingStep, clock: { now: () => observed }, uuid: randomUUID, fixture: false });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(result.verification.releaseEligible, false);
  assert.equal(manifest.fixture, true);
  assert.equal(Object.hasOwn(manifest, 'releaseEligible'), false);
  assert.equal(existsSync(path.join(result.runDirectory, 'work')), false);
  assert.equal(existsSync(path.join(result.runDirectory, 'cleanup', 'run.json')), true);
  for (const component of ['local', 'cluster', 'lifecycle', 'resources', 'operations']) {
    assert.equal(existsSync(path.join(result.runDirectory, `${component}.json`)), true);
  }
});

test('Given a runtime executor crash, When the run continues, Then later external steps stop and cleanup executes', async (t) => {
  const attemptDir = await sandbox(t);
  const observed = new Date();
  const calls = [];
  const executor = async (request, context) => {
    calls.push(request.step);
    if (request.step === 'runtime') throw new Error('runner crashed');
    return passingStep(request, context);
  };
  const result = await runProductionEvidence({ profile: 'train-a', scenario: 'happy', faultMatrix: null, attemptDir, inputs: inputs(),
    executeStep: executor, clock: { now: () => observed }, uuid: randomUUID, fixture: true });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(calls.includes('cleanup'), true);
  assert.deepEqual(calls, ['auth-source', 'supply-chain', 'runtime', 'cleanup']);
  assert.equal(manifest.fragments.find(({ component }) => component === 'lifecycle').status, 'FAIL');
  assert.equal(JSON.parse(await readFile(path.join(result.runDirectory, 'artifacts', 'lifecycle', 'preview.json'), 'utf8')).status, 'NOT_RUN');
});

test('Given failed cleanup, When the run finalizes, Then it preserves the cleanup failure', async (t) => {
  const attemptDir = await sandbox(t);
  const executor = async (request, context) => {
    if (request.step !== 'cleanup') return passingStep(request, context);
    const artifact = await context.writeArtifact('cleanup', 'cleanup-failure.json', { fixture: true, status: 'FAIL', redacted: true });
    return { status: 'FAIL', reason: 'cleanup_failed', assertions: STEP_ASSERTIONS.cleanup.map((id) => ({ id, status: 'FAIL', artifactPaths: [artifact.path] })),
      artifacts: [artifact], cleanupInventory: [] };
  };
  const result = await runProductionEvidence({ profile: 'train-a', scenario: null,
    faultMatrix: { id: 'cleanup-leak', boundary: 'cleanup', mode: 'cleanup-leak', expectedReason: 'cleanup_failed' },
    attemptDir, inputs: inputs(), executeStep: executor, clock: { now: () => new Date() }, uuid: randomUUID, fixture: true });
  assert.equal(result.reason, 'cleanup_failed');
  assert.equal(result.verification.releaseEligible, false);
});

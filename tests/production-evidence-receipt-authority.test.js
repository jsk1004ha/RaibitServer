import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { canonical, digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import {
  assertPreparedStep, assertReceiptAuthority, assertReceiptJournalSnapshot, assertVerifiedStepReceipt,
  createReceiptAuthorityFixtureUnsafe,
} from '../scripts/production-evidence/lib/receipt-authority.mjs';
import { STEP_NAMES } from '../scripts/production-evidence/lib/step-contract.mjs';
import { executeStepRequest, runFixedStepMain } from '../scripts/production-evidence/run-component.mjs';
import { generated, INPUTS, sandbox } from './fixtures/receipt-authority-fixture.mjs';

async function harness(t) {
  const fixture = await sandbox(t);
  const journalAuthority = await createJournalAuthorityFixtureUnsafe({ runDirectory: fixture.runDirectory,
    identity: fixture.runIdentity, genuineSafeWriter: fixture.writer });
  const authority = await createReceiptAuthorityFixtureUnsafe({ runDirectory: fixture.runDirectory,
    identity: fixture.runIdentity, fullOperatorInput: INPUTS, genuineSafeWriter: fixture.writer, journalAuthority,
    stateProjector: () => ({ cleanupNamespace: 'evidence-run' }) });
  return { ...fixture, authority, journalAuthority };
}

function observed(fixture, step = 'auth-source', index = STEP_NAMES.indexOf(step)) {
  const startedAt = new Date(Date.parse(fixture.startedAt) + Math.max(index, 0) * 60_000).toISOString();
  return { startedAt, deadlineAt: new Date(Date.parse(startedAt) + (step === 'cleanup' ? 30_000 : 60_000)).toISOString() };
}

function candidate(prepared, identity, status = 'PASS', requestSha256 = prepared.requestSha256) {
  return { schema: 'raibitserver.production-evidence-step-receipt/v2', step: prepared.step, requestSha256,
    identity, startedAt: prepared.request.startedAt, ...generated(prepared, status), redacted: true };
}

async function materializedCandidate(fixture, execution, status = 'PASS') {
  const value = candidate(execution, fixture.runIdentity, status);
  const artifacts = [];
  for (const [index, artifact] of value.artifacts.entries()) {
    const descriptor = await fixture.writer.writeJson(artifact.path, { schema: 'raibitserver.production-evidence-observation/v1',
      step: execution.step, assertion: value.assertions[index].id, status, redacted: true });
    artifacts.push(descriptor);
  }
  return { ...value, artifacts };
}

async function commit(fixture, step, index, status = 'PASS') {
  const prepared = await fixture.authority.prepareStep(step, observed(fixture, step));
  const pending = await fixture.authority.executePreparedStep(prepared,
    async (value) => materializedCandidate(fixture, value, status));
  return fixture.authority.commitCandidate(prepared, pending);
}

test('Given a genuine run writer and identity-bound full input, When authority is created, Then forged and cross-run authorities are rejected', async (t) => {
  const fixture = await harness(t);
  assert.equal(assertReceiptAuthority(fixture.authority), fixture.authority);
  assert.throws(() => assertReceiptAuthority(Object.freeze({})), { reason: 'invalid_receipt_authority' });
  await assert.rejects(createReceiptAuthorityFixtureUnsafe({ runDirectory: fixture.runDirectory, identity: fixture.runIdentity,
    fullOperatorInput: INPUTS, genuineSafeWriter: {}, journalAuthority: fixture.journalAuthority,
    stateProjector: () => ({}) }), { reason: 'invalid_artifact_writer' });
  const other = await sandbox(t);
  await assert.rejects(createReceiptAuthorityFixtureUnsafe({ runDirectory: other.runDirectory, identity: other.runIdentity,
    fullOperatorInput: INPUTS, genuineSafeWriter: fixture.writer, journalAuthority: fixture.journalAuthority,
    stateProjector: () => ({}) }), { reason: 'invalid_journal_authority' });
});

test('Given all fixed steps and terminal statuses, When committed once in order, Then physical branded receipts survive work removal', async (t) => {
  const fixture = await harness(t);
  const statuses = ['PASS', 'FAIL', ...Array(7).fill('NOT_RUN'), 'FAIL'];
  for (const [index, step] of STEP_NAMES.entries()) {
    const view = await commit(fixture, step, index, statuses[index]);
    assert.equal(assertVerifiedStepReceipt(view, step), view);
    assert.equal(Object.isFrozen(view.receipt.assertions[0]), true);
  }
  await rm(path.join(fixture.runDirectory, 'work'), { recursive: true });
  const loaded = await fixture.authority.loadCommitted();
  assert.deepEqual(loaded.map(({ step }) => step), STEP_NAMES);
  assert.equal(Object.isFrozen(loaded), true);
  const snapshot = await fixture.authority.snapshot();
  assert.equal(assertReceiptJournalSnapshot(snapshot), snapshot);
  assert.equal(snapshot.entryCount, STEP_NAMES.length);
});

test('Given a prepared step, When the executor returns a different request digest, Then capability is consumed and no receipt is written', async (t) => {
  const fixture = await harness(t);
  const prepared = await fixture.authority.prepareStep('auth-source', observed(fixture));
  let invoked = 0;
  let expiredExecution;
  await assert.rejects(fixture.authority.executePreparedStep(prepared, async (value) => {
    invoked += 1; expiredExecution = value; return candidate(value, fixture.runIdentity, 'PASS', 'f'.repeat(64));
  }), { reason: 'request_digest_mismatch' });
  assert.equal(invoked, 1);
  await assert.rejects(fixture.authority.executePreparedStep(prepared, async () => assert.fail('must not run')), { reason: 'reused_receipt' });
  await assert.rejects(executeStepRequest(expiredExecution), { reason: 'receipt_authority_unavailable' });
  assert.deepEqual(await fixture.authority.loadCommitted(), []);
});

test('Given an exact candidate, When authority commits it, Then the descriptor hashes physically reloaded canonical bytes', async (t) => {
  const fixture = await harness(t);
  const prepared = await fixture.authority.prepareStep('auth-source', observed(fixture));
  let canonicalRequestDigest;
  const pending = await fixture.authority.executePreparedStep(prepared, async (execution) => {
    canonicalRequestDigest = digest(`${JSON.stringify(canonical(execution.request))}\n`);
    assert.deepEqual(execution.request.secretRefs.map(({ role }) => role), ['github']);
    return materializedCandidate(fixture, execution);
  });
  const view = await fixture.authority.commitCandidate(prepared, pending);
  const bytes = await readFile(path.join(fixture.runDirectory, ...view.descriptor.path.split('/')));
  assert.equal(prepared.requestSha256, canonicalRequestDigest);
  assert.equal(view.descriptor.sha256, digest(bytes));
  assert.equal(view.receipt.requestSha256, view.requestSha256);
  const preparation = await readFile(path.join(fixture.runDirectory, 'receipt-requests', '000001--auth-source.json'), 'utf8');
  assert.equal(preparation.includes('selectors'), false);
  assert.equal(preparation.includes('secretRefs'), false);
  assert.equal(preparation.includes('cleanupNamespace'), false);
});

test('Given fixed ordering and private brands, When raw, early, duplicate, or concurrent requests are attempted, Then no executor is reached', async (t) => {
  const fixture = await harness(t);
  await assert.rejects(fixture.authority.prepareStep('runtime', observed(fixture, 'runtime')), { reason: 'invalid_receipt_order' });
  await assert.rejects(fixture.authority.prepareStep('auth-source', { ...observed(fixture), state: {} }), { reason: 'invalid_arguments' });
  await assert.rejects(executeStepRequest({ step: 'auth-source' }), { reason: 'receipt_authority_unavailable' });
  const first = await fixture.authority.prepareStep('auth-source', observed(fixture));
  assert.equal(assertPreparedStep(first, 'auth-source'), first);
  await assert.rejects(fixture.authority.prepareStep('auth-source', observed(fixture)), { reason: 'reused_receipt' });
  const pending = await fixture.authority.executePreparedStep(first, async (value) => materializedCandidate(fixture, value));
  await fixture.authority.commitCandidate(first, pending);
  await assert.rejects(fixture.authority.commitCandidate(first, pending), { reason: 'reused_receipt' });
});

test('Given committed evidence, When physical receipt bytes are replaced, Then reload detects tamper', async (t) => {
  const fixture = await harness(t);
  const view = await commit(fixture, 'auth-source', 0);
  const target = path.join(fixture.runDirectory, ...view.descriptor.path.split('/'));
  await writeFile(target, `${JSON.stringify({ ...view.receipt, reason: 'tampered' })}\n`);
  await assert.rejects(fixture.authority.loadCommitted(), { reason: 'receipt_digest_mismatch' });
});

test('Given candidate artifact descriptors, When files are missing, swapped, or tampered, Then commit rejects them before receipt persistence', async (t) => {
  {
    const fixture = await harness(t);
    const prepared = await fixture.authority.prepareStep('auth-source', observed(fixture));
    const pending = await fixture.authority.executePreparedStep(prepared, async (execution) => candidate(execution, fixture.runIdentity));
    await assert.rejects(fixture.authority.commitCandidate(prepared, pending), { reason: 'missing_receipt_artifact' });
  }
  {
    const fixture = await harness(t);
    const prepared = await fixture.authority.prepareStep('auth-source', observed(fixture));
    const pending = await fixture.authority.executePreparedStep(prepared, async (execution) => {
      const value = await materializedCandidate(fixture, execution);
      const wrongPath = 'artifacts/lifecycle/auth-source-wrong-observation.json';
      const descriptor = await fixture.writer.writeJson(wrongPath, { schema: 'raibitserver.production-evidence-observation/v1', redacted: true });
      return { ...value, assertions: [{ ...value.assertions[0], artifactPaths: [wrongPath] }], artifacts: [descriptor] };
    });
    await assert.rejects(fixture.authority.commitCandidate(prepared, pending), { reason: 'invalid_receipt_artifact' });
  }
  {
    const fixture = await harness(t);
    const prepared = await fixture.authority.prepareStep('auth-source', observed(fixture));
    const pending = await fixture.authority.executePreparedStep(prepared, async (execution) => materializedCandidate(fixture, execution));
    await writeFile(path.join(fixture.runDirectory, ...pending.receipt.artifacts[0].path.split('/')), '{"tampered":true}\n');
    await assert.rejects(fixture.authority.commitCandidate(prepared, pending), { reason: 'receipt_artifact_digest_mismatch' });
  }
});

test('Given a recomputed preparation entry hash, When identity fingerprint or time budget is changed, Then physical reload rejects it', async (t) => {
  for (const mutate of [
    (entry) => { entry.operatorInputFingerprint = 'f'.repeat(64); },
    (entry) => { entry.deadlineAt = new Date(Date.parse(entry.startedAt) + 120_000).toISOString(); },
  ]) {
    const fixture = await harness(t);
    await fixture.authority.prepareStep('auth-source', observed(fixture));
    const target = path.join(fixture.runDirectory, 'receipt-requests', '000001--auth-source.json');
    const entry = JSON.parse(await readFile(target, 'utf8'));
    mutate(entry);
    const { entrySha256: ignored, ...unsigned } = entry;
    void ignored;
    entry.entrySha256 = digest(unsigned);
    await writeFile(target, `${JSON.stringify(entry)}\n`);
    await assert.rejects(fixture.authority.loadCommitted(), (error) => ['invalid_receipt_journal', 'journal_write_poisoned'].includes(error.reason));
  }
});

test('Given branded outputs, When clones or raw JSON are asserted, Then they cannot reach state or manifest projection', async (t) => {
  const fixture = await harness(t);
  const view = await commit(fixture, 'auth-source', 0);
  assert.throws(() => assertVerifiedStepReceipt(structuredClone(view)), { reason: 'invalid_verified_receipt' });
  assert.throws(() => assertVerifiedStepReceipt(view.receipt), { reason: 'invalid_verified_receipt' });
  const snapshot = await fixture.authority.snapshot();
  assert.throws(() => assertReceiptJournalSnapshot(structuredClone(snapshot)), { reason: 'invalid_receipt_snapshot' });
});

test('Given full input changed after identity creation, When authority is requested, Then it rejects before receipt directories exist', async (t) => {
  const fixture = await sandbox(t);
  const journalAuthority = await createJournalAuthorityFixtureUnsafe({ runDirectory: fixture.runDirectory,
    identity: fixture.runIdentity, genuineSafeWriter: fixture.writer });
  const changed = { ...INPUTS, selectors: { ...INPUTS.selectors, RAIBITSERVER_RELEASE_KUBE_CONTEXT: 'other' } };
  await assert.rejects(createReceiptAuthorityFixtureUnsafe({ runDirectory: fixture.runDirectory, identity: fixture.runIdentity,
    fullOperatorInput: changed, genuineSafeWriter: fixture.writer, journalAuthority,
    stateProjector: () => ({}) }), { reason: 'operator_input_fingerprint_mismatch' });
});

test('Given a public fixed-step wrapper, When any request and output paths are supplied, Then it is NOT_RUN before filesystem access', async () => {
  const stderr = [];
  const result = await runFixedStepMain('auth-source', ['--request', path.resolve('missing.json'), '--output', path.resolve('output.json')],
    { stderr: { write: (value) => stderr.push(value) } });
  assert.deepEqual(result, { receipt: null, status: 'NOT_RUN', reason: 'direct_component_execution_forbidden', exitCode: 1 });
  assert.deepEqual(stderr, ['direct_component_execution_forbidden\n']);
});

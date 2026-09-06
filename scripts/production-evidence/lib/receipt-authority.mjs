import { canonical, digest, EvidenceError, loadOperatorContract, OPERATOR_CONTRACT_DIGEST, parseOperatorInputs } from './operator-inputs.mjs';
import { assertSafeArtifactWriter } from './safe-artifact-writer.mjs';
import { parseStepReceipt, parseStepResult, projectStepRequest, stepNamesForIdentity } from './step-contract.mjs';
import { validateJournalRoot, withJournalTransaction } from './journal-io.mjs';
import { assertJournalAuthority } from './journal-authority.mjs';
import { deriveProductionEvidenceStepState } from './state-projection.mjs';
import { createRunnerContext } from './runner-context.mjs';
import { failedStepReceipt } from './step-execution.mjs';
import { appendReceiptProvenance } from './receipt-provenance.mjs';
import {
  appendPreparation, appendReceiptEntry, initializeReceiptDirectories, loadReceiptState, receiptPath, verifyCandidateArtifacts,
} from './receipt-authority-files.mjs';

const authorities = new WeakSet();
const sealContexts = new WeakMap();
const committedSealReceipts = new WeakMap();
const completedSealJournals = new WeakMap();
const authorityWriters = new WeakSet();
const preparedValues = new WeakMap();
const executionValues = new WeakMap();
const candidateValues = new WeakMap();
const verifiedValues = new WeakSet();
const snapshots = new WeakSet();
const progressions = new WeakSet();
const STEP_BUDGET_MS = Object.freeze({
  'auth-source': 60_000, 'supply-chain': 45 * 60_000, runtime: 13 * 60_000, observability: 5 * 60_000,
  resources: 30 * 60_000, 'backup-sql': 30 * 60_000, 'backup-nosql': 30 * 60_000,
  preview: 10 * 60_000, rollback: 10 * 60_000, cleanup: 30_000,
  domains: 45 * 60_000,
});
const fail = (reason) => { throw new EvidenceError(reason); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutable(item)])));
  }
  return value;
}

function verifiedView(record) {
  const view = immutable({ schema: 'raibitserver.production-evidence-verified-step-receipt/v1',
    sequence: record.entry.sequence, step: record.entry.step, requestSha256: record.entry.requestSha256,
    receipt: record.receipt, descriptor: record.descriptor });
  verifiedValues.add(view); return view;
}

export function assertReceiptAuthority(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !authorities.has(value)) fail('invalid_receipt_authority');
  return value;
}

export async function receiptAuthoritySealContext(value) {
  const authority = assertReceiptAuthority(value);
  const receipts = await authority.loadCommitted();
  const snapshot = await authority.snapshot();
  const genuine = committedSealReceipts.get(authority);
  const context = sealContexts.get(authority), pinned = completedSealJournals.get(authority);
  const stepNames = stepNamesForIdentity(context.identity);
  if (snapshot.entryCount !== stepNames.length || genuine.length !== stepNames.length || receipts.some(({ receipt }) => receipt.status !== 'PASS'
    || receipt.assertions.some(({ status }) => status !== 'PASS'))) fail('incomplete_receipt_authority');
  const claims = values => values.map(({ step, requestSha256, receipt, descriptor }) => ({ step, requestSha256, receipt, descriptor }));
  if (digest(claims(receipts)) !== digest(claims(genuine))) fail('receipt_authority_mutated');
  const runtime = { context: context.fullOperatorInput.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT,
    namespace: context.fullOperatorInput.secretRefs.find(reference => reference.role === 'runtime')?.namespace };
  const [bindings, cleanup] = await Promise.all([context.journalAuthority.bindingSnapshot(), context.journalAuthority.cleanupSnapshot({ approvedRuntimeSelector: runtime })]);
  if (!pinned || bindings.entriesSha256 !== pinned.bindingJournalSha256 || cleanup.entriesSha256 !== pinned.cleanupJournalSha256) fail('receipt_authority_mutated');
  return Object.freeze({ ...context, ...pinned, committedReceiptsSha256: digest(claims(genuine)) });
}

export function assertVerifiedStepReceipt(value, expectedStep = undefined) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !verifiedValues.has(value)
    || (expectedStep !== undefined && value.step !== expectedStep)) fail('invalid_verified_receipt');
  return value;
}

export function assertPreparedStep(value, expectedStep = undefined) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !preparedValues.has(value)
    || (expectedStep !== undefined && value.step !== expectedStep)) fail('receipt_authority_unavailable');
  return value;
}

export function assertReceiptExecution(value, expectedStep = undefined) {
  const metadata = (typeof value === 'object' || typeof value === 'function') && value !== null ? executionValues.get(value) : null;
  if (!metadata?.active || (expectedStep !== undefined && value.step !== expectedStep)) fail('receipt_authority_unavailable');
  return value;
}

export function assertReceiptJournalSnapshot(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !snapshots.has(value)) fail('invalid_receipt_snapshot');
  return value;
}

export function assertReceiptProgression(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !progressions.has(value)) fail('invalid_receipt_progression');
  return value;
}

async function create(options, unsafeFixture) {
  const keys = unsafeFixture
    ? ['runDirectory', 'identity', 'fullOperatorInput', 'genuineSafeWriter', 'journalAuthority', 'stateProjector', ...(Object.hasOwn(options, 'bootstrap') ? ['bootstrap'] : [])]
    : ['runDirectory', 'identity', 'fullOperatorInput', 'genuineSafeWriter', 'journalAuthority'];
  if (!exact(options, keys) || (unsafeFixture && typeof options.stateProjector !== 'function')) fail('invalid_receipt_authority');
  const { runDirectory, identity, genuineSafeWriter: writer } = options;
  const stepNames = stepNamesForIdentity(identity);
  const journalAuthority = assertJournalAuthority(options.journalAuthority);
  const scope = await journalAuthority.bindingSnapshot();
  if (scope.runIdentitySha256 !== digest(identity)) fail('invalid_journal_authority');
  const fullOperatorInput = immutable(options.fullOperatorInput);
  if (!exact(fullOperatorInput, ['schema', 'approvedInputSha256', 'operatorContractDigest', 'selectors', 'secretRefs'])
    || fullOperatorInput.schema !== 'raibitserver.operator-input-values/v1'
    || fullOperatorInput.approvedInputSha256 !== identity.approvedInputSha256
    || fullOperatorInput.operatorContractDigest !== OPERATOR_CONTRACT_DIGEST
    || digest(fullOperatorInput) !== identity.operatorInputFingerprint) fail('operator_input_fingerprint_mismatch');
  parseOperatorInputs(fullOperatorInput, await loadOperatorContract());
  assertSafeArtifactWriter(writer, runDirectory);
  if (authorityWriters.has(writer)) fail('invalid_receipt_authority');
  await validateJournalRoot(runDirectory, identity, writer, unsafeFixture);
  await initializeReceiptDirectories(runDirectory, identity, unsafeFixture);
  authorityWriters.add(writer);
  let authority;
  const bootstrap = unsafeFixture ? options.bootstrap ?? null : await (await import('./production-bootstrap.mjs')).createProductionBootstrap({
    runDirectory, identity, fullOperatorInput, writer, journalAuthority });
  const contextFor = (request) => bootstrap?.contextFor(request) ?? Object.freeze({
    ...createRunnerContext(runDirectory, request.deadlineAt, { now: () => new Date(request.startedAt) }), journalAuthority,
    writeArtifact: (component, name, value) => writer.writeJson(component === 'cleanup' ? `cleanup/${name}` : `artifacts/${component}/${name}`, value),
  });

  async function load() {
    const state = await loadReceiptState(runDirectory, identity, unsafeFixture);
    for (const record of state.receipts) await verifyCandidateArtifacts(runDirectory, record.receipt, unsafeFixture);
    return { ...state, views: Object.freeze(state.receipts.map(verifiedView)) };
  }

  async function prepareStep(step, timing) {
    if (!stepNames.includes(step) || !exact(timing, ['startedAt', 'deadlineAt'])
      || !Number.isFinite(Date.parse(timing.startedAt)) || new Date(timing.startedAt).toISOString() !== timing.startedAt
      || !Number.isFinite(Date.parse(timing.deadlineAt)) || new Date(timing.deadlineAt).toISOString() !== timing.deadlineAt
      || Date.parse(timing.deadlineAt) <= Date.parse(timing.startedAt)
      || Date.parse(timing.deadlineAt) - Date.parse(timing.startedAt) > STEP_BUDGET_MS[step]) fail('invalid_arguments');
    const state = await load();
    if (state.preparations.length !== state.entries.length) fail('reused_receipt');
    if (stepNames[state.entries.length] !== step) fail('invalid_receipt_order');
    const bindingSnapshot = await journalAuthority.bindingSnapshot();
    const bindingEntries = await journalAuthority.loadBindings();
    if (bindingSnapshot.runIdentitySha256 !== digest(identity) || bindingSnapshot.entriesSha256 !== digest(bindingEntries)) fail('invalid_journal_authority');
    const committedSteps = [];
    for (const [index, record] of state.receipts.entries()) committedSteps.push(immutable({ ...state.views[index],
      observations: await verifyCandidateArtifacts(runDirectory, record.receipt, unsafeFixture) }));
    const projector = unsafeFixture ? options.stateProjector : deriveProductionEvidenceStepState;
    let blocked = step !== 'cleanup' && (bootstrap?.reason ?? (state.views.some(({ receipt }) => receipt.status !== 'PASS') ? 'dependency_failed' : null));
    let projectedState;
    try { projectedState = projector({ step, identity, fullOperatorInput, bootstrap: bootstrap?.state ?? null,
      bindingSnapshot, bindingEntries, committedSteps }); }
    catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      blocked = error.reason;
      projectedState = { cleanupNamespace: `${fullOperatorInput.selectors.RAIBITSERVER_RELEASE_NAMESPACE_PREFIX}-${identity.runId.replaceAll('-', '').slice(0, 8)}`,
        cleanupInventory: [], ...(bootstrap?.state?.authenticatedClient ? { authenticatedClient: bootstrap.state.authenticatedClient } : {}) };
    }
    const fullRequest = { schema: 'raibitserver.production-evidence-step-request/v1', step, identity,
      startedAt: timing.startedAt, deadlineAt: timing.deadlineAt, runDirectory,
      selectors: fullOperatorInput.selectors, secretRefs: fullOperatorInput.secretRefs, state: immutable(projectedState) };
    const projected = projectStepRequest(fullRequest, await journalAuthority.verifiedBindingSnapshot());
    if (digest(projected.identity) !== digest(identity) || projected.runDirectory !== runDirectory) fail('identity_mismatch');
    return withJournalTransaction(writer, async () => {
      const state = await loadReceiptState(runDirectory, identity, unsafeFixture);
      if (state.preparations.length !== state.entries.length) fail('reused_receipt');
      const sequence = state.entries.length + 1;
      if (stepNames[sequence - 1] !== projected.step) fail('invalid_receipt_order');
      const requestBytes = `${JSON.stringify(canonical(projected))}\n`;
      const unsigned = { schema: 'raibitserver.production-evidence-receipt-preparation/v1', sequence, step: projected.step,
        runIdentitySha256: digest(identity), operatorInputFingerprint: identity.operatorInputFingerprint,
        requestSha256: digest(requestBytes), startedAt: projected.startedAt, deadlineAt: projected.deadlineAt,
        previousEntrySha256: state.preparations.at(-1)?.entrySha256 ?? null };
      const entry = immutable({ ...unsigned, entrySha256: digest(unsigned) });
      await appendPreparation(runDirectory, entry, writer, unsafeFixture);
      const prepared = Object.freeze({ step: projected.step, requestSha256: entry.requestSha256 });
      preparedValues.set(prepared, { authority, phase: 'prepared', entry, request: projected, requestBytes,
        blocked });
      return prepared;
    }, runDirectory);
  }

  async function commit(prepared, candidate) {
    const metadata = preparedValues.get(prepared);
    const candidateMetadata = candidateValues.get(candidate);
    if (!metadata || metadata.authority !== authority || metadata.phase !== 'candidate'
      || !candidateMetadata || candidateMetadata.authority !== authority || candidateMetadata.prepared !== prepared) fail('reused_receipt');
    metadata.phase = 'committing';
    const bindingProof = await journalAuthority.verifiedBindingSnapshot();
    let writeStarted = false;
    try {
      const committed = await withJournalTransaction(writer, async () => {
      const state = await loadReceiptState(runDirectory, identity, unsafeFixture);
      if (state.preparations.length !== state.entries.length + 1
        || state.preparations.at(-1).entrySha256 !== metadata.entry.entrySha256) fail('invalid_receipt_journal');
      const receipt = parseStepReceipt(candidate.receipt, metadata.request, bindingProof);
      if (receipt.schema !== 'raibitserver.production-evidence-step-receipt/v2'
        || receipt.requestSha256 !== prepared.requestSha256) fail('request_digest_mismatch');
      await verifyCandidateArtifacts(runDirectory, receipt, unsafeFixture);
      writeStarted = true;
      const descriptor = await writer.writeJson(receiptPath(receipt.step), receipt);
      const unsigned = { schema: 'raibitserver.production-evidence-receipt-entry/v1', sequence: metadata.entry.sequence,
        step: receipt.step, runIdentitySha256: digest(identity), requestSha256: prepared.requestSha256,
        preparationEntrySha256: metadata.entry.entrySha256, receiptPath: descriptor.path, receiptSha256: descriptor.sha256,
        previousEntrySha256: state.entries.at(-1)?.entrySha256 ?? null };
      await appendReceiptEntry(runDirectory, immutable({ ...unsigned, entrySha256: digest(unsigned) }), writer, unsafeFixture);
      const loaded = await load(); return loaded.views.at(-1);
    }, runDirectory);
      if (!unsafeFixture || options.bootstrap) await appendReceiptProvenance({ committed, journalAuthority, observations: await verifyCandidateArtifacts(runDirectory, committed.receipt, unsafeFixture) });
      if (committed.step === stepNamesForIdentity(identity).at(-1)) {
        const runtime = { context: fullOperatorInput.selectors.RAIBITSERVER_RELEASE_KUBE_CONTEXT,
          namespace: fullOperatorInput.secretRefs.find(reference => reference.role === 'runtime')?.namespace };
        const [bindings, cleanup] = await Promise.all([journalAuthority.bindingSnapshot(), journalAuthority.cleanupSnapshot({ approvedRuntimeSelector: runtime })]);
        completedSealJournals.set(authority, Object.freeze({ bindingJournalSha256: bindings.entriesSha256, cleanupJournalSha256: cleanup.entriesSha256 }));
      }
      committedSealReceipts.get(authority).push(committed);
      return committed;
    }
    catch (error) {
      if (writeStarted) await writer.close().catch(() => {});
      throw error;
    }
  }

  authority = Object.freeze({
    prepareStep,
    async executePreparedStep(prepared, executor) {
      const metadata = preparedValues.get(prepared);
      if (!metadata || metadata.authority !== authority || metadata.phase !== 'prepared') fail('reused_receipt');
      metadata.phase = 'executing';
      const execution = Object.freeze({ step: prepared.step, request: metadata.request, requestSha256: prepared.requestSha256 });
      const executionMetadata = { authority, active: true, context: contextFor(metadata.request), fixture: unsafeFixture };
      executionValues.set(execution, executionMetadata);
      let raw;
      try {
        if (metadata.blocked && prepared.step !== 'cleanup') {
          raw = await failedStepReceipt(execution, executionMetadata.context, {
            reason: metadata.blocked, fixture: unsafeFixture, status: 'NOT_RUN' });
        } else {
          let selectedExecutor = executor;
          if (!unsafeFixture) {
            const fixedExecutor = (await import('../run-component.mjs')).executeStepRequest;
            if (executor !== undefined && executor !== fixedExecutor) fail('invalid_arguments');
            selectedExecutor = fixedExecutor;
          }
          if (typeof selectedExecutor !== 'function') fail('invalid_arguments');
          try { raw = await (unsafeFixture ? selectedExecutor(execution, executionMetadata.context) : selectedExecutor(execution)); }
          catch (error) { raw = await failedStepReceipt(execution, executionMetadata.context,
            { reason: error instanceof EvidenceError ? error.reason : 'step_execution_failed', fixture: unsafeFixture }); }
        }
      }
      finally { executionMetadata.active = false; }
      const receipt = parseStepReceipt(raw, metadata.request, await journalAuthority.verifiedBindingSnapshot());
      if (receipt.schema !== 'raibitserver.production-evidence-step-receipt/v2'
        || receipt.requestSha256 !== prepared.requestSha256) fail('request_digest_mismatch');
      parseStepResult({ status: receipt.status, reason: receipt.reason, assertions: receipt.assertions,
        artifacts: receipt.artifacts, cleanupInventory: receipt.cleanupInventory,
        ...(receipt.domainProof ? { domainProof: receipt.domainProof } : {}) }, prepared.step, metadata.request, await journalAuthority.verifiedBindingSnapshot());
      const candidate = immutable({ schema: 'raibitserver.production-evidence-candidate-receipt/v1', receipt });
      candidateValues.set(candidate, { authority, prepared }); metadata.phase = 'candidate'; return candidate;
    },
    async commitCandidate(prepared, candidate) { return commit(prepared, candidate); },
    async loadCommitted() { return (await load()).views; },
    async loadProgression(input) {
      if (!exact(input, ['journalAuthority'])) fail('invalid_arguments');
      assertJournalAuthority(input.journalAuthority);
      if ((await input.journalAuthority.bindingSnapshot()).runIdentitySha256 !== digest(identity)) fail('invalid_journal_authority');
      const state = await load();
      if (state.preparations.length !== state.entries.length) fail('invalid_receipt_journal');
      const observations = [];
      for (const record of state.receipts) observations.push(...await verifyCandidateArtifacts(runDirectory, record.receipt, unsafeFixture));
      const progression = immutable({ schema: 'raibitserver.production-evidence-receipt-progression/v1',
        runIdentitySha256: digest(identity), receipts: state.views, observations });
      progressions.add(progression); return progression;
    },
    async dispose() { await bootstrap?.dispose(); },
    async snapshot() {
      const state = await load();
      if (state.preparations.length !== state.entries.length) fail('invalid_receipt_journal');
      const snapshot = immutable({ schema: 'raibitserver.production-evidence-receipt-journal-snapshot/v1',
        runIdentitySha256: digest(identity), entryCount: state.entries.length, entriesSha256: digest(state.entries) });
      snapshots.add(snapshot); return snapshot;
    },
  });
  authorities.add(authority);
  sealContexts.set(authority, Object.freeze({ runDirectory, identity, fullOperatorInput, writer, journalAuthority, fixture: unsafeFixture }));
  committedSealReceipts.set(authority, []);
  return authority;
}

export const createReceiptAuthority = (options) => create(options, false);
export const createReceiptAuthorityFixtureUnsafe = (options) => create(options, true);

export function receiptExecutionContext(value) {
  assertReceiptExecution(value); return executionValues.get(value).context;
}
export function receiptExecutionIsFixture(value) {
  assertReceiptExecution(value); return executionValues.get(value).fixture;
}

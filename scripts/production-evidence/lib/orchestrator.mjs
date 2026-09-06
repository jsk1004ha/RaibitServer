#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManifest, STEP_COMPONENT } from './manifest.mjs';
import { digest, EvidenceError, loadOperatorContract, parseOperatorInputs } from './operator-inputs.mjs';
import { createRun, createRunnerContext } from './run.mjs';
import { createSafeArtifactWriter, createUnsafeFixtureArtifactWriter } from './safe-artifact-writer.mjs';
import { createJournalAuthority, createJournalAuthorityFixtureUnsafe } from './journal-authority.mjs';
import { createReceiptAuthority, createReceiptAuthorityFixtureUnsafe } from './receipt-authority.mjs';
import { parseStepResult } from './step-contract.mjs';
import resourceCapabilities from '../../../packages/schemas/src/resource-capabilities-v1.json' with { type: 'json' };
import { buildIdentity, executeFoundation, immutableJson, inspectSecretReference } from './orchestrator-io.mjs';
import { FINAL_STEP_NAMES, STEP_NAMES } from './step-contract.mjs';
import { STEP_BUDGET_MS } from './step-execution.mjs';
import { deriveProductionEvidenceStepState } from './state-projection.mjs';
import { executeStepRequest } from '../run-component.mjs';
import { preflight } from '../preflight.mjs';
import { verifyEvidenceFile } from '../../verify-production-evidence.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUN_BUDGET_MS = 4 * 60 * 60_000;
const FAULT_REASON = Object.freeze({ 'not-run': 'not_run', 'command-failure': 'command_failure',
  'identity-mismatch': 'identity_mismatch', 'artifact-tamper': 'artifact_digest_mismatch',
  'secret-output': 'redaction', 'cleanup-leak': 'cleanup_failed' });

function iso(clock) {
  const value = clock.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new EvidenceError('invalid_clock');
  return date.toISOString();
}

export function parseFaultCase(value) {
  const faultKeys = ['id', 'boundary', 'mode', 'expectedReason'];
  const boundaries = ['preflight', ...STEP_NAMES, 'verifier'];
  const verifierModes = ['identity-mismatch', 'artifact-tamper', 'secret-output'];
  if (!value || typeof value !== 'object' || Object.keys(value).length !== faultKeys.length
    || faultKeys.some((key) => !Object.hasOwn(value, key)) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)
    || !boundaries.includes(value.boundary) || !Object.hasOwn(FAULT_REASON, value.mode)
    || value.expectedReason !== FAULT_REASON[value.mode]
    || (value.boundary === 'preflight' && value.mode !== 'not-run')
    || (value.boundary === 'verifier' && !verifierModes.includes(value.mode))) throw new EvidenceError('invalid_fault_matrix');
  return Object.freeze(value);
}

function validateOptions(options) {
  const keys = ['profile', 'scenario', 'faultMatrix', 'attemptDir', 'inputs', 'executeStep', 'clock', 'uuid', 'fixture',
    ...(Object.hasOwn(options, 'domainInputs') ? ['domainInputs'] : []), ...(Object.hasOwn(options, 'testOnly') ? ['testOnly'] : [])];
  if (!options || Object.keys(options).length !== keys.length || keys.some((key) => !Object.hasOwn(options, key))
    || !['train-a', 'final'].includes(options.profile)
    || (options.profile === 'final') !== Object.hasOwn(options, 'domainInputs')
    || (options.profile === 'final' && (!options.domainInputs || typeof options.domainInputs !== 'object' || Array.isArray(options.domainInputs)))
    || !((options.scenario === 'happy' && options.faultMatrix === null) || (options.scenario === null && options.faultMatrix !== null))
    || !path.isAbsolute(options.attemptDir) || typeof options.clock?.now !== 'function' || typeof options.uuid !== 'function'
    || !(options.executeStep === null || typeof options.executeStep === 'function') || typeof options.fixture !== 'boolean') throw new EvidenceError('invalid_arguments');
  if (options.testOnly && (!options.fixture || options.executeStep !== null || Object.keys(options.testOnly).length !== 1
    || typeof options.testOnly.bootstrap !== 'function')) throw new EvidenceError('invalid_arguments');
  if (options.faultMatrix !== null) {
    parseFaultCase(options.faultMatrix);
  }
}

export function orderCleanupInventory(items, authenticatedClient = null) {
  const unique = [...new Map(items.map((item) => [digest(item), item])).entries()];
  const priority = (item) => {
    if (item.type === 'control-plane') return 0;
    if (item.type === 'kubernetes' && item.namespace === authenticatedClient?.namespace
      && (item.name === authenticatedClient.podName || item.name === `${authenticatedClient.podName}-egress`)) return 2;
    return 1;
  };
  return unique.sort(([leftDigest, left], [rightDigest, right]) => priority(left) - priority(right) || leftDigest.localeCompare(rightDigest)).map(([, item]) => item);
}

function faultForStep(fault, step) {
  return fault?.boundary === step ? { id: fault.id, mode: fault.mode, expectedReason: fault.expectedReason } : null;
}

export async function runProductionEvidence(options) {
  validateOptions(options);
  const inputs = parseOperatorInputs(options.inputs, await loadOperatorContract());
  const stepNames = options.profile === 'final' ? FINAL_STEP_NAMES : STEP_NAMES;
  const fixture = options.fixture || options.executeStep !== null;
  await mkdir(options.attemptDir, { recursive: true, mode: 0o700 });
  const runId = options.uuid(), startedAt = iso(options.clock);
  const hardDeadlineAt = new Date(Date.parse(startedAt) + RUN_BUDGET_MS).toISOString();
  const baseIdentity = await buildIdentity({ inputs, runId, root: ROOT, fixture });
  const identity = options.profile === 'final' ? Object.freeze({ ...baseIdentity,
    environmentFingerprint: digest({ environmentFingerprint: baseIdentity.environmentFingerprint, domainInputDigest: digest(options.domainInputs) }),
    domainInputDigest: digest(options.domainInputs),
  }) : baseIdentity;
  const runDirectory = await createRun(options.attemptDir, identity, startedAt);
  await mkdir(path.join(runDirectory, 'work'), { mode: 0o700 });
  const writer = await (fixture ? createUnsafeFixtureArtifactWriter : createSafeArtifactWriter)({ runDirectory,
    allowedPaths: (relative) => /^(?:(?:artifacts\/(?:local|cluster|lifecycle|resources|operations|domains)|cleanup|bindings|cleanup-intents|receipt-requests|receipts)\/[a-z0-9][a-z0-9_.-]*\.json(?:\.pending|\.commit)?|(?:evidence-seal|manifest|local|cluster|lifecycle|resources|operations|domains)\.json)$/.test(relative) });
  let authority;
  try {
    const journalAuthority = await (fixture ? createJournalAuthorityFixtureUnsafe : createJournalAuthority)({ runDirectory, identity, genuineSafeWriter: writer });
    const context = Object.freeze({ ...createRunnerContext(runDirectory, hardDeadlineAt, options.clock),
      writeArtifact: (component, name, value) => writer.writeJson(`artifacts/${component}/${name}`, value) });
    const fault = options.faultMatrix;
    let preflightResult = fixture ? { status: 'PASS' } : await preflight(inputs, {
      approvedInputPath: path.join(path.dirname(options.attemptDir), 'inputs', 'approved-draft-input-v1.md'),
      inspectSecretReference: (reference) => inspectSecretReference(reference, inputs, ROOT) });
    if (fault?.boundary === 'preflight') preflightResult = { status: 'NOT_RUN', reason: fault.expectedReason };
    let blockingReason = preflightResult.status === 'PASS' ? null : preflightResult.reason ?? 'missing_credentials';
    const foundations = {}, steps = [];
    for (const component of ['local', 'cluster']) {
      foundations[component] = blockingReason || fixture
        ? { status: 'NOT_RUN', reason: blockingReason ?? 'fixture_not_live',
          assertion: component === 'local' ? 'local_checks' : 'kind_helm_reconciliation',
          artifact: await context.writeArtifact(component, `${component}-unavailable.json`,
            { fixture, component, status: 'NOT_RUN', reason: blockingReason ?? 'fixture_not_live', redacted: true }) }
        : await executeFoundation(component, context, ROOT);
      if (!fixture && foundations[component].status !== 'PASS') blockingReason = foundations[component].reason;
    }
    const fixtureBootstrap = options.testOnly ? await options.testOnly.bootstrap({ identity, runDirectory, journalAuthority, writer }) : null;
    authority = await (fixture ? createReceiptAuthorityFixtureUnsafe : createReceiptAuthority)({
      runDirectory, identity, fullOperatorInput: inputs, genuineSafeWriter: writer, journalAuthority,
      ...(fixture ? fixtureBootstrap ? { stateProjector: deriveProductionEvidenceStepState, bootstrap: fixtureBootstrap }
        : { stateProjector: ({ step }) => ({ cleanupNamespace: `${inputs.selectors.RAIBITSERVER_RELEASE_NAMESPACE_PREFIX}-${runId.replaceAll('-', '').slice(0, 8)}`,
          cleanupInventory: [], ...(faultForStep(fault, step) ? { fault: faultForStep(fault, step) } : {}) }) } : {}) });
    const execute = async (step) => {
      const stepStartedAt = iso(options.clock);
      const deadlineAt = new Date(step === 'cleanup' ? Date.parse(stepStartedAt) + STEP_BUDGET_MS[step]
        : Math.min(Date.parse(stepStartedAt) + STEP_BUDGET_MS[step], Date.parse(hardDeadlineAt))).toISOString();
      const prepared = await authority.prepareStep(step, { startedAt: stepStartedAt, deadlineAt });
      const executor = fixtureBootstrap ? (execution) => executeStepRequest(execution) : fixture ? async (execution, stepContext) => {
        const request = execution.request;
        if (blockingReason && step !== 'cleanup') throw new EvidenceError(blockingReason);
        if (!options.executeStep) throw new EvidenceError('fixture_executor_unavailable');
        const result = parseStepResult(await options.executeStep(request, stepContext), step, request, await journalAuthority.verifiedBindingSnapshot());
        return { schema: 'raibitserver.production-evidence-step-receipt/v2', step, requestSha256: execution.requestSha256,
          identity, startedAt: request.startedAt, observedAt: stepContext.now(), ...result, redacted: true, fixture: true };
      } : undefined;
      const candidate = await authority.executePreparedStep(prepared, executor);
      const committed = await authority.commitCandidate(prepared, candidate);
      steps.push(committed);
      if (step !== 'cleanup' && committed.receipt.status !== 'PASS') blockingReason ??= committed.receipt.reason;
    };
    try { for (const step of stepNames.slice(0, -1)) await execute(step); }
    finally { await execute('cleanup'); }
    const cleanupStep = steps.at(-1);
    await rm(path.join(runDirectory, 'work'), { recursive: true });
    const runArtifact = await writer.writeJson('cleanup/run.json', { schema: 'raibitserver.production-evidence-run-cleanup/v1',
      identity, startedAt: cleanupStep.receipt.startedAt, observedAt: iso(options.clock), status: 'PASS', reason: null,
      assertions: [{ id: 'run_cleanup', status: 'PASS' }], redacted: true, fixture });
    const componentArtifacts = {};
    for (const component of ['local', 'cluster', 'lifecycle', 'resources', 'operations', ...(options.profile === 'final' ? ['domains'] : [])]) componentArtifacts[component] = await writer.writeJson(`cleanup/${component}.json`,
      { schema: 'raibitserver.production-evidence-component-cleanup/v1', component, identity,
        startedAt: cleanupStep.receipt.startedAt, observedAt: iso(options.clock), status: cleanupStep.receipt.status,
        reason: cleanupStep.receipt.reason, assertions: [{ id: 'component_cleanup', status: cleanupStep.receipt.status }], redacted: true, fixture });
    const observedAt = iso(options.clock);
    const bindingJournal = await journalAuthority.bindingSnapshot();
    const bindingEntries = await journalAuthority.loadBindings();
    const bindingsDigest = digest(bindingEntries.map(({ payload }) => payload).filter(({ kind }) => !kind.endsWith('-observation')));
    const manifest = assembleManifest({ profile: options.profile, identity, startedAt, observedAt, fixture,
      preflight: { status: preflightResult.status, approvedInputSha256: identity.approvedInputSha256,
        operatorContractDigest: identity.operatorContractDigest, operatorInputFingerprint: identity.operatorInputFingerprint },
      foundations, steps, ...(bindingJournal.entryCount > 0 ? { bindingJournal, bindingsDigest } : {}),
      capabilitySnapshot: { schema: 'raibitserver.resource-capability-snapshot/v1', canonicalDigest: digest(resourceCapabilities), requiredEngines: resourceCapabilities.engines.filter(({ runtime }) => runtime === 'dedicated-local').map(({ engine }) => engine) },
      cleanup: { status: cleanupStep.receipt.status, stepDescriptor: cleanupStep.descriptor, runArtifact, componentArtifacts } });
    if (fault?.boundary === 'verifier') switch (fault.mode) {
      case 'identity-mismatch': manifest.fragments[0].identity = { ...manifest.fragments[0].identity, sourceCommitSha: '0'.repeat(40) }; break;
      case 'artifact-tamper': manifest.fragments[0].artifacts[0] = { ...manifest.fragments[0].artifacts[0], sha256: '0'.repeat(64) }; break;
      case 'secret-output': manifest.redactionCanary = 'password=redaction-canary'; break;
      default: throw new EvidenceError('invalid_fault_matrix');
    }
    for (const fragment of manifest.fragments) await writer.writeJson(`${fragment.component}.json`, fragment);
    await writer.writeJson('manifest.json', manifest);
    const manifestPath = path.join(runDirectory, 'manifest.json');
    let verification;
    try { verification = await verifyEvidenceFile(manifestPath, { now: Date.parse(observedAt), profile: options.profile, journalAuthority,
      receiptAuthority: authority, ...(bindingJournal.entryCount > 0 ? { verifiedBindingJournal: await journalAuthority.verifyBindingJournal() } : {}) }); }
    catch (error) { verification = { valid: false, releaseEligible: false, reason: error instanceof EvidenceError ? error.reason : 'evidence_io_failed' }; }
    return { status: manifest.status, reason: verification.valid ? null : fault?.boundary === 'verifier' ? verification.reason
      : blockingReason ?? cleanupStep.receipt.reason ?? verification.reason, runId, runDirectory, manifestPath, verification };
  } finally {
    try { await authority?.dispose(); } finally { await writer.close(); }
  }
}

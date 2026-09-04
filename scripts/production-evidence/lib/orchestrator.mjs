#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManifest, STEP_COMPONENT } from './manifest.mjs';
import { digest, EvidenceError, loadOperatorContract, parseOperatorInputs } from './operator-inputs.mjs';
import { createRun, createRunnerContext, writeFragment } from './run.mjs';
import { buildIdentity, executeFoundation, immutableJson, inspectSecretReference } from './orchestrator-io.mjs';
import { STEP_NAMES } from './step-contract.mjs';
import { executeProductionStep, skippedStep, STEP_BUDGET_MS } from './step-execution.mjs';
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
  const keys = ['profile', 'scenario', 'faultMatrix', 'attemptDir', 'inputs', 'executeStep', 'clock', 'uuid', 'fixture'];
  if (!options || Object.keys(options).length !== keys.length || keys.some((key) => !Object.hasOwn(options, key))
    || options.profile !== 'train-a'
    || !((options.scenario === 'happy' && options.faultMatrix === null) || (options.scenario === null && options.faultMatrix !== null))
    || !path.isAbsolute(options.attemptDir) || typeof options.clock?.now !== 'function' || typeof options.uuid !== 'function'
    || !(options.executeStep === null || typeof options.executeStep === 'function') || typeof options.fixture !== 'boolean') throw new EvidenceError('invalid_arguments');
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
  const contract = await loadOperatorContract();
  const inputs = parseOperatorInputs(options.inputs, contract);
  const fixture = options.fixture || options.executeStep !== null;
  await mkdir(options.attemptDir, { recursive: true, mode: 0o700 });
  const runId = options.uuid();
  const startedAt = iso(options.clock);
  const hardDeadlineAt = new Date(Date.parse(startedAt) + RUN_BUDGET_MS).toISOString();
  const identity = await buildIdentity({ inputs, runId, root: ROOT, fixture });
  const runDirectory = await createRun(options.attemptDir, identity, startedAt);
  await mkdir(path.join(runDirectory, 'work'), { mode: 0o700 });
  await mkdir(path.join(runDirectory, 'cleanup'), { mode: 0o700 });
  const context = createRunnerContext(runDirectory, hardDeadlineAt, options.clock);
  const fault = options.faultMatrix;
  let preflightResult = fixture
    ? { status: 'PASS', approvedInputSha256: identity.approvedInputSha256, operatorContractDigest: identity.operatorContractDigest, operatorInputFingerprint: identity.operatorInputFingerprint }
    : await preflight(inputs, { approvedInputPath: path.join(path.dirname(options.attemptDir), 'inputs', 'approved-draft-input-v1.md'),
      inspectSecretReference: (reference) => inspectSecretReference(reference, inputs, ROOT) });
  if (fault?.boundary === 'preflight') preflightResult = { status: 'NOT_RUN', approvedInputSha256: identity.approvedInputSha256,
    operatorContractDigest: identity.operatorContractDigest, operatorInputFingerprint: identity.operatorInputFingerprint, reason: fault.expectedReason };
  const foundations = {};
  const steps = [];
  let cleanupInventory = [];
  let blockingReason = preflightResult.status === 'PASS' ? null : (preflightResult.reason ?? 'missing_credentials');
  try {
    for (const component of ['local', 'cluster']) {
      foundations[component] = blockingReason || fixture
        ? await context.writeArtifact(component, `${component}-unavailable.json`, { fixture, component, status: 'NOT_RUN', reason: blockingReason ?? 'fixture_not_live', redacted: true })
          .then((artifact) => ({ status: 'NOT_RUN', reason: blockingReason ?? 'fixture_not_live', assertion: component === 'local' ? 'local_checks' : 'kind_helm_reconciliation', artifact }))
        : await executeFoundation(component, context, ROOT);
      if (!fixture && foundations[component].status !== 'PASS') blockingReason = foundations[component].reason;
    }
    for (const step of STEP_NAMES.filter((name) => name !== 'cleanup')) {
      const stepStartedAt = iso(options.clock);
      const requestedDeadline = Date.parse(stepStartedAt) + STEP_BUDGET_MS[step];
      const request = { schema: 'raibitserver.production-evidence-step-request/v1', step, identity, startedAt: stepStartedAt,
        deadlineAt: new Date(Math.min(requestedDeadline, Date.parse(hardDeadlineAt))).toISOString(), runDirectory,
        selectors: inputs.selectors, secretRefs: inputs.secretRefs,
        state: { cleanupNamespace: `${inputs.selectors.RAIBITSERVER_RELEASE_NAMESPACE_PREFIX}-${runId.replaceAll('-', '').slice(0, 8)}`,
          cleanupInventory: [...cleanupInventory], ...(faultForStep(fault, step) ? { fault: faultForStep(fault, step) } : {}) } };
      const executed = blockingReason
        ? { receipt: await skippedStep(request, context, fixture), descriptor: null }
        : await executeProductionStep({ step, request, context, injected: options.executeStep, fixture, runDirectory, root: ROOT });
      if (!executed.descriptor) executed.descriptor = await immutableJson(runDirectory, `artifacts/${STEP_COMPONENT[step]}/${step}.json`, executed.receipt);
      steps.push(executed);
      cleanupInventory = orderCleanupInventory([...cleanupInventory, ...executed.receipt.cleanupInventory], request.state.authenticatedClient);
      if (executed.receipt.status !== 'PASS') blockingReason = executed.receipt.reason ?? 'step_failed';
    }
  } finally {
    const cleanupStartedAt = iso(options.clock);
    const hardDeadline = Date.parse(hardDeadlineAt);
    const cleanupDeadlineAt = new Date(hardDeadline > Date.parse(cleanupStartedAt)
      ? Math.min(Date.parse(cleanupStartedAt) + 30_000, hardDeadline) : Date.parse(cleanupStartedAt) + 30_000).toISOString();
    const cleanupRequest = { schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity, startedAt: cleanupStartedAt,
      deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs.selectors, secretRefs: inputs.secretRefs,
      state: { cleanupNamespace: `${inputs.selectors.RAIBITSERVER_RELEASE_NAMESPACE_PREFIX}-${runId.replaceAll('-', '').slice(0, 8)}`,
        cleanupInventory: [...cleanupInventory], ...(faultForStep(fault, 'cleanup') ? { fault: faultForStep(fault, 'cleanup') } : {}) } };
    steps.push(await executeProductionStep({ step: 'cleanup', request: cleanupRequest, context: createRunnerContext(runDirectory, cleanupDeadlineAt, options.clock), injected: options.executeStep, fixture, runDirectory, root: ROOT }));
  }
  const cleanupStep = steps.find(({ receipt }) => receipt.step === 'cleanup');
  let runCleanupStatus = 'PASS';
  let runCleanupReason = null;
  try { await rm(path.join(runDirectory, 'work'), { recursive: true, force: true }); }
  catch (error) { runCleanupStatus = 'FAIL'; runCleanupReason = error instanceof Error ? 'work_cleanup_failed' : 'cleanup_failed'; }
  const runCleanupObservedAt = iso(options.clock);
  const runArtifact = await immutableJson(runDirectory, 'cleanup/run.json', { schema: 'raibitserver.production-evidence-run-cleanup/v1', identity,
    startedAt: cleanupStep.receipt.startedAt, observedAt: runCleanupObservedAt, status: runCleanupStatus, reason: runCleanupReason,
    assertions: [{ id: 'run_cleanup', status: runCleanupStatus }], redacted: true, fixture });
  const componentArtifacts = {};
  for (const component of ['local', 'cluster', 'lifecycle', 'resources', 'operations']) {
    componentArtifacts[component] = await immutableJson(runDirectory, `cleanup/${component}.json`, { schema: 'raibitserver.production-evidence-component-cleanup/v1',
      component, identity, startedAt: cleanupStep.receipt.startedAt, observedAt: iso(options.clock), status: cleanupStep.receipt.status,
      reason: cleanupStep.receipt.reason, assertions: [{ id: 'component_cleanup', status: cleanupStep.receipt.status }], redacted: true, fixture });
  }
  const observedAt = iso(options.clock);
  const manifest = assembleManifest({ identity, startedAt, observedAt, fixture, preflight: { status: preflightResult.status,
    approvedInputSha256: identity.approvedInputSha256, operatorContractDigest: identity.operatorContractDigest,
    operatorInputFingerprint: identity.operatorInputFingerprint }, foundations, steps, cleanup: { status: cleanupStep.receipt.status === 'PASS' ? runCleanupStatus : cleanupStep.receipt.status,
    stepDescriptor: cleanupStep.descriptor, runArtifact, componentArtifacts } });
  if (fault?.boundary === 'verifier') {
    switch (fault.mode) {
      case 'identity-mismatch': manifest.fragments[0].identity = { ...manifest.fragments[0].identity, projectId: 'mismatched-project' }; break;
      case 'artifact-tamper': manifest.fragments[0].artifacts[0] = { ...manifest.fragments[0].artifacts[0], sha256: '0'.repeat(64) }; break;
      case 'secret-output': manifest.redactionCanary = 'password=redaction-canary'; break;
      default: manifest.unexpectedVerifierFault = fault.mode;
    }
  }
  for (const fragment of manifest.fragments) await writeFragment(runDirectory, fragment);
  const manifestPath = path.join(runDirectory, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  let verification;
  try { verification = await verifyEvidenceFile(manifestPath, { now: Date.parse(observedAt), profile: 'train-a' }); }
  catch (error) {
    const reason = error instanceof EvidenceError ? error.reason : 'evidence_io_failed';
    verification = { valid: false, releaseEligible: false, reason };
  }
  const cleanupReason = cleanupStep.receipt.status === 'PASS' && runCleanupStatus === 'PASS'
    ? null : (cleanupStep.receipt.reason ?? runCleanupReason ?? 'cleanup_failed');
  return { status: manifest.status, reason: verification.valid ? null
    : (fault?.boundary === 'verifier' ? verification.reason : blockingReason ?? cleanupReason ?? verification.reason),
  runId, runDirectory, manifestPath, verification };
}

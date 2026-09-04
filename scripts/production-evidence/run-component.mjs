#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, EvidenceError, digest, readJson } from './lib/operator-inputs.mjs';
import { REQUIRED_ASSERTIONS } from './lib/manifest.mjs';
import { createRun, createRunnerContext, writeFragment } from './lib/run.mjs';
import { preflight } from './preflight.mjs';
import { parseStepRequest, parseStepResult } from './lib/step-contract.mjs';

const STEP_MODULES = Object.freeze({
  'auth-source': './steps/auth-source.mjs',
  'supply-chain': './steps/supply-chain.mjs',
  runtime: './steps/runtime.mjs',
  observability: './steps/observability.mjs',
  resources: './steps/resources.mjs',
  'backup-sql': './steps/backup-sql.mjs',
  'backup-nosql': './steps/backup-nosql.mjs',
  preview: './steps/preview.mjs',
  rollback: './steps/rollback.mjs',
  cleanup: './steps/cleanup.mjs',
});

export async function executeStepRequest(value, options = {}) {
  const request = parseStepRequest(value, options.expectedStep);
  const modulePath = STEP_MODULES[request.step];
  if (!modulePath) throw new EvidenceError('invalid_step_contract');
  const implementation = await import(new URL(modulePath, import.meta.url));
  if (typeof implementation.execute !== 'function') throw new EvidenceError('invalid_step_contract');
  const context = options.context ?? createRunnerContext(request.runDirectory, request.deadlineAt);
  const result = parseStepResult(await implementation.execute(request, context), request.step, request);
  const receipt = { schema: 'raibitserver.production-evidence-step-receipt/v1', step: request.step, identity: request.identity,
    startedAt: request.startedAt, observedAt: context.now(), ...result, redacted: true, fixture: options.fixture === true };
  return receipt;
}

export function parseFixedStepArguments(args) {
  if (args.length !== 4 || args[0] !== '--request' || args[2] !== '--output'
    || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new EvidenceError('invalid_arguments');
  return Object.freeze({ requestPath: args[1], outputPath: args[3] });
}

export function stepReceiptExitCode(receipt) {
  if (!receipt || !['PASS', 'FAIL', 'NOT_RUN'].includes(receipt.status)) throw new EvidenceError('invalid_step_contract');
  return receipt.status === 'PASS' ? 0 : 1;
}

// Individual wrappers import this function with their compile-time step name. The
// operator-facing argv never contains a selectable step.
export async function runFixedStepCli(expectedStep, args) {
  if (!Object.hasOwn(STEP_MODULES, expectedStep)) throw new EvidenceError('invalid_step_contract');
  const { requestPath, outputPath } = parseFixedStepArguments(args);
  const request = await readJson(requestPath, 'missing_step_request');
  const receipt = await executeStepRequest(request, { expectedStep });
  await writeFile(outputPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(outputPath, 0o600);
  return Object.freeze({ receipt, exitCode: stepReceiptExitCode(receipt) });
}

export async function runFixedStepMain(expectedStep, args, io = { stderr: process.stderr }) {
  try { return await runFixedStepCli(expectedStep, args); }
  catch (error) {
    io.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
    return Object.freeze({ receipt: null, exitCode: 2 });
  }
}

export function componentSample(component, now = new Date().toISOString()) {
  if (!['resources', 'domains'].includes(component)) throw new EvidenceError('invalid_component');
  const identity = { runId: randomUUID(), environmentFingerprint: digest('synthetic-environment'), sourceCommitSha: '0'.repeat(40), migrationDigest: digest('synthetic-migration'), approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: digest('synthetic-input'), organizationId: 'fixture-org', projectId: 'fixture-project', serviceId: 'fixture-service', deploymentId: 'fixture-deployment', resourceId: 'fixture-resource' };
  const artifact = `${JSON.stringify({ fixture: true, component, observedAt: now, assertions: REQUIRED_ASSERTIONS[component], cleanup: 'PASS' })}\n`;
  const assertion = (id) => ({ id, status: 'PASS', artifactPaths: ['assertions.json'] });
  const fragment = { component, level: 'L3', provenance: 'fixture', identity, startedAt: now, observedAt: now, status: 'PASS', assertions: REQUIRED_ASSERTIONS[component].map(assertion), artifacts: [{ path: 'assertions.json', sha256: digest(artifact), redacted: true }], cleanup: { status: 'PASS', assertions: [assertion('component_cleanup')] } };
  const manifest = { schema: 'raibitserver.production-evidence/v1', profile: 'component', identity, startedAt: now, observedAt: now, status: 'PASS', preflight: { status: 'NOT_RUN', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: identity.operatorInputFingerprint }, fragments: [fragment], cleanup: { status: 'PASS', assertions: [assertion('run_cleanup')] }, fixture: true };
  return { manifest, artifact };
}

export async function runComponent(request) {
  const { parent, identity, component, inputs } = request;
  if (!['resources', 'domains'].includes(component)) throw new EvidenceError('invalid_component');
  const startedAt = new Date().toISOString();
  const directory = await createRun(parent, identity, startedAt);
  const result = await preflight(inputs);
  const observedAt = new Date().toISOString();
  const reason = result.status === 'PASS' ? 'runner_not_implemented' : result.reason;
  const artifact = `${JSON.stringify({ status: 'NOT_RUN', reason, cleanup: 'PASS', externalOperations: 0 })}\n`;
  await writeFile(path.join(directory, 'assertions.json'), artifact, { flag: 'wx', mode: 0o600 });
  const assertion = (id, status) => ({ id, status, artifactPaths: ['assertions.json'] });
  const fragment = { component, level: 'L3', provenance: 'credentialed', identity, startedAt, observedAt, status: 'NOT_RUN', assertions: REQUIRED_ASSERTIONS[component].map((id) => assertion(id, 'NOT_RUN')), artifacts: [{ path: 'assertions.json', sha256: digest(artifact), redacted: true }], cleanup: { status: 'PASS', assertions: [assertion('component_cleanup', 'PASS')] } };
  await writeFragment(directory, fragment);
  return { status: 'NOT_RUN', reason, releaseEligible: false, runId: identity.runId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('invalid_arguments\n');
  process.exitCode = 2;
}

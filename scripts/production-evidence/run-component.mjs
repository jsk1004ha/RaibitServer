#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, EvidenceError, digest } from './lib/operator-inputs.mjs';
import { REQUIRED_ASSERTIONS } from './lib/manifest.mjs';
import { parseStepResult } from './lib/step-contract.mjs';
import { assertReceiptExecution, receiptExecutionContext, receiptExecutionIsFixture } from './lib/receipt-authority.mjs';

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
  domains: './steps/domains.mjs',
  cleanup: './steps/cleanup.mjs',
});

export async function executeStepRequest(value, options = {}) {
  if (Object.keys(options).some((key) => key !== 'expectedStep')) throw new EvidenceError('invalid_arguments');
  const execution = assertReceiptExecution(value, options.expectedStep);
  const request = execution.request;
  const modulePath = STEP_MODULES[request.step];
  if (!modulePath) throw new EvidenceError('invalid_step_contract');
  const implementation = await import(new URL(modulePath, import.meta.url));
  if (typeof implementation.execute !== 'function') throw new EvidenceError('invalid_step_contract');
  const context = receiptExecutionContext(execution);
  const result = parseStepResult(await implementation.execute(request, context), request.step, request, await context.journalAuthority.verifiedBindingSnapshot());
  const receipt = { schema: 'raibitserver.production-evidence-step-receipt/v2', step: request.step, requestSha256: execution.requestSha256, identity: request.identity,
    startedAt: request.startedAt, observedAt: context.now(), ...result, redacted: true, fixture: receiptExecutionIsFixture(execution) };
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
  void args;
  throw new EvidenceError('direct_component_execution_forbidden');
}

export async function runFixedStepMain(expectedStep, args, io = { stderr: process.stderr }) {
  try { return await runFixedStepCli(expectedStep, args); }
  catch (error) {
    const reason = error instanceof EvidenceError ? error.reason : 'evidence_io_failed';
    io.stderr.write(`${reason}\n`);
    if (reason === 'direct_component_execution_forbidden') return Object.freeze({ receipt: null, status: 'NOT_RUN', reason, exitCode: 1 });
    return Object.freeze({ receipt: null, exitCode: 2 });
  }
}

export function componentSample(component, now = new Date().toISOString()) {
  if (!['resources', 'domains'].includes(component)) throw new EvidenceError('invalid_component');
  const identity = { runId: randomUUID(), environmentFingerprint: digest('synthetic-environment'), sourceCommitSha: '0'.repeat(40), migrationDigest: digest('synthetic-migration'), approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: digest('synthetic-input') };
  const artifact = `${JSON.stringify({ fixture: true, component, observedAt: now, assertions: REQUIRED_ASSERTIONS[component], cleanup: 'PASS' })}\n`;
  const assertion = (id) => ({ id, status: 'PASS', artifactPaths: ['assertions.json'] });
  const fragment = { component, level: 'L3', provenance: 'fixture', identity, startedAt: now, observedAt: now, status: 'PASS', assertions: REQUIRED_ASSERTIONS[component].map(assertion), artifacts: [{ path: 'assertions.json', sha256: digest(artifact), redacted: true }], cleanup: { status: 'PASS', assertions: [assertion('component_cleanup')] } };
  const manifest = { schema: 'raibitserver.production-evidence/v1', profile: 'component', identity, startedAt: now, observedAt: now, status: 'PASS', preflight: { status: 'NOT_RUN', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: identity.operatorInputFingerprint }, fragments: [fragment], cleanup: { status: 'PASS', assertions: [assertion('run_cleanup')] }, fixture: true };
  return { manifest, artifact };
}

export async function runComponent() {
  throw new EvidenceError('direct_component_execution_forbidden');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('direct_component_execution_forbidden\n');
  process.exitCode = 1;
}

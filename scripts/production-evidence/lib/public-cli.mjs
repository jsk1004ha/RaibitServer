#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvidenceError, loadProductionInputs, readJson } from './operator-inputs.mjs';
import { runProductionEvidence } from './orchestrator.mjs';

export function parseArguments(args) {
  const accepted = new Set(['--profile', '--scenario', '--fault-matrix', '--attempt-dir']);
  const values = new Map();
  if (args.length % 2 !== 0) throw new EvidenceError('invalid_arguments');
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!accepted.has(flag) || values.has(flag) || typeof value !== 'string' || !value || value.startsWith('--')) throw new EvidenceError('invalid_arguments');
    values.set(flag, value);
  }
  const attemptDir = values.get('--attempt-dir');
  const scenario = values.get('--scenario');
  const faultPath = values.get('--fault-matrix');
  if (values.get('--profile') !== 'train-a' || typeof attemptDir !== 'string' || !path.isAbsolute(attemptDir)
    || (scenario === 'happy') === (typeof faultPath === 'string') || (scenario !== undefined && scenario !== 'happy')
    || (faultPath !== undefined && !path.isAbsolute(faultPath))) throw new EvidenceError('invalid_arguments');
  return { attemptDir, scenario, faultPath };
}

export function parseMatrix(value) {
  const caseKeys = ['id', 'boundary', 'mode', 'expectedReason'];
  const boundaries = ['preflight', 'auth-source', 'supply-chain', 'runtime', 'observability', 'resources', 'backup-sql', 'backup-nosql', 'preview', 'rollback', 'cleanup', 'verifier'];
  const modes = ['not-run', 'command-failure', 'identity-mismatch', 'artifact-tamper', 'secret-output', 'cleanup-leak'];
  if (!value || Object.keys(value).length !== 2 || value.schema !== 'raibitserver.production-evidence-fault-matrix/v1'
    || !Array.isArray(value.cases) || value.cases.length === 0
    || value.cases.some((item) => !item || Object.keys(item).length !== caseKeys.length || caseKeys.some((key) => !Object.hasOwn(item, key))
      || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || !boundaries.includes(item.boundary)
      || !modes.includes(item.mode) || typeof item.expectedReason !== 'string' || !item.expectedReason)
    || new Set(value.cases.map(({ id }) => id)).size !== value.cases.length) throw new EvidenceError('invalid_fault_matrix');
  return value;
}

export async function main(args, environment = process.env) {
  if (environment.RAIBITSERVER_PRODUCTION_EVIDENCE !== '1') throw new EvidenceError('production_evidence_not_enabled');
  const { attemptDir, scenario, faultPath } = parseArguments(args);
  const inputs = await loadProductionInputs(attemptDir, environment);
  const common = { profile: 'train-a', attemptDir, inputs, executeStep: null, clock: { now: () => new Date() }, uuid: randomUUID, fixture: false };
  if (scenario === 'happy') {
    const result = await runProductionEvidence({ ...common, scenario: 'happy', faultMatrix: null });
    return { output: result, exitCode: result.verification.releaseEligible ? 0 : 1 };
  }
  const matrix = parseMatrix(await readJson(faultPath, 'invalid_fault_matrix'));
  const runs = [];
  for (const faultMatrix of matrix.cases) runs.push(await runProductionEvidence({ ...common, scenario: null, faultMatrix }));
  const allExpectedFailures = runs.every((result, index) => result.verification.releaseEligible === false && result.reason === matrix.cases[index].expectedReason);
  return { output: { runs: runs.map(({ runId, manifestPath, status, reason }) => ({ runId, manifestPath, status, reason })), allExpectedFailures }, exitCode: allExpectedFailures ? 1 : 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
  process.exitCode = 2;
}

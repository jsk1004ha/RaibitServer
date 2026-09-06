import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createOutcomeRecorder, validatePlatformExpansionMatrix } from './platform-expansion-report.js';

const root = path.resolve(import.meta.dirname, '../../../..');
const source = path.join(root, 'apps/dashboard/tests/e2e/feature-expansion-matrix.ts');
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');

async function loadMatrix() {
  const output = await mkdtemp(path.join(tmpdir(), 'raibit-task49-'));
  try {
    execFileSync(process.execPath, [compiler, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--outDir', output, source], { cwd: root, stdio: 'pipe' });
    return await import(`${pathToFileURL(path.join(output, 'feature-expansion-matrix.js')).href}?run=${Date.now()}`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

test('Given the Task49 authored matrix, when its coverage contract is inspected, then every required dimension and source reference is present', async () => {
  const matrix = await loadMatrix();
  const report = validatePlatformExpansionMatrix(matrix.PLATFORM_EXPANSION_MATRIX);
  assert.equal(report.expectedScenarioCount, matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS.length);
  assert.equal(report.negativeScenarioCount, matrix.PLATFORM_EXPANSION_NEGATIVE_ROWS.length);
  assert.equal(report.contractPendingScenarioCount, 1);
  assert.equal(report.delegatedScenarioCount, 8);
  assert.ok(report.expectedScenarioCount > report.negativeScenarioCount);
});

test('Given planned outcomes, when a recorder sees missing, duplicate, or incomplete evidence, then it rejects the report', async () => {
  const matrix = await loadMatrix();
  const row = matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS.find((candidate) => !candidate.representativeVisual);
  assert.ok(row);
  const recorder = createOutcomeRecorder([row], 'positive');
  assert.throws(() => recorder.finish(), /missing_outcomes/);
  assert.throws(() => recorder.record(row.id, { status: 'passed', api: null, a11y: 'axe:zero-violations', representativeVisual: false }), /incomplete_outcome/);
  recorder.record(row.id, { status: 'passed', api: { status: 200, method: 'GET', path: row.route }, a11y: 'axe:zero-violations', representativeVisual: false });
  assert.throws(() => recorder.record(row.id, { status: 'passed', api: { status: 200, method: 'GET', path: row.route }, a11y: 'axe:zero-violations', representativeVisual: false }), /duplicate_outcome/);
  assert.deepEqual(recorder.finish().summary, { expected: 1, passed: 1, failed: 0, skipped: 0, unexpected: 0, flaky: 0 });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  assert.equal(report.delegatedTask41ScenarioCount, 1);
  assert.equal(report.delegatedScenarioCount, 8);
  assert.deepEqual(matrix.PLATFORM_EXPANSION_DELEGATED_PLAYWRIGHT_SCENARIOS.map((scenario) => scenario.kind), ['positive', 'positive', 'negative', 'negative']);
  assert.equal(new Set(matrix.PLATFORM_EXPANSION_DELEGATED_PLAYWRIGHT_SCENARIOS.map((scenario) => scenario.title)).size, 4);
  assert.ok(report.expectedScenarioCount > report.negativeScenarioCount);
});

test('Given planned outcomes, when a recorder sees missing, duplicate, or incomplete evidence, then it rejects the report', async () => {
  const matrix = await loadMatrix();
  const row = matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS.find((candidate) => !candidate.representativeVisual);
  assert.ok(row);
  const recorder = createOutcomeRecorder([row], 'positive');
  assert.throws(() => recorder.finish(), /missing_outcomes/);
  assert.throws(() => recorder.record(row.id, { status: 'passed', observation: null, a11y: { violations: 0 }, representativeVisual: false }), /observation_required/);
  const outcome = { status: 'passed', observation: { kind: 'http', request: { method: 'GET', url: 'http://console.localhost:3410/example' }, response: { status: 200, url: 'http://console.localhost:3410/example', body: { ok: true } }, resultingState: { source: 'ui', value: { visible: true } } }, a11y: { violations: 0 }, representativeVisual: false };
  recorder.record(row.id, outcome);
  assert.throws(() => recorder.record(row.id, outcome), /duplicate_outcome/);
  assert.deepEqual(recorder.finish().summary, { expected: 1, passed: 1, failed: 0, skipped: 0, unexpected: 0, flaky: 0 });
});

test('Given synthetic status metadata, when an outcome is recorded, then it cannot masquerade as an observed browser result', async () => {
  const matrix = await loadMatrix();
  const row = matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS.find((candidate) => !candidate.representativeVisual);
  assert.ok(row);
  const recorder = createOutcomeRecorder([row], 'positive');
  assert.throws(() => recorder.record(row.id, {
    status: 'passed',
    api: { status: 200, method: 'GET', path: row.route },
    a11y: 'axe:zero-violations',
    representativeVisual: false,
  }), /observation_required/);
});

test('Given a client-side validation outcome, when no request was emitted, then the report records no HTTP status and proves unchanged side effects', async () => {
  const matrix = await loadMatrix();
  const row = matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS.find((candidate) => candidate.id === 'service-preview-terminal-validation');
  assert.ok(row);
  const recorder = createOutcomeRecorder([row], 'negative');
  recorder.record(row.id, {
    status: 'passed',
    observation: {
      kind: 'client',
      action: 'invalid-form-submit-blocked',
      networkRequests: 0,
      resultingState: { source: 'ui', value: { submitDisabled: true } },
      sideEffects: { unchanged: true, before: [], after: [] },
    },
    a11y: { violations: 0 },
    representativeVisual: false,
  });
  const outcome = recorder.finish().outcomes[0];
  assert.equal(outcome.observation.kind, 'client');
  assert.equal('status' in outcome.observation, false);
});

test('Given a negative HTTP outcome, when side effects are not proven unchanged, then the recorder fails closed', async () => {
  const matrix = await loadMatrix();
  const row = matrix.PLATFORM_EXPANSION_NEGATIVE_ROWS.find((candidate) => candidate.driver === 'github-conflict');
  assert.ok(row);
  const recorder = createOutcomeRecorder([row], 'negative');
  assert.throws(() => recorder.record(row.id, {
    status: 'passed',
    observation: {
      kind: 'http',
      request: { method: 'POST', url: 'http://console.localhost:3410/api/control/disconnect' },
      response: { status: 409, url: 'http://console.localhost:3410/api/control/disconnect', body: { error: 'stale_version' } },
      resultingState: { source: 'ui', value: { alert: true } },
    },
    a11y: { violations: 0 },
    representativeVisual: false,
  }), /incomplete_outcome/);
});

test('Given the Task49 browser driver source, when transport evidence is inspected, then fake client and aborted HTTP status literals stay absent', async () => {
  const driver = await readFile(path.join(root, 'apps/dashboard/tests/e2e/specs/platform-expansion.spec.ts'), 'utf8');
  assert.doesNotMatch(driver, /status:\s*422/);
  assert.doesNotMatch(driver, /method:\s*['"]CLIENT['"]/);
  assert.doesNotMatch(driver, /stream-degraded[^]*status:\s*503/);
  assert.match(driver, /response\.status\(\)/);
  assert.match(driver, /responseBody\(response\)/);
  assert.match(driver, /sideEffects:\s*unchanged\(/);
});

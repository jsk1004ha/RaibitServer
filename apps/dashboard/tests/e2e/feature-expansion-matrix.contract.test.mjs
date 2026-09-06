import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { validatePlatformExpansionMatrix } from './platform-expansion-report.js';

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
  assert.deepEqual(report, {
    expectedScenarioCount: matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS.length,
    contractPendingScenarioCount: matrix.PLATFORM_EXPANSION_CONTRACT_PENDING_ROWS.length,
    delegatedScenarioCount: 2,
    browserExecution: 'NOT_RUN',
  });
  assert.equal(report.expectedScenarioCount, 8);
  assert.equal(report.contractPendingScenarioCount, 1);
});

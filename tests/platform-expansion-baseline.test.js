import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { relativeExternalDistDir } from '../apps/dashboard/next.config.mjs';
import { BASELINE_COMMANDS, BaselineError, loadTask49Coverage, prepareAttemptDirectory, runBaseline } from '../scripts/platform-expansion-baseline.mjs';

const sourceRoot = process.cwd();

async function fixtureRoot() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'raibit-baseline-'));
  const externalRoot = path.join(parent, 'external');
  await mkdir(externalRoot);
  return { parent, externalRoot };
}

function fixtureOutput(command) {
  if (command.command === 'kind') return 'other-cluster\n';
  if (command.assertion === 'go') return 'ok\texample.test/module\t0.001s\n';
  if (command.assertion === 'playwright') return '3 passed\n';
  if (command.assertion === 'node') return '# tests 3\n# pass 3\n# skipped 0\n';
  return `${command.id} completed\n`;
}

function reportFor(kind, ids) {
  return {
    schema: 'raibit.task49.v1', kind, expectedScenarioIds: ids,
    outcomes: ids.map((id) => ({ id, status: 'passed', api: { status: 200, method: 'GET', path: '/fixture' }, a11y: { violations: 0 } })),
    summary: { expected: ids.length, passed: ids.length, failed: 0, skipped: 0, unexpected: 0, flaky: 0 },
  };
}

function playwrightReport(coverage) {
  const specs = [
    ...coverage.positiveIds.map((id) => ({ title: `@platform-expansion ${id}`, tests: [{ results: [{ status: 'passed' }] }] })),
    ...coverage.negativeIds.map((id) => ({ title: `@platform-expansion ${id}`, tests: [{ results: [{ status: 'passed' }] }] })),
  ];
  const expected = specs.length;
  return { suites: [{ specs }], stats: { expected, skipped: 0, unexpected: 0, flaky: 0 } };
}

async function writeTask49Evidence(environment, coverage, positive = coverage.positiveIds, negative = coverage.negativeIds) {
  await Promise.all([
    writeFile(environment.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH, JSON.stringify(reportFor('positive', positive))),
    writeFile(path.join(path.dirname(environment.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH), 'task-49-platform-expansion-negative-evidence.json'), JSON.stringify(reportFor('negative', negative))),
    writeFile(environment.RAIBITSERVER_PLAYWRIGHT_REPORT_PATH, JSON.stringify(playwrightReport(coverage))),
  ]);
}

async function writeFixturePlatformReport(environment) {
  await writeTask49Evidence(environment, await loadTask49Coverage(sourceRoot));
}

function fixtureExecutor(overrides = {}) {
  return async (command, environment) => {
    if (overrides[command.id] instanceof Error) throw overrides[command.id];
    if (overrides[command.id]) return overrides[command.id];
    if (command.id === 'dashboard-platform-e2e') await writeFixturePlatformReport(environment);
    return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
  };
}

const fixtureFingerprint = () => ({ head: 'a'.repeat(40), tree: 'b'.repeat(40), statusSha256: 'c', stagedSha256: 'd', unstagedSha256: 'e' });

async function fixtureRun(overrides = {}, options = {}) {
  const { externalRoot } = await fixtureRoot();
  return runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: fixtureExecutor(overrides), probeTool: async (tool) => options.missingTool !== tool,
    gitFingerprint: fixtureFingerprint, ...options,
  });
}

test('baseline runner fixture uses the exact 25 required command receipts', async () => {
  assert.equal(BASELINE_COMMANDS.length, 25);
  const result = await fixtureRun();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.receipts.map(({ status }) => status), Array(25).fill('PASS'));
  const testCommandIds = new Set(BASELINE_COMMANDS.filter(({ assertion }) => assertion !== 'command').map(({ id }) => id));
  assert.ok(result.receipts.every(({ id, truthLevel, releaseEligible, assertionCount }) => truthLevel === 'L1' && releaseEligible === false && (testCommandIds.has(id) ? assertionCount > 0 : assertionCount === 0)));
});

test('baseline runner accepts silent successful non-test commands', async () => {
  const result = await fixtureRun({}, {
    execute: async (command, environment) => {
      if (command.command === 'kind') return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      if (command.id === 'dashboard-platform-e2e') await writeFixturePlatformReport(environment);
      if (command.assertion === 'go') return { exitCode: 0, stdout: 'ok\texample.test/module\t0.001s\n', stderr: '' };
      if (command.assertion === 'playwright') return { exitCode: 0, stdout: '3 passed\n', stderr: '' };
      if (command.assertion === 'node') return { exitCode: 0, stdout: '# tests 3\n# pass 3\n# skipped 0\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.receipts.filter(({ id }) => id.endsWith('-go-build') || id === 'root-typecheck').every(({ status, assertionCount }) => status === 'PASS' && assertionCount === 0));
});

test('dashboard fixture routes Playwright and Next build artifacts through external directories', async () => {
  const [playwright, nextConfig, fixture] = await Promise.all([
    readFile(path.join(sourceRoot, 'apps/dashboard/playwright.config.ts'), 'utf8'),
    readFile(path.join(sourceRoot, 'apps/dashboard/next.config.mjs'), 'utf8'),
    readFile(path.join(sourceRoot, 'apps/dashboard/tests/e2e/fixture/serve.mjs'), 'utf8'),
  ]);
  assert.match(playwright, /RAIBITSERVER_PLAYWRIGHT_OUTPUT_DIR/);
  assert.match(playwright, /RAIBITSERVER_PLAYWRIGHT_REPORT_PATH/);
  assert.doesNotMatch(playwright, /outputDir:\s*'\.\/test-results'/);
  assert.match(nextConfig, /RAIBITSERVER_NEXT_DIST_DIR/);
  assert.match(fixture, /RAIBITSERVER_E2E_FIXTURE_OUTPUT_DIR/);
});

test('Next distDir resolves approved external paths without a source-tree write', () => {
  const windowsTarget = 'C:\\evidence root\\한국어 space\\attempt';
  const windowsDirectory = 'C:\\rw\\dashboard';
  const windowsRelative = relativeExternalDistDir({ externalDistDir: windowsTarget, dashboardDirectory: windowsDirectory, pathApi: path.win32 });
  assert.equal(path.win32.resolve(windowsDirectory, windowsRelative), windowsTarget);
  assert.equal(path.win32.isAbsolute(windowsRelative), false);

  const posixTarget = '/evidence root/한국어 space/attempt';
  const posixDirectory = '/rw/dashboard';
  const posixRelative = relativeExternalDistDir({ externalDistDir: posixTarget, dashboardDirectory: posixDirectory, pathApi: path.posix });
  assert.equal(path.posix.resolve(posixDirectory, posixRelative), posixTarget);
  assert.equal(path.posix.isAbsolute(posixRelative), false);
  assert.throws(() => relativeExternalDistDir({ externalDistDir: 'D:\\evidence\\attempt', dashboardDirectory: windowsDirectory, pathApi: path.win32 }), /dashboard_next_dist_dir_unrepresentable/);
});

test('baseline runner uses the Task49 report for exact scenario IDs and counts', async () => {
  const coverage = await loadTask49Coverage(sourceRoot);
  const { externalRoot } = await fixtureRoot();
  const result = await runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: async (command, environment) => {
      if (command.command === 'kind') return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      if (command.id === 'dashboard-platform-e2e') {
        await writeTask49Evidence(environment, coverage);
        return { exitCode: 0, stdout: '1 passed\n', stderr: '' };
      }
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
    probeTool: async () => true,
    gitFingerprint: fixtureFingerprint,
  });
  const receipt = result.receipts.find(({ id }) => id === 'dashboard-platform-e2e');
  assert.equal(result.exitCode, 0);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.assertionCount, coverage.positiveIds.length + coverage.negativeIds.length);
});

test('baseline runner rejects a Task49 report with skipped or mismatched outcomes', async () => {
  const coverage = await loadTask49Coverage(sourceRoot);
  const { externalRoot } = await fixtureRoot();
  const result = await runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: async (command, environment) => {
      if (command.command === 'kind') return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      if (command.id === 'dashboard-platform-e2e') {
        await writeTask49Evidence(environment, coverage);
        await writeFile(environment.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH, JSON.stringify({
          ...reportFor('positive', coverage.positiveIds),
          outcomes: [{ id: coverage.positiveIds[0], status: 'skipped', api: { status: 200, method: 'GET', path: '/fixture' }, a11y: { violations: 0 } }],
          summary: { expected: coverage.positiveIds.length, passed: coverage.positiveIds.length - 1, failed: 0, skipped: 1, unexpected: 0, flaky: 0 },
        }));
      }
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
    probeTool: async () => true,
    gitFingerprint: fixtureFingerprint,
  });
  const receipt = result.receipts.find(({ id }) => id === 'dashboard-platform-e2e');
  assert.equal(result.exitCode, 1);
  assert.equal(receipt.reason, 'platform_expansion_report_invalid');
  assert.match(await readFile(path.join(result.attemptDir, receipt.log), 'utf8'), /3 passed/);
});

test('baseline runner preserves a failing Task49 command exit code before reading its report', async () => {
  const result = await fixtureRun({ 'dashboard-platform-e2e': { exitCode: 47, stdout: '', stderr: 'fixture failure' } });
  const receipt = result.receipts.find(({ id }) => id === 'dashboard-platform-e2e');
  assert.equal(result.exitCode, 47);
  assert.equal(receipt.reason, 'command_failed');
});

test('baseline runner rejects a dropped Task49 positive ID despite a forged matching summary', async () => {
  const coverage = await loadTask49Coverage(sourceRoot);
  const { externalRoot } = await fixtureRoot();
  const result = await runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: async (command, environment) => {
      if (command.command === 'kind') return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      if (command.id === 'dashboard-platform-e2e') await writeTask49Evidence(environment, coverage, coverage.positiveIds.slice(1));
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
    probeTool: async () => true,
    gitFingerprint: fixtureFingerprint,
  });
  const receipt = result.receipts.find(({ id }) => id === 'dashboard-platform-e2e');
  assert.equal(result.exitCode, 1);
  assert.equal(receipt.reason, 'platform_expansion_report_invalid');
});

test('baseline runner rejects a skipped Task49 negative report', async () => {
  const coverage = await loadTask49Coverage(sourceRoot);
  const { externalRoot } = await fixtureRoot();
  const result = await runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: async (command, environment) => {
      if (command.command === 'kind') return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      if (command.id === 'dashboard-platform-e2e') {
        await writeTask49Evidence(environment, coverage);
        await writeFile(path.join(path.dirname(environment.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH), 'task-49-platform-expansion-negative-evidence.json'), JSON.stringify({
          ...reportFor('negative', coverage.negativeIds), summary: { expected: coverage.negativeIds.length, passed: coverage.negativeIds.length - 1, failed: 0, skipped: 1, unexpected: 0, flaky: 0 },
        }));
      }
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
    probeTool: async () => true,
    gitFingerprint: fixtureFingerprint,
  });
  const receipt = result.receipts.find(({ id }) => id === 'dashboard-platform-e2e');
  assert.equal(result.exitCode, 1);
  assert.equal(receipt.reason, 'platform_expansion_report_invalid');
});

test('baseline runner rejects a skipped Playwright matrix report', async () => {
  const coverage = await loadTask49Coverage(sourceRoot);
  const { externalRoot } = await fixtureRoot();
  const result = await runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: async (command, environment) => {
      if (command.command === 'kind') return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      if (command.id === 'dashboard-platform-e2e') {
        await writeTask49Evidence(environment, coverage);
        const report = playwrightReport(coverage);
        report.stats.skipped = 1;
        await writeFile(environment.RAIBITSERVER_PLAYWRIGHT_REPORT_PATH, JSON.stringify(report));
      }
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
    probeTool: async () => true,
    gitFingerprint: fixtureFingerprint,
  });
  const receipt = result.receipts.find(({ id }) => id === 'dashboard-platform-e2e');
  assert.equal(result.exitCode, 1);
  assert.equal(receipt.reason, 'platform_expansion_playwright_report_invalid');
});

for (const command of BASELINE_COMMANDS.filter(({ id }) => id.endsWith('-go-test') || id.endsWith('-go-build'))) {
  test(`baseline runner fails fast for ${command.id} and records remaining commands as NOT_RUN`, async () => {
    const result = await fixtureRun({ [command.id]: { exitCode: 23, stdout: 'failed fixture\n', stderr: '' } });
    const index = BASELINE_COMMANDS.findIndex(({ id }) => id === command.id);
    assert.equal(result.exitCode, 23);
    assert.equal(result.receipts[index].status, 'FAIL');
    assert.equal(result.receipts[index].reason, 'command_failed');
    assert.ok(result.receipts.slice(index + 1).every(({ status }) => status === 'NOT_RUN'));
  });
}

test('baseline runner rejects missing Helm and kind before a command can pass', async () => {
  for (const missingTool of ['helm', 'kind']) {
    const result = await fixtureRun({}, { missingTool });
    const id = missingTool === 'helm' ? 'helm-verify' : 'live-e2e';
    const receipt = result.receipts.find((entry) => entry.id === id);
    assert.equal(receipt.status, 'FAIL');
    assert.equal(receipt.reason, `missing_tool:${missingTool}`);
    assert.equal(result.exitCode, 127);
  }
});

test('baseline runner rejects an omitted command and empty assertions', async () => {
  const { externalRoot } = await fixtureRoot();
  await assert.rejects(
    runBaseline({ attemptDir: path.join(externalRoot, 'omitted'), externalRoot, sourceRoot, commands: BASELINE_COMMANDS.slice(0, -1) }),
    (error) => error instanceof BaselineError && error.code === 'baseline_command_count_invalid',
  );
  const result = await fixtureRun({ 'root-test': { exitCode: 0, stdout: '# tests 0\n# pass 0\n', stderr: '' } });
  assert.equal(result.receipts[0].reason, 'empty_assertions');
  assert.ok(result.receipts.slice(1).every(({ status }) => status === 'NOT_RUN'));
});

test('baseline runner rejects skipped rows and keeps runtime output paths external', async () => {
  const { externalRoot } = await fixtureRoot();
  const seenEnvironment = [];
  const result = await runBaseline({
    attemptDir: path.join(externalRoot, 'run'), externalRoot, sourceRoot, runId: 'fixture-run',
    execute: async (command, environment) => {
      seenEnvironment.push(environment);
      if (command.id === 'root-test') return { exitCode: 0, stdout: '# tests 3\n# pass 3\n# skipped 1\n', stderr: '' };
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
    probeTool: async () => true,
    gitFingerprint: fixtureFingerprint,
  });
  assert.equal(result.receipts[0].reason, 'skipped_assertions');
  assert.ok(result.receipts.slice(1).every(({ status }) => status === 'NOT_RUN'));
  for (const key of ['TMPDIR', 'TEMP', 'TMP', 'RAIBITSERVER_E2E_OUTPUT_DIR', 'PLAYWRIGHT_OUTPUT_DIR', 'RAIBITSERVER_PLAYWRIGHT_OUTPUT_DIR', 'RAIBITSERVER_PLAYWRIGHT_REPORT_PATH', 'RAIBITSERVER_E2E_FIXTURE_OUTPUT_DIR']) {
    assert.ok(seenEnvironment[0][key].startsWith(result.attemptDir));
  }
});

test('baseline runner records cleanup and rejects output reuse, source paths, and reparses', async () => {
  const result = await fixtureRun();
  assert.deepEqual(result.cleanup, { attempted: true, createdResources: [], status: 'PASS', cluster: 'raibit-baseline-fixturerun' });

  const { parent, externalRoot } = await fixtureRoot();
  await mkdir(path.join(externalRoot, 'used'));
  await assert.rejects(
    prepareAttemptDirectory({ attemptDir: path.join(externalRoot, 'used'), externalRoot, sourceRoot }),
    (error) => error instanceof BaselineError && error.code === 'attempt_dir_reused',
  );
  await assert.rejects(
    prepareAttemptDirectory({ attemptDir: path.join(sourceRoot, 'bad-baseline-output'), externalRoot, sourceRoot }),
    (error) => error instanceof BaselineError && error.code === 'attempt_dir_inside_source_tree',
  );
  const outside = path.join(parent, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(externalRoot, 'linked'), 'junction');
  await assert.rejects(
    prepareAttemptDirectory({ attemptDir: path.join(externalRoot, 'linked', 'run'), externalRoot, sourceRoot }),
    (error) => error instanceof BaselineError && error.code === 'attempt_dir_reparse_escape',
  );
});

test('baseline runner confirms kind cleanup after live-e2e failure', async () => {
  let kindChecks = 0;
  const result = await fixtureRun({
    'live-e2e': { exitCode: 9, stdout: 'live fixture failed\n', stderr: '' },
  }, {
    execute: async (command) => {
      if (command.command === 'kind') {
        kindChecks += 1;
        return { exitCode: 0, stdout: 'other-cluster\n', stderr: '' };
      }
      if (command.id === 'live-e2e') return { exitCode: 9, stdout: 'live fixture failed\n', stderr: '' };
      return { exitCode: 0, stdout: fixtureOutput(command), stderr: '' };
    },
  });
  assert.equal(result.exitCode, 9);
  assert.equal(result.cleanup.status, 'PASS');
  assert.equal(kindChecks, 2);
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BASELINE_COMMANDS, BaselineError, prepareAttemptDirectory, runBaseline } from '../scripts/platform-expansion-baseline.mjs';

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

function fixtureExecutor(overrides = {}) {
  return async (command) => {
    if (overrides[command.id] instanceof Error) throw overrides[command.id];
    if (overrides[command.id]) return overrides[command.id];
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
  assert.ok(result.receipts.every(({ truthLevel, releaseEligible, assertionCount }) => truthLevel === 'L1' && releaseEligible === false && assertionCount > 0));
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
  for (const key of ['TMPDIR', 'TEMP', 'TMP', 'RAIBITSERVER_E2E_OUTPUT_DIR', 'PLAYWRIGHT_OUTPUT_DIR']) {
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

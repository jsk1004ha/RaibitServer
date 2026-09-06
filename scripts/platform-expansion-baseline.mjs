import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GO_MODULES = [
  'services/builder',
  'services/orchestrator',
  'services/provisioner',
  'services/log-ingester',
  'services/metrics-ingester',
  'services/registry-broker',
];

const rootCommand = (id, args, assertion = 'node') => ({
  id,
  command: 'pnpm',
  args,
  cwd: '.',
  assertion,
  requiredTools: ['pnpm'],
});

export const BASELINE_COMMANDS = Object.freeze([
  rootCommand('root-test', ['test']),
  rootCommand('root-typecheck', ['typecheck'], 'command'),
  rootCommand('root-lint', ['lint'], 'command'),
  rootCommand('root-prisma-validate', ['prisma:validate'], 'command'),
  { id: 'root-structure', command: 'node', args: ['scripts/check-structure.js'], cwd: '.', assertion: 'command', requiredTools: ['node'] },
  { id: 'root-cli-validate', command: 'node', args: ['src/cli.js', 'validate', 'examples/project.json'], cwd: '.', assertion: 'command', requiredTools: ['node'] },
  { id: 'root-cli-manifest', command: 'node', args: ['src/cli.js', 'manifest', 'examples/project.json'], cwd: '.', assertion: 'command', requiredTools: ['node'] },
  { id: 'root-cli-compose', command: 'node', args: ['src/cli.js', 'compose', 'examples/docker-compose.yml'], cwd: '.', assertion: 'command', requiredTools: ['node'] },
  rootCommand('root-e2e-dry', ['e2e:dry'], 'command'),
  ...GO_MODULES.flatMap((cwd) => [
    { id: `${path.basename(cwd)}-go-test`, command: 'go', args: ['test', './...'], cwd, assertion: 'go', requiredTools: ['go'] },
    { id: `${path.basename(cwd)}-go-build`, command: 'go', args: ['build', './...'], cwd, assertion: 'command', requiredTools: ['go'] },
  ]),
  { id: 'dashboard-test', command: 'pnpm', args: ['--filter', '@raibitserver/dashboard', 'test'], cwd: '.', assertion: 'node', requiredTools: ['pnpm'] },
  { id: 'helm-verify', command: 'bash', args: ['scripts/verify-helm.sh'], cwd: '.', assertion: 'command', requiredTools: ['bash', 'helm'] },
  { id: 'live-e2e', command: 'pnpm', args: ['e2e:live'], cwd: '.', assertion: 'command', requiredTools: ['pnpm', 'docker', 'kind', 'kubectl', 'helm', 'curl', 'go'] },
  { id: 'dashboard-platform-e2e', command: 'pnpm', args: ['--filter', '@raibitserver/dashboard', 'test:e2e', '--', '--grep', '@platform-expansion'], cwd: '.', assertion: 'playwright', requiredTools: ['pnpm'] },
]);

const EXPECTED_COMMAND_IDS = Object.freeze([
  'root-test', 'root-typecheck', 'root-lint', 'root-prisma-validate', 'root-structure',
  'root-cli-validate', 'root-cli-manifest', 'root-cli-compose', 'root-e2e-dry',
  ...GO_MODULES.flatMap((cwd) => [`${path.basename(cwd)}-go-test`, `${path.basename(cwd)}-go-build`]),
  'dashboard-test', 'helm-verify', 'live-e2e', 'dashboard-platform-e2e',
]);

export class BaselineError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertExistingDirectory(target, code) {
  const stat = await lstatOrNull(target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new BaselineError(code, `invalid directory: ${target}`);
}

async function assertNoReparsePath(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new BaselineError('attempt_dir_outside_external_root');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw new BaselineError('attempt_dir_reparse_escape');
  }
}

export async function prepareAttemptDirectory({ attemptDir, externalRoot, sourceRoot = SOURCE_ROOT }) {
  if (!path.isAbsolute(attemptDir) || !path.isAbsolute(externalRoot)) {
    throw new BaselineError('attempt_dir_must_be_absolute');
  }
  const resolvedRoot = path.resolve(externalRoot);
  const resolvedAttempt = path.resolve(attemptDir);
  const resolvedSource = await realpath(sourceRoot);
  await assertExistingDirectory(resolvedRoot, 'external_attempt_root_invalid');
  const canonicalRoot = await realpath(resolvedRoot);
  if (canonicalRoot !== resolvedRoot) throw new BaselineError('external_attempt_root_reparse_escape');
  if (isWithin(resolvedSource, resolvedAttempt)) throw new BaselineError('attempt_dir_inside_source_tree');
  await assertNoReparsePath(canonicalRoot, resolvedAttempt);
  if (await lstatOrNull(resolvedAttempt)) throw new BaselineError('attempt_dir_reused');
  const parent = path.dirname(resolvedAttempt);
  if (!existsSync(parent)) throw new BaselineError('attempt_dir_parent_missing');
  await mkdir(resolvedAttempt, { mode: 0o700 });
  const canonicalAttempt = await realpath(resolvedAttempt);
  if (!isWithin(canonicalRoot, canonicalAttempt) || canonicalAttempt === canonicalRoot) {
    await rm(resolvedAttempt, { recursive: true, force: true });
    throw new BaselineError('attempt_dir_reparse_escape');
  }
  for (const child of ['logs', 'receipts', 'reports', 'screenshots', 'tmp']) {
    await mkdir(path.join(canonicalAttempt, child), { mode: 0o700 });
  }
  return canonicalAttempt;
}

function commandSetError(commands) {
  if (!Array.isArray(commands) || commands.length !== EXPECTED_COMMAND_IDS.length) return 'baseline_command_count_invalid';
  const ids = commands.map(({ id }) => id);
  return ids.every((id, index) => id === EXPECTED_COMMAND_IDS[index]) ? null : 'baseline_command_set_invalid';
}

function parseAssertions(kind, output) {
  const normalized = `${output ?? ''}`;
  if (kind === 'command') return { count: 0, skipped: 0 };
  const skipped = [...normalized.matchAll(/(?:#\s*skipped|\bskipped\s*[:=]?\s*)(\d+)/gi)]
    .reduce((total, match) => total + Number(match[1]), 0);
  if (skipped > 0) return { count: 0, skipped };
  if (kind === 'go') return { count: normalized.split(/\r?\n/).filter((line) => /^ok\s+/.test(line)).length, skipped };
  if (kind === 'playwright') {
    const match = normalized.match(/(\d+)\s+passed\b/i);
    return { count: match ? Number(match[1]) : 0, skipped };
  }
  if (kind === 'node') {
    const node = normalized.match(/#\s*tests\s+(\d+)/i);
    const passed = normalized.match(/(\d+)\s+passed\b/i);
    return { count: Number(node?.[1] ?? passed?.[1] ?? 0), skipped };
  }
  return { count: normalized.trim().length > 0 ? 1 : 0, skipped };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameIds(actual, expected) {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((id) => expected.includes(id));
}

const task49CoverageBySourceRoot = new Map();

export async function loadTask49Coverage(sourceRoot = SOURCE_ROOT) {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const cached = task49CoverageBySourceRoot.get(canonicalSourceRoot);
  if (cached) return cached;
  let compiler;
  let matrixSource;
  try {
    compiler = (await import('typescript')).default;
    matrixSource = await readFile(path.join(canonicalSourceRoot, 'apps/dashboard/tests/e2e/feature-expansion-matrix.ts'), 'utf8');
  } catch {
    throw new BaselineError('platform_expansion_matrix_unavailable');
  }
  if (!compiler?.transpileModule) throw new BaselineError('platform_expansion_matrix_unavailable');
  let matrix;
  try {
    const output = compiler.transpileModule(matrixSource, { compilerOptions: { module: compiler.ModuleKind.ESNext, target: compiler.ScriptTarget.ES2022 } });
    matrix = await import(`data:text/javascript;base64,${Buffer.from(output.outputText).toString('base64')}`);
  } catch {
    throw new BaselineError('platform_expansion_matrix_invalid');
  }
  const executableRows = matrix.PLATFORM_EXPANSION_EXECUTABLE_ROWS;
  const negativeRows = matrix.PLATFORM_EXPANSION_NEGATIVE_ROWS;
  if (!Array.isArray(executableRows) || !Array.isArray(negativeRows)) throw new BaselineError('platform_expansion_matrix_invalid');
  const executableIds = executableRows.map((row) => row?.id);
  const negativeIds = negativeRows.map((row) => row?.id);
  if (executableIds.length === 0 || executableIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(executableIds).size !== executableIds.length || !sameIds(negativeIds, executableIds.filter((id) => negativeIds.includes(id)))) {
    throw new BaselineError('platform_expansion_matrix_invalid');
  }
  const negativeIdSet = new Set(negativeIds);
  const coverage = Object.freeze({
    positiveIds: Object.freeze(executableIds.filter((id) => !negativeIdSet.has(id))),
    negativeIds: Object.freeze(negativeIds),
  });
  if (coverage.positiveIds.length === 0 || coverage.negativeIds.length === 0) throw new BaselineError('platform_expansion_matrix_invalid');
  task49CoverageBySourceRoot.set(canonicalSourceRoot, coverage);
  return coverage;
}

async function readEvidenceJson(reportPath, missingCode) {
  let report;
  try {
    const reportStat = await lstat(reportPath);
    if (!reportStat.isFile() || reportStat.isSymbolicLink()) throw new BaselineError(missingCode);
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    if (error?.code === 'ENOENT') throw new BaselineError(missingCode);
    throw new BaselineError('platform_expansion_report_invalid');
  }
  return report;
}

async function validateTask49Report(reportPath, kind, expectedIds) {
  const report = await readEvidenceJson(reportPath, 'platform_expansion_report_missing');
  if (!isRecord(report) || report.schema !== 'raibit.task49.v1' || !Array.isArray(report.expectedScenarioIds) || !Array.isArray(report.outcomes) || !isRecord(report.summary)) {
    throw new BaselineError('platform_expansion_report_invalid');
  }
  const expected = report.expectedScenarioIds;
  if (report.kind !== kind || expected.some((id) => typeof id !== 'string' || id.length === 0) || !sameIds(expected, expectedIds)) {
    throw new BaselineError('platform_expansion_report_invalid');
  }
  const summary = report.summary;
  if (!isCount(summary.expected) || !isCount(summary.passed) || !isCount(summary.failed) || !isCount(summary.skipped) || !isCount(summary.unexpected) || !isCount(summary.flaky)
    || summary.expected !== expectedIds.length || summary.passed !== expectedIds.length || summary.failed !== 0 || summary.skipped !== 0 || summary.unexpected !== 0 || summary.flaky !== 0) {
    throw new BaselineError('platform_expansion_report_invalid');
  }
  const outcomes = report.outcomes;
  if (outcomes.length !== expectedIds.length || outcomes.some((outcome) => !isRecord(outcome) || typeof outcome.id !== 'string' || outcome.status !== 'passed')) {
    throw new BaselineError('platform_expansion_report_invalid');
  }
  const outcomeIds = outcomes.map((outcome) => outcome.id);
  if (!sameIds(outcomeIds, expectedIds)) {
    throw new BaselineError('platform_expansion_report_invalid');
  }
}

function collectPlaywrightSpecs(suites) {
  if (!Array.isArray(suites)) return null;
  const specs = [];
  for (const suite of suites) {
    if (!isRecord(suite)) return null;
    if (suite.specs !== undefined) {
      if (!Array.isArray(suite.specs)) return null;
      specs.push(...suite.specs);
    }
    const nested = collectPlaywrightSpecs(suite.suites ?? []);
    if (nested === null) return null;
    specs.push(...nested);
  }
  return specs;
}

async function validatePlaywrightReport(reportPath, coverage) {
  const report = await readEvidenceJson(reportPath, 'platform_expansion_playwright_report_missing');
  if (!isRecord(report) || !isRecord(report.stats)) throw new BaselineError('platform_expansion_playwright_report_invalid');
  const expectedTitles = [
    ...coverage.positiveIds.map((id) => `@platform-expansion ${id}`),
    ...coverage.negativeIds.map((id) => `@platform-expansion ${id}`),
  ];
  const stats = report.stats;
  if (!isCount(stats.expected) || !isCount(stats.skipped) || !isCount(stats.unexpected) || !isCount(stats.flaky)
    || stats.expected !== expectedTitles.length || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) {
    throw new BaselineError('platform_expansion_playwright_report_invalid');
  }
  const specs = collectPlaywrightSpecs(report.suites);
  if (specs === null || specs.length !== expectedTitles.length || !sameIds(specs.map((spec) => spec?.title), expectedTitles)) {
    throw new BaselineError('platform_expansion_playwright_report_invalid');
  }
  if (specs.some((spec) => !Array.isArray(spec.tests) || spec.tests.length !== 1 || spec.tests[0]?.results?.length !== 1 || spec.tests[0].results[0]?.status !== 'passed')) {
    throw new BaselineError('platform_expansion_playwright_report_invalid');
  }
}

async function platformExpansionEvidenceAssertionCount(sourceRoot, reportPath, playwrightReportPath) {
  const coverage = await loadTask49Coverage(sourceRoot);
  await validateTask49Report(reportPath, 'positive', coverage.positiveIds);
  await validateTask49Report(path.join(path.dirname(reportPath), 'task-49-platform-expansion-negative-evidence.json'), 'negative', coverage.negativeIds);
  await validatePlaywrightReport(playwrightReportPath, coverage);
  return coverage.positiveIds.length + coverage.negativeIds.length;
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function nativeExecute(command, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: path.resolve(SOURCE_ROOT, command.cwd),
      env: environment,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr }));
  });
}

function nativeProbe(tool, environment) {
  return new Promise((resolve) => {
    const child = spawn(tool, ['--version'], { env: environment, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function nativeGitFingerprint(sourceRoot) {
  const runGit = (args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: sourceRoot, shell: false, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new BaselineError('git_fingerprint_failed')));
  });
  const [head, tree, status, staged, unstaged] = await Promise.all([
    runGit(['rev-parse', 'HEAD']), runGit(['rev-parse', 'HEAD^{tree}']), runGit(['status', '--porcelain=v2', '-z']),
    runGit(['diff', '--cached', '--binary']), runGit(['diff', '--binary']),
  ]);
  return { head: head.trim(), tree: tree.trim(), statusSha256: digest(status), stagedSha256: digest(staged), unstagedSha256: digest(unstaged) };
}

function sameFingerprint(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runBaseline(options) {
  const commands = options.commands ?? BASELINE_COMMANDS;
  const invalidSet = commandSetError(commands);
  if (invalidSet) throw new BaselineError(invalidSet);
  const sourceRoot = options.sourceRoot ?? SOURCE_ROOT;
  const attemptDir = await prepareAttemptDirectory({ attemptDir: options.attemptDir, externalRoot: options.externalRoot, sourceRoot });
  const runId = options.runId ?? randomUUID();
  const execute = options.execute ?? nativeExecute;
  const probeTool = options.probeTool ?? nativeProbe;
  const gitFingerprint = options.gitFingerprint ?? (() => nativeGitFingerprint(sourceRoot));
  const beforeFingerprint = await gitFingerprint();
  const directories = Object.fromEntries(['logs', 'receipts', 'reports', 'screenshots', 'tmp'].map((name) => [name, path.join(attemptDir, name)]));
  const environment = {
    ...process.env,
    TMPDIR: directories.tmp,
    TEMP: directories.tmp,
    TMP: directories.tmp,
    RAIBITSERVER_E2E_OUTPUT_DIR: directories.reports,
    PLAYWRIGHT_OUTPUT_DIR: directories.screenshots,
    RAIBITSERVER_PLAYWRIGHT_OUTPUT_DIR: directories.screenshots,
    RAIBITSERVER_PLAYWRIGHT_REPORT_PATH: path.join(directories.reports, 'dashboard-platform-expansion.json'),
    RAIBITSERVER_E2E_FIXTURE_OUTPUT_DIR: path.join(directories.tmp, 'dashboard-fixture'),
    RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH: path.join(attemptDir, 'task-49-platform-expansion-evidence.json'),
    RAIBITSERVER_LIVE_E2E_CLUSTER: `raibit-baseline-${runId.replaceAll('-', '').slice(0, 18)}`,
  };
  const receipts = [];
  let failure = null;
  let liveE2eExecuted = false;
  let cleanup = { attempted: false, createdResources: [], status: 'NOT_RUN' };
  await writeJson(path.join(attemptDir, 'run.json'), {
    schema: 'raibitserver.platform-expansion-baseline/v1', runId, sourceRoot: await realpath(sourceRoot),
    sourceCommitSha: beforeFingerprint.head, sourceTreeSha: beforeFingerprint.tree, truthLevel: 'L1', releaseEligible: false,
  });

  for (const [index, command] of commands.entries()) {
    const receipt = {
      schema: 'raibitserver.platform-expansion-baseline-receipt/v1', id: command.id,
      ordinal: index + 1, command: [command.command, ...command.args], cwd: command.cwd,
      truthLevel: 'L1', releaseEligible: false, status: 'NOT_RUN', assertionCount: 0, skippedCount: 0,
      log: path.join('logs', `${String(index + 1).padStart(2, '0')}-${command.id}.log`),
    };
    if (failure) {
      receipt.reason = `blocked_by:${failure.id}`;
    } else {
      for (const tool of command.requiredTools) {
        if (!(await probeTool(tool, environment))) {
          failure = { id: command.id, code: `missing_tool:${tool}`, exitCode: 127 };
          break;
        }
      }
      if (!failure && command.id === 'live-e2e') {
        try {
          const clusters = await execute({ command: 'kind', args: ['get', 'clusters'], cwd: '.' }, environment);
          if (clusters.exitCode !== 0) failure = { id: command.id, code: 'kind_cluster_list_failed', exitCode: clusters.exitCode || 1 };
          else if (`${clusters.stdout}`.split(/\r?\n/).includes(environment.RAIBITSERVER_LIVE_E2E_CLUSTER)) {
            failure = { id: command.id, code: 'kind_cluster_name_reused', exitCode: 1 };
          }
        } catch (error) {
          failure = { id: command.id, code: error?.code === 'ENOENT' ? 'missing_tool:kind' : 'kind_cluster_list_failed', exitCode: 127 };
        }
      }
      if (!failure) {
        try {
          if (command.id === 'live-e2e') liveE2eExecuted = true;
          const result = await execute(command, environment);
          const stdout = `${result.stdout ?? ''}`;
          const stderr = `${result.stderr ?? ''}`;
          const assertions = parseAssertions(command.assertion, `${stdout}\n${stderr}`);
          receipt.exitCode = result.exitCode;
          receipt.assertionCount = assertions.count;
          receipt.skippedCount = assertions.skipped;
          receipt.stdoutSha256 = digest(stdout);
          receipt.stderrSha256 = digest(stderr);
          await writeFile(path.join(attemptDir, receipt.log), `${stdout}${stderr}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          if (command.id === 'dashboard-platform-e2e' && result.exitCode === 0) {
            receipt.assertionCount = await platformExpansionEvidenceAssertionCount(sourceRoot, environment.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH, environment.RAIBITSERVER_PLAYWRIGHT_REPORT_PATH);
            receipt.skippedCount = 0;
          }
          if (result.exitCode !== 0) failure = { id: command.id, code: 'command_failed', exitCode: result.exitCode || 1 };
          else if (command.id !== 'dashboard-platform-e2e' && command.assertion !== 'command' && assertions.skipped > 0) failure = { id: command.id, code: 'skipped_assertions', exitCode: 1 };
          else if (command.id !== 'dashboard-platform-e2e' && command.assertion !== 'command' && assertions.count === 0) failure = { id: command.id, code: 'empty_assertions', exitCode: 1 };
          else receipt.status = 'PASS';
        } catch (error) {
          failure = error instanceof BaselineError
            ? { id: command.id, code: error.code, exitCode: 1 }
            : { id: command.id, code: error?.code === 'ENOENT' ? `missing_tool:${command.command}` : 'command_spawn_failed', exitCode: 127 };
        }
      }
      if (failure && receipt.status !== 'PASS') {
        receipt.status = 'FAIL';
        receipt.reason = failure.code;
        receipt.exitCode ??= failure.exitCode;
      }
    }
    receipts.push(receipt);
    await writeJson(path.join(attemptDir, 'receipts', `${String(index + 1).padStart(2, '0')}-${command.id}.json`), receipt);
  }

  try {
    cleanup = { attempted: true, createdResources: [], status: 'PASS', cluster: environment.RAIBITSERVER_LIVE_E2E_CLUSTER };
    if (liveE2eExecuted) {
      try {
        const clusters = await execute({ command: 'kind', args: ['get', 'clusters'], cwd: '.' }, environment);
        if (clusters.exitCode !== 0 || `${clusters.stdout}`.split(/\r?\n/).includes(environment.RAIBITSERVER_LIVE_E2E_CLUSTER)) {
          cleanup.status = 'FAIL';
          cleanup.reason = 'kind_cleanup_not_confirmed';
          failure ??= { id: 'live-e2e', code: cleanup.reason, exitCode: 1 };
        }
      } catch {
        cleanup.status = 'FAIL';
        cleanup.reason = 'kind_cleanup_not_confirmed';
        failure ??= { id: 'live-e2e', code: cleanup.reason, exitCode: 1 };
      }
    }
  } finally {
    const afterFingerprint = await gitFingerprint();
    if (!sameFingerprint(beforeFingerprint, afterFingerprint)) {
      failure ??= { id: 'git-fingerprint', code: 'source_fingerprint_changed', exitCode: 1 };
    }
    const manifest = {
      schema: 'raibitserver.platform-expansion-baseline/v1', runId, truthLevel: 'L1', releaseEligible: false,
      status: failure ? 'FAIL' : 'PASS', exitCode: failure?.exitCode ?? 0, failure: failure?.code ?? null,
      sourceFingerprint: { before: beforeFingerprint, after: afterFingerprint }, cleanup, receipts,
    };
    await writeJson(path.join(attemptDir, 'manifest.json'), manifest);
  }
  return { attemptDir, receipts, failure, cleanup, exitCode: failure?.exitCode ?? 0 };
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--attempt-dir' || !path.isAbsolute(argv[1])) {
    throw new BaselineError('usage', 'usage: verify-platform-expansion-baseline.sh --attempt-dir <absolute-output-directory>');
  }
  const externalRoot = process.env.RAIBITSERVER_BASELINE_ATTEMPT_ROOT;
  if (!externalRoot) throw new BaselineError('external_attempt_root_required');
  return { attemptDir: argv[1], externalRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runBaseline(parseCli(process.argv.slice(2)));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`baseline runner: ${error instanceof BaselineError ? error.code : 'unexpected_error'}\n`);
    process.exitCode = 2;
  }
}

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseCiExecutionContext, parseCiInvocation, parseReleaseTag } from '../scripts/production-evidence/lib/ci-invocation.mjs';
import { runMissingSigningFixture } from '../scripts/production-evidence/preflight.mjs';
import { runGateA, validateReleasePolicy } from '../scripts/run-gate-a.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';

const sha = 'a'.repeat(40), blobSha = 'b'.repeat(40), nonce = '123e4567-e89b-42d3-a456-426614174000';
const tag = `raibit-gate-a-${sha}-missing-secret-${nonce}`;
const execution = { repository: 'jsk1004ha/RaibitServer', ref: `refs/tags/${tag}`, sourceCommitSha: sha, runId: '42', runAttempt: 1,
  workflowRef: `jsk1004ha/RaibitServer/.github/workflows/production-evidence.yml@refs/tags/${tag}`, workflowSha: sha, event: 'push' };
const invocation = { schema: 'raibitserver.ci-invocation/v1', repository: execution.repository, ref: execution.ref, tag, nonce,
  candidateSha: sha, workflowId: 99, workflowPath: '.github/workflows/production-evidence.yml', blobSha, runId: '42', runAttempt: 1,
  event: 'push', createdAt: '2026-09-06T00:00:01.000Z', execution };

async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gate-a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Given the release branch, When Gate A is prepared, Then the protected workflow exists', () => {
  // Given the repository candidate is checked out.
  const workflow = new URL('../.github/workflows/production-evidence.yml', import.meta.url);
  // When the release workflow boundary is inspected.
  const present = existsSync(workflow);
  // Then tag-triggered evidence cannot depend on default-branch registration.
  assert.equal(present, true);
});

test('Given both release profiles, When workflow guards are read, Then negative stays secret-free and Gate B stays separate', async () => {
  // Given the committed tag-triggered workflow text.
  const source = await readFile(new URL('../.github/workflows/production-evidence.yml', import.meta.url), 'utf8');
  const preflight = source.slice(source.indexOf('  preflight:'), source.indexOf('  live-evidence:'));
  // When tag filters and job-level guards are inspected.
  assert.match(source, /raibit-gate-a-\*/);
  assert.match(source, /raibit-gate-b-\*/);
  assert.match(source, /needs\.preflight\.result == 'success'/);
  // Then the secret-free job has no stored-secret expression and the live job alone attaches the environment.
  assert.doesNotMatch(preflight, /secrets\./);
  assert.doesNotMatch(preflight, /environment: raibit-production-evidence/);
  assert.match(source.slice(source.indexOf('  live-evidence:')), /environment: raibit-production-evidence/);
});

test('Given frozen Actions metadata, When parsing CI identity, Then exact Gate A and Gate B bind and reruns fail', () => {
  // Given an exact attempt-one push projection.
  assert.deepEqual(parseCiExecutionContext(execution), execution);
  // When rich invocation and final tag grammar are parsed.
  assert.equal(parseCiInvocation(invocation).blobSha, blobSha);
  assert.equal(parseReleaseTag(`raibit-gate-b-${sha}-${nonce}`).profile, 'final');
  // Then a rerun cannot be normalized as fresh evidence.
  assert.throws(() => parseCiExecutionContext({ ...execution, runAttempt: 2 }), /ci_identity_mismatch/);
});

test('Given a foreign repository execution, When CI identity is parsed, Then it fails before environment use', () => {
  // Given a syntactically valid projection from a different repository.
  const foreign = { ...execution, repository: 'other/RaibitServer',
    workflowRef: `other/RaibitServer/.github/workflows/production-evidence.yml@${execution.ref}` };
  // When the shared execution boundary parses it, Then exact upstream binding rejects it.
  assert.throws(() => parseCiExecutionContext(foreign), /ci_identity_mismatch/);
});

test('Given split creation and immutable tag rules, When release policy is parsed, Then only typed user creation bypass is accepted', () => {
  // Given one exact environment tag and independent creation/immutability rulesets.
  const environment = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const policies = [{ type: 'tag', name: 'raibit-gate-a-*' }];
  const rulesets = [
    { target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'], exclude: [] } },
      rules: [{ type: 'creation' }], bypass_actors: [{ actor_id: 7, actor_type: 'User', bypass_mode: 'always' }] },
    { target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'], exclude: [] } },
      rules: [{ type: 'update' }, { type: 'deletion' }], bypass_actors: [] },
  ];
  // When policy binds the authenticated user, Then the split policy is accepted and extra access is rejected.
  assert.doesNotThrow(() => validateReleasePolicy({ environment, policies, rulesets, actor: { id: 7, type: 'User' } }));
  assert.throws(() => validateReleasePolicy({ environment, policies: [...policies, { type: 'branch', name: '*' }], rulesets, actor: { id: 7, type: 'User' } }), /environment_policy_mismatch/);
});

test('Given an otherwise-valid fixture, When signing reference is absent, Then output is ineligible and cleaned', async (t) => {
  // Given only the signing binding is absent from the committed fixture.
  const root = await sandbox(t), receipt = path.join(root, 'ci.json'), attemptDir = path.join(root, 'result');
  await writeFile(receipt, JSON.stringify(invocation));
  // When the pure operator-input validator executes fixture mode.
  const result = await runMissingSigningFixture({ fixture: path.resolve('test-fixtures/production-evidence/gate-a-missing-secret.json'), ciReceipt: receipt, attemptDir });
  // Then no provider adapter runs and cleanup proves zero created resources.
  assert.deepEqual([result.status, result.reason, result.testOnly, result.releaseEligible], ['NOT_RUN', 'missing_secret_ref', true, false]);
  assert.equal(JSON.parse(await readFile(path.join(attemptDir, 'cleanup.json'), 'utf8')).resourcesCreated, 0);
});

test('Given the committed missing-signing fixture, When the public preflight CLI runs, Then it exits nonzero with physical cleanup evidence', async (t) => {
  // Given a frozen external CI receipt and a fresh output directory.
  const root = await sandbox(t), receipt = path.join(root, 'ci.json'), attemptDir = path.join(root, 'negative');
  await writeFile(receipt, JSON.stringify(invocation));
  // When the public secret-free fixture command executes in a separate Node process.
  const result = spawnSync(process.execPath, ['scripts/production-evidence/preflight.mjs', '--profile', 'train-a',
    '--fixture', path.resolve('test-fixtures/production-evidence/gate-a-missing-secret.json'), '--ci-receipt', receipt,
    '--attempt-dir', attemptDir], { cwd: path.resolve('.'), encoding: 'utf8' });
  // Then it is deliberately nonzero and its files carry the exact ineligible reason and zero resources.
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(await readFile(path.join(attemptDir, 'preflight.json'), 'utf8')).reason, 'missing_secret_ref');
  assert.deepEqual(JSON.parse(await readFile(path.join(attemptDir, 'cleanup.json'), 'utf8')).resourcesRemaining, 0);
});

test('Given selected tag policy, When creation is not bound to the actor, Then launch fails closed', () => {
  // Given the environment tag rule but no authorized ruleset bypass.
  const environment = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const policies = [{ type: 'tag', name: 'raibit-gate-a-*' }];
  const rulesets = [{ target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'] } },
    rules: ['creation', 'update', 'deletion'].map((type) => ({ type })), bypass_actors: [] }];
  // When the authenticated actor is bound, Then absence of authorization blocks before push.
  assert.throws(() => validateReleasePolicy({ environment, policies, rulesets, actor: { id: 7, type: 'User' } }), /tag_ruleset_mismatch/);
});

test('Given a negative run, When watch fails, Then metadata and evidence still download before ineligible receipt', async (t) => {
  // Given a clean exact A3 candidate and protected release policy.
  const parent = await sandbox(t), attemptDir = path.join(parent, 'task-28-negative'), calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    const joined = args.join(' ');
    if (file === 'git' && args[0] === 'status') return { stdout: '', exitCode: 0 };
    if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, exitCode: 0 };
    if (file === 'git' && args[0] === 'show-ref') return { stdout: '', exitCode: 1 };
    if (file === 'git' && args[0] === 'push') return { stdout: '', exitCode: 0 };
    if (joined === 'api --method GET repos/jsk1004ha/RaibitServer') return { stdout: JSON.stringify({ default_branch: 'main' }), exitCode: 0 };
    if (joined === 'api --method GET repos/jsk1004ha/RaibitServer/pulls/3') return { stdout: JSON.stringify({ state: 'open', head: { sha }, base: { ref: 'main', sha: 'c'.repeat(40) } }), exitCode: 0 };
    if (joined === 'api --method GET user') return { stdout: JSON.stringify({ id: 7, type: 'User' }), exitCode: 0 };
    if (joined.includes('/pulls ')) return { stdout: JSON.stringify([[{ number: 3, head: { sha }, base: { ref: 'main', sha: 'c'.repeat(40) } }]]), exitCode: 0 };
    if (joined.includes('/deployment-branch-policies')) return { stdout: JSON.stringify([{ branch_policies: [{ type: 'tag', name: 'raibit-gate-a-*' }] }]), exitCode: 0 };
    if (joined.includes('/environments/raibit-production-evidence')) return { stdout: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }), exitCode: 0 };
    if (joined.includes('/rulesets?')) return { stdout: JSON.stringify([{ id: 9 }, { id: 10 }]), exitCode: 0 };
    if (joined.includes('/rulesets/9')) return { stdout: JSON.stringify({ target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'], exclude: [] } }, rules: [{ type: 'creation' }], bypass_actors: [{ actor_id: 7, actor_type: 'User', bypass_mode: 'always' }] }), exitCode: 0 };
    if (joined.includes('/rulesets/10')) return { stdout: JSON.stringify({ target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'], exclude: [] } }, rules: [{ type: 'update' }, { type: 'deletion' }], bypass_actors: [] }), exitCode: 0 };
    if (joined.includes('/contents/')) return { stdout: JSON.stringify({ sha: blobSha }), exitCode: 0 };
    if (joined.includes('/actions/workflows/production-evidence.yml') && !joined.includes('/runs')) return { stdout: JSON.stringify({ id: 99, path: '.github/workflows/production-evidence.yml' }), exitCode: 0 };
    if (joined.includes('/git/ref/tags/')) return { stdout: '', exitCode: 1 };
    if (joined.includes('/actions/workflows/production-evidence.yml/runs')) return { stdout: JSON.stringify([{ workflow_runs: [{ id: 42, workflow_id: 99, head_sha: sha, path: '.github/workflows/production-evidence.yml', repository: { full_name: execution.repository }, display_title: `Gate A | ${tag}`, run_attempt: 1, created_at: '2026-09-06T00:00:01.000Z' }] }]), exitCode: 0 };
    if (file === 'gh' && args[0] === 'run' && args[1] === 'watch') return { stdout: '', exitCode: 1 };
    if (joined.includes('/actions/runs/42/jobs')) return { stdout: JSON.stringify([{ jobs: [
      { name: 'Secret-free release identity preflight', conclusion: 'failure', run_id: 42, head_sha: sha },
      { name: 'Protected credentialed evidence', conclusion: 'skipped', run_id: 42, head_sha: sha }] }]), exitCode: 0 };
    if (joined.endsWith('/actions/runs/42')) return { stdout: JSON.stringify({ id: 42, head_sha: sha,
      path: '.github/workflows/production-evidence.yml', repository: { full_name: execution.repository },
      display_title: `Gate A | ${tag}`, workflow_id: 99, run_attempt: 1, created_at: '2026-09-06T00:00:01.000Z', event: 'push' }), exitCode: 0 };
    if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
      const output = args[args.indexOf('-D') + 1]; await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'ci-invocation.json'), JSON.stringify(invocation));
      await writeFile(path.join(output, 'preflight.json'), JSON.stringify({ status: 'NOT_RUN', reason: 'missing_secret_ref', testOnly: true, releaseEligible: false, ciInvocationSha256: digest(invocation) }));
      await writeFile(path.join(output, 'cleanup.json'), JSON.stringify({ status: 'PASS', resourcesCreated: 0, resourcesRemaining: 0, ciInvocationSha256: digest(invocation) }));
      return { stdout: '', exitCode: 0 };
    }
    throw new Error(`unexpected command: ${file} ${joined}`);
  };
  // When the exact negative run exits nonzero.
  const result = await runGateA(['--repo', execution.repository, '--scenario', 'missing-secret', '--attempt-dir', attemptDir],
    { run, root: parent, uuid: () => nonce, now: () => new Date('2026-09-06T00:00:00.000Z'), sleep: async () => {}, verifyApprovedSnapshot: async () => ({}) });
  // Then final metadata and artifact download occurred, without eligible release output.
  assert.equal(result.releaseEligible, false);
  assert.ok(calls.some((call) => call.join(' ').includes('/actions/runs/42')));
  assert.ok(calls.some((call) => call.slice(0, 3).join(' ') === 'gh run download'));
  assert.ok(calls.filter(([file, command]) => file === 'gh' && command === 'api').every((call) => call.includes('--method') && call.includes('GET')));
});

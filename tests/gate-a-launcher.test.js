import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCiExecutionContext, parseCiInvocation, parseReleaseTag } from '../scripts/production-evidence/lib/ci-invocation.mjs';
import { runMissingSigningFixture } from '../scripts/production-evidence/preflight.mjs';
import { runGateA, validateReleasePolicy } from '../scripts/run-gate-a.mjs';

const sha = 'a'.repeat(40), blobSha = 'b'.repeat(40), nonce = '123e4567-e89b-42d3-a456-426614174000';
const tag = `raibit-gate-a-${sha}-missing-secret-${nonce}`;
const execution = { repository: 'jsk1004ha/RaibitServer', ref: `refs/tags/${tag}`, sourceCommitSha: sha, runId: '42', runAttempt: 1,
  workflowRef: `jsk1004ha/RaibitServer/.github/workflows/production-evidence.yml@refs/tags/${tag}`, workflowSha: sha, event: 'push' };
const invocation = { schema: 'raibitserver.ci-invocation/v1', repository: execution.repository, ref: execution.ref, tag, nonce,
  candidateSha: sha, workflowId: '.github/workflows/production-evidence.yml', blobSha, runId: '42', runAttempt: 1,
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

test('Given selected tag policy, When creation is not bound to the actor, Then launch fails closed', () => {
  // Given the environment tag rule but no authorized ruleset bypass.
  const environment = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const policies = [{ type: 'tag', name: 'raibit-gate-a-*' }];
  const rulesets = [{ target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'] } },
    rules: ['creation', 'update', 'deletion'].map((type) => ({ type })), bypass_actors: [] }];
  // When the authenticated actor is bound, Then absence of authorization blocks before push.
  assert.throws(() => validateReleasePolicy({ environment, policies, rulesets, actorId: 7 }), /tag_ruleset_mismatch/);
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
    if (joined === 'api repos/jsk1004ha/RaibitServer') return { stdout: JSON.stringify({ default_branch: 'main' }), exitCode: 0 };
    if (joined === 'api repos/jsk1004ha/RaibitServer/pulls/3') return { stdout: JSON.stringify({ state: 'open', head: { sha }, base: { ref: 'main', sha: 'c'.repeat(40) } }), exitCode: 0 };
    if (joined === 'api user') return { stdout: JSON.stringify({ id: 7 }), exitCode: 0 };
    if (joined.includes('/pulls ')) return { stdout: JSON.stringify([[{ number: 3, head: { sha }, base: { ref: 'main', sha: 'c'.repeat(40) } }]]), exitCode: 0 };
    if (joined.includes('/deployment-branch-policies')) return { stdout: JSON.stringify([{ branch_policies: [{ type: 'tag', name: 'raibit-gate-a-*' }] }]), exitCode: 0 };
    if (joined.includes('/environments/raibit-production-evidence')) return { stdout: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }), exitCode: 0 };
    if (joined.includes('/rulesets?')) return { stdout: JSON.stringify([{ id: 9 }]), exitCode: 0 };
    if (joined.includes('/rulesets/9')) return { stdout: JSON.stringify({ target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/raibit-gate-a-*'] } }, rules: ['creation', 'update', 'deletion'].map((type) => ({ type })), bypass_actors: [{ actor_id: 7, bypass_mode: 'always' }] }), exitCode: 0 };
    if (joined.includes('/contents/')) return { stdout: JSON.stringify({ sha: blobSha }), exitCode: 0 };
    if (joined.includes('/git/ref/tags/')) return { stdout: '', exitCode: 1 };
    if (joined.includes('/actions/workflows/production-evidence.yml/runs')) return { stdout: JSON.stringify([{ workflow_runs: [{ id: 42, head_sha: sha, path: '.github/workflows/production-evidence.yml', repository: { full_name: execution.repository }, display_title: `Gate A | ${tag}`, run_attempt: 1, created_at: '2026-09-06T00:00:01.000Z' }] }]), exitCode: 0 };
    if (file === 'gh' && args[0] === 'run' && args[1] === 'watch') return { stdout: '', exitCode: 1 };
    if (joined.includes('/actions/runs/42')) return { stdout: JSON.stringify({ id: 42, head_sha: sha,
      path: '.github/workflows/production-evidence.yml', repository: { full_name: execution.repository },
      display_title: `Gate A | ${tag}`, run_attempt: 1 }), exitCode: 0 };
    if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
      const output = args[args.indexOf('-D') + 1]; await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'ci-invocation.json'), JSON.stringify(invocation));
      await writeFile(path.join(output, 'preflight.json'), JSON.stringify({ status: 'NOT_RUN', reason: 'missing_secret_ref', testOnly: true, releaseEligible: false }));
      await writeFile(path.join(output, 'cleanup.json'), JSON.stringify({ status: 'PASS', resourcesCreated: 0, resourcesRemaining: 0 }));
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
});

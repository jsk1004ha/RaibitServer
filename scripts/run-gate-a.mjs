#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCiInvocation, parseReleaseTag } from './production-evidence/lib/ci-invocation.mjs';
import { APPROVED_INPUT_SHA256, digest, EvidenceError, OPERATOR_CONTRACT_DIGEST, verifyApprovedSnapshot } from './production-evidence/lib/operator-inputs.mjs';

const execFileAsync = promisify(execFile);
const WORKFLOW = '.github/workflows/production-evidence.yml';
const UPSTREAM = 'jsk1004ha/RaibitServer';
const fail = (reason) => { throw new EvidenceError(reason); };
const json = (result, reason) => { try { return JSON.parse(result.stdout); } catch { fail(reason); } };

export function parseGateAArguments(args) {
  const accepted = new Set(['--repo', '--scenario', '--attempt-dir']), values = new Map();
  if (args.length !== 6) fail('invalid_arguments');
  for (let index = 0; index < args.length; index += 2) {
    if (!accepted.has(args[index]) || values.has(args[index])) fail('invalid_arguments');
    values.set(args[index], args[index + 1]);
  }
  if (values.get('--repo') !== UPSTREAM || !['happy', 'missing-secret'].includes(values.get('--scenario'))
    || !path.isAbsolute(values.get('--attempt-dir'))) fail('invalid_arguments');
  return Object.freeze({ repo: UPSTREAM, scenario: values.get('--scenario'), attemptDir: path.resolve(values.get('--attempt-dir')) });
}

export function validateReleasePolicy({ environment, policies, rulesets, actor }) {
  if (environment?.deployment_branch_policy?.protected_branches !== false
    || environment.deployment_branch_policy.custom_branch_policies !== true
    || policies.length !== 1 || policies[0].type !== 'tag' || policies[0].name !== 'raibit-gate-a-*') fail('environment_policy_mismatch');
  const applicable = rulesets.filter((item) => item.target === 'tag' && item.enforcement === 'active'
    && item.conditions?.ref_name?.include?.some((pattern) => ['~ALL', 'refs/tags/*', 'refs/tags/raibit-gate-a-*'].includes(pattern))
    && (item.conditions.ref_name.exclude === undefined
      || (Array.isArray(item.conditions.ref_name.exclude) && item.conditions.ref_name.exclude.length === 0)));
  const actorBypass = (item) => item.bypass_actors?.filter((entry) => entry.actor_type === 'User'
    && entry.actor_id === actor.id && entry.bypass_mode === 'always') ?? [];
  const creation = applicable.filter((item) => item.rules?.some(({ type }) => type === 'creation'));
  const mutation = applicable.filter((item) => item.rules?.some(({ type }) => ['update', 'deletion'].includes(type)));
  const immutableTypes = new Set(mutation.filter((item) => item.bypass_actors?.length === 0)
    .flatMap((item) => item.rules.map(({ type }) => type)));
  if (actor?.type !== 'User' || creation.length !== 1 || actorBypass(creation[0]).length !== 1
    || creation[0].bypass_actors?.length !== 1 || creation[0].rules.some(({ type }) => ['update', 'deletion'].includes(type))
    || !immutableTypes.has('update') || !immutableTypes.has('deletion')
    || mutation.some((item) => item.bypass_actors?.length !== 0)) fail('tag_ruleset_mismatch');
}

function commandAdapter() {
  return async (file, args, options = {}) => {
    try {
      const result = await execFileAsync(file, args, { cwd: options.cwd, encoding: 'utf8', timeout: options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: Number.isInteger(error.code) ? error.code : 1 };
      if (!options.allowFailure) fail(options.reason ?? 'command_failed');
      return result;
    }
  };
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) { const found = await findFile(candidate, name); if (found) return found; }
    else if (entry.name === name) return candidate;
  }
  return null;
}

async function ghJson(run, args, reason) { return json(await run('gh', args, { reason }), reason); }

export async function runGateA(args, dependencies = {}) {
  const input = parseGateAArguments(args), run = dependencies.run ?? commandAdapter(), now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID, sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const verifyApproval = dependencies.verifyApprovedSnapshot ?? verifyApprovedSnapshot;
  const root = dependencies.root ?? path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const status = await run('git', ['status', '--porcelain=v1'], { cwd: root, reason: 'dirty_candidate' });
  if (status.stdout.trim()) fail('dirty_candidate');
  const candidateSha = (await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, reason: 'candidate_unavailable' })).stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(candidateSha)) fail('candidate_unavailable');
  await verifyApproval(path.join(path.dirname(input.attemptDir), 'inputs', 'approved-draft-input-v1.md'));
  const repository = await ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}`], 'repository_unavailable');
  const actor = await ghJson(run, ['api', '--method', 'GET', 'user'], 'release_identity_unavailable');
  const pulls = await ghJson(run, ['api', '--method', 'GET', '--paginate', '--slurp', `repos/${input.repo}/pulls`, '-f', 'state=open', '-f', 'per_page=100'], 'pull_request_unavailable');
  const flattenedPulls = pulls.flat(), matches = flattenedPulls.filter((item) => item.head?.sha?.toLowerCase() === candidateSha && item.base?.ref === repository.default_branch);
  if (matches.length !== 1) fail('candidate_pull_request_mismatch');
  const pull = matches[0], environment = await ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}/environments/raibit-production-evidence`], 'environment_policy_unavailable');
  const policyPages = await ghJson(run, ['api', '--method', 'GET', '--paginate', '--slurp', `repos/${input.repo}/environments/raibit-production-evidence/deployment-branch-policies`, '-f', 'per_page=100'], 'environment_policy_unavailable');
  const rulesetPages = await ghJson(run, ['api', '--method', 'GET', '--paginate', '--slurp', `repos/${input.repo}/rulesets`,
    '-f', 'includes_parents=true', '-f', 'per_page=100'], 'tag_ruleset_unavailable');
  const rulesets = await Promise.all(rulesetPages.flat().map((item) => ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}/rulesets/${item.id}`], 'tag_ruleset_unavailable')));
  validateReleasePolicy({ environment, policies: policyPages.flatMap((page) => page.branch_policies ?? page), rulesets, actor });
  const workflow = await ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}/contents/${WORKFLOW}?ref=${candidateSha}`], 'workflow_unavailable');
  if (!/^[a-f0-9]{40}$/.test(workflow.sha)) fail('workflow_unavailable');
  const nonce = uuid().toLowerCase(), tag = `raibit-gate-a-${candidateSha}-${input.scenario}-${nonce}`;
  parseReleaseTag(tag);
  if ((await run('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: root, allowFailure: true })).exitCode === 0) fail('tag_collision');
  if ((await run('gh', ['api', '--method', 'GET', `repos/${input.repo}/git/ref/tags/${tag}`], { allowFailure: true })).exitCode === 0) fail('tag_collision');
  await mkdir(input.attemptDir, { recursive: false, mode: 0o700 });
  const dispatchStartedAt = now().toISOString();
  await run('git', ['push', `https://github.com/${input.repo}.git`, `${candidateSha}:refs/tags/${tag}`], { cwd: root, reason: 'tag_push_failed' });
  let selected = null;
  for (let attempt = 0; attempt < 21 && !selected; attempt += 1) {
    const pages = await ghJson(run, ['api', '--method', 'GET', '--paginate', '--slurp', `repos/${input.repo}/actions/workflows/production-evidence.yml/runs`,
      '-f', 'event=push', '-f', `head_sha=${candidateSha}`, '-f', `created=>=${dispatchStartedAt}`, '-f', 'per_page=100'], 'run_discovery_failed');
    const matchesForRun = pages.flatMap((page) => page.workflow_runs ?? page).filter((item) => item.head_sha?.toLowerCase() === candidateSha
      && item.path === WORKFLOW && item.repository?.full_name === input.repo && item.display_title === `Gate A | ${tag}`
      && Number.isSafeInteger(item.workflow_id) && item.workflow_id > 0
      && item.run_attempt === 1 && Date.parse(item.created_at) >= Date.parse(dispatchStartedAt));
    if (matchesForRun.length > 1) fail('ambiguous_workflow_run');
    selected = matchesForRun[0] ?? null;
    if (!selected && attempt < 20) await sleep(15_000);
  }
  if (!selected || !Number.isSafeInteger(selected.id)) fail('run_discovery_timeout');
  const expectedInvocation = parseCiInvocation({ schema: 'raibitserver.ci-invocation/v1', repository: input.repo,
    ref: `refs/tags/${tag}`, tag, nonce, candidateSha, workflowId: selected.workflow_id, workflowPath: WORKFLOW,
    blobSha: workflow.sha, runId: String(selected.id), runAttempt: 1, event: 'push', createdAt: selected.created_at,
    execution: { repository: input.repo, ref: `refs/tags/${tag}`, sourceCommitSha: candidateSha,
      runId: String(selected.id), runAttempt: 1, workflowRef: `${input.repo}/${WORKFLOW}@refs/tags/${tag}`,
      workflowSha: candidateSha, event: 'push' } });
  const expectedInvocationPath = path.join(input.attemptDir, 'expected-ci-invocation.json');
  await writeFile(expectedInvocationPath, `${JSON.stringify(expectedInvocation)}\n`, { flag: 'wx', mode: 0o600 });
  const downloadDir = path.join(input.attemptDir, 'task-28-workflow');
  let watch, metadata;
  try {
    const remainingMs = 4 * 60 * 60_000 - (now().getTime() - Date.parse(dispatchStartedAt));
    if (remainingMs <= 0) fail('run_timeout');
    watch = await run('gh', ['run', 'watch', String(selected.id), '--repo', input.repo, '--exit-status'], { allowFailure: true, timeoutMs: remainingMs });
  } finally {
    try { metadata = await ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}/actions/runs/${selected.id}`], 'run_metadata_unavailable'); }
    finally { await run('gh', ['run', 'download', String(selected.id), '--repo', input.repo, '-n', 'production-evidence', '-D', downloadDir], { reason: 'evidence_download_failed' }); }
  }
  if (metadata.id !== selected.id || metadata.head_sha?.toLowerCase() !== candidateSha || metadata.path !== WORKFLOW
    || metadata.repository?.full_name !== input.repo || metadata.display_title !== `Gate A | ${tag}` || metadata.run_attempt !== 1
    || metadata.workflow_id !== selected.workflow_id || metadata.created_at !== selected.created_at || metadata.event !== 'push') fail('ci_identity_mismatch');
  const invocationPath = await findFile(downloadDir, 'ci-invocation.json');
  if (!invocationPath) fail('missing_ci_invocation');
  const invocation = parseCiInvocation(JSON.parse(await readFile(invocationPath, 'utf8')));
  if (digest(invocation) !== digest(expectedInvocation)) fail('ci_identity_mismatch');
  let releaseEligible = false, reason = null;
  if (input.scenario === 'happy') {
    const manifest = await findFile(downloadDir, 'manifest.json');
    if (!manifest || watch.exitCode !== 0) fail('gate_a_failed');
    await run(process.execPath, [path.join(root, 'scripts/verify-production-evidence.mjs'), '--expected-ci', expectedInvocationPath, manifest], { cwd: root, reason: 'gate_a_verification_failed' });
    releaseEligible = true;
  } else {
    const negative = await findFile(downloadDir, 'preflight.json'), cleanup = await findFile(downloadDir, 'cleanup.json');
    if (!negative || !cleanup) fail('missing_negative_evidence');
    const jobPages = await ghJson(run, ['api', '--method', 'GET', '--paginate', '--slurp',
      `repos/${input.repo}/actions/runs/${selected.id}/jobs`, '-f', 'filter=latest', '-f', 'per_page=100'], 'run_jobs_unavailable');
    const jobs = jobPages.flatMap((page) => page.jobs ?? page), preflightJob = jobs.filter(({ name }) => name === 'Secret-free release identity preflight');
    const liveJob = jobs.filter(({ name }) => name === 'Protected credentialed evidence');
    const result = JSON.parse(await readFile(negative, 'utf8')), cleaned = JSON.parse(await readFile(cleanup, 'utf8'));
    if (watch.exitCode === 0 || result.status !== 'NOT_RUN' || result.reason !== 'missing_secret_ref' || result.testOnly !== true
      || result.releaseEligible !== false || result.ciInvocationSha256 !== digest(expectedInvocation)
      || cleaned.status !== 'PASS' || cleaned.resourcesCreated !== 0 || cleaned.resourcesRemaining !== 0
      || cleaned.ciInvocationSha256 !== digest(expectedInvocation)
      || preflightJob.length !== 1 || preflightJob[0].conclusion !== 'failure'
      || liveJob.length !== 1 || liveJob[0].conclusion !== 'skipped'
      || [...preflightJob, ...liveJob].some((job) => job.run_id !== selected.id || job.head_sha?.toLowerCase() !== candidateSha)) fail('negative_evidence_mismatch');
    reason = 'missing_secret_ref';
  }
  const currentRepository = await ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}`], 'repository_unavailable');
  const currentPull = await ghJson(run, ['api', '--method', 'GET', `repos/${input.repo}/pulls/${pull.number}`], 'pull_request_unavailable');
  if (currentRepository.default_branch !== repository.default_branch || currentPull.state !== 'open'
    || currentPull.head?.sha?.toLowerCase() !== candidateSha || currentPull.base?.ref !== repository.default_branch
    || currentPull.base?.sha !== pull.base.sha) fail('candidate_pull_request_changed');
  const receipt = { schema: 'raibitserver.gate-a-launch/v1', repository: input.repo, scenario: input.scenario,
    candidateSha, tag, nonce, dispatchStartedAt, pullRequest: { number: pull.number, baseSha: pull.base.sha, headSha: pull.head.sha },
    workflowBlobSha: workflow.sha, runId: String(selected.id), runAttempt: 1, approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST, releaseEligible, reason };
  await writeFile(path.join(input.attemptDir, 'launcher-receipt.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
  return Object.freeze(receipt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const result = await runGateA(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.releaseEligible ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'gate_a_io_failed'}\n`);
  process.exitCode = 1;
}

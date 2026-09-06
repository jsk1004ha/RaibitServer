import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvidenceError, readJson } from './operator-inputs.mjs';

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW = '.github/workflows/production-evidence.yml';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (reason = 'ci_identity_mismatch') => { throw new EvidenceError(reason); };

export function parseReleaseTag(value) {
  if (typeof value !== 'string') fail('invalid_release_tag');
  let match = /^raibit-gate-a-([a-f0-9]{40})-(happy|missing-secret)-([0-9a-f-]+)$/i.exec(value);
  if (match && UUID.test(match[3])) return Object.freeze({ gate: 'A', profile: 'train-a', candidateSha: match[1].toLowerCase(), scenario: match[2], nonce: match[3].toLowerCase() });
  match = /^raibit-gate-b-([a-f0-9]{40})-([0-9a-f-]+)$/i.exec(value);
  if (match && UUID.test(match[2])) return Object.freeze({ gate: 'B', profile: 'final', candidateSha: match[1].toLowerCase(), scenario: 'happy', nonce: match[2].toLowerCase() });
  fail('invalid_release_tag');
}

export function parseCiExecutionContext(value) {
  const keys = ['repository', 'ref', 'sourceCommitSha', 'runId', 'runAttempt', 'workflowRef', 'workflowSha', 'event'];
  if (!exact(value, keys) || !REPOSITORY.test(value.repository) || !/^refs\/tags\/raibit-gate-[ab]-/.test(value.ref)
    || !SHA.test(value.sourceCommitSha) || !RUN_ID.test(value.runId) || value.runAttempt !== 1
    || value.workflowRef !== `${value.repository}/${WORKFLOW}@${value.ref}`
    || !SHA.test(value.workflowSha) || value.event !== 'push') fail();
  const release = parseReleaseTag(value.ref.slice('refs/tags/'.length));
  if (release.candidateSha !== value.sourceCommitSha || value.workflowSha !== value.sourceCommitSha) fail();
  return Object.freeze({ ...value });
}

export async function readCiExecutionContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || !path.isAbsolute(eventPath)) fail();
  const payload = await readJson(eventPath, 'ci_identity_mismatch');
  const context = parseCiExecutionContext({ repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF,
    sourceCommitSha: process.env.GITHUB_SHA?.toLowerCase(), runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), workflowRef: process.env.GITHUB_WORKFLOW_REF,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA?.toLowerCase(), event: process.env.GITHUB_EVENT_NAME });
  if (payload.after?.toLowerCase() !== context.sourceCommitSha) fail();
  return context;
}

export function parseCiInvocation(value) {
  const keys = ['schema', 'repository', 'ref', 'tag', 'nonce', 'candidateSha', 'workflowId', 'blobSha', 'runId', 'runAttempt', 'event', 'createdAt', 'execution'];
  if (!exact(value, keys) || value.schema !== 'raibitserver.ci-invocation/v1' || value.workflowId !== WORKFLOW
    || !SHA.test(value.candidateSha) || !SHA.test(value.blobSha) || !RUN_ID.test(value.runId)
    || value.runAttempt !== 1 || value.event !== 'push' || Number.isNaN(Date.parse(value.createdAt))) fail();
  const execution = parseCiExecutionContext(value.execution), release = parseReleaseTag(value.tag);
  if (value.repository !== execution.repository || value.ref !== execution.ref || value.tag !== execution.ref.slice(10)
    || value.nonce !== release.nonce || value.candidateSha !== release.candidateSha
    || value.candidateSha !== execution.sourceCommitSha || value.runId !== execution.runId
    || value.runAttempt !== execution.runAttempt || value.event !== execution.event) fail();
  return Object.freeze({ ...value, execution });
}

export async function createCiInvocation({ workflowId = WORKFLOW, blobSha, createdAt, defaultBranchSha = null } = {}) {
  const execution = await readCiExecutionContext(), tag = execution.ref.slice(10), release = parseReleaseTag(tag);
  if (!SHA.test(blobSha) || typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) fail();
  if (release.gate === 'B' && defaultBranchSha?.toLowerCase() !== release.candidateSha) fail('final_source_not_default_head');
  return parseCiInvocation({ schema: 'raibitserver.ci-invocation/v1', repository: execution.repository, ref: execution.ref,
    tag, nonce: release.nonce, candidateSha: release.candidateSha, workflowId, blobSha: blobSha.toLowerCase(),
    runId: execution.runId, runAttempt: execution.runAttempt, event: execution.event, createdAt, execution });
}

async function cli(args) {
  const accepted = new Set(['--write', '--blob-sha', '--created-at', '--default-branch-sha']), values = new Map();
  if (args.length % 2 !== 0) fail('invalid_arguments');
  for (let index = 0; index < args.length; index += 2) {
    if (!accepted.has(args[index]) || values.has(args[index])) fail('invalid_arguments');
    values.set(args[index], args[index + 1]);
  }
  const output = values.get('--write');
  if (!output || !path.isAbsolute(output)) fail('invalid_arguments');
  const invocation = await createCiInvocation({ blobSha: values.get('--blob-sha'), createdAt: values.get('--created-at'), defaultBranchSha: values.get('--default-branch-sha') ?? null });
  await writeFile(output, `${JSON.stringify(invocation)}\n`, { flag: 'wx', mode: 0o600 });
  return invocation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  process.stdout.write(`${JSON.stringify(await cli(process.argv.slice(2)))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'evidence_io_failed'}\n`);
  process.exitCode = 1;
}

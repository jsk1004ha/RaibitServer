import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertDistinctFinalEvidence, verifyEvidenceFile } from '../scripts/verify-production-evidence.mjs';

const manifest = (runId, sourceCommitSha = 'a'.repeat(40)) => ({ profile: 'final', fixture: false, identity: { runId, sourceCommitSha } });
const result = manifestDigest => ({ valid: true, releaseEligible: true, reason: 'eligible', manifestDigest });
const bytes = Buffer.from('{"accepted":true}\n');

test('distinct final evidence accepts a fresh run at the exact accepted source without changing accepted bytes', () => {
  const value = assertDistinctFinalEvidence({ candidateManifest: manifest('candidate'), acceptedManifest: manifest('accepted'),
    candidateResult: result('b'.repeat(64)), acceptedResult: result('c'.repeat(64)), acceptedBefore: bytes, acceptedAfter: Buffer.from(bytes) });
  assert.deepEqual(value, { valid: true, releaseEligible: true, reason: 'eligible', manifestDigest: 'b'.repeat(64), distinctFromManifestDigest: 'c'.repeat(64) });
});

for (const [name, mutation, reason] of [
  ['reused run', value => { value.candidateManifest = value.acceptedManifest; }, 'reused_evidence_run'],
  ['reused manifest digest', value => { value.candidateResult = value.acceptedResult; }, 'reused_evidence_run'],
  ['mixed source SHA', value => { value.candidateManifest = manifest('candidate', 'd'.repeat(40)); }, 'final_source_mismatch'],
  ['modified accepted input', value => { value.acceptedAfter = Buffer.from('{"accepted":false}\n'); }, 'accepted_evidence_mutated'],
]) test(`distinct final evidence rejects ${name}`, () => {
  const value = { candidateManifest: manifest('candidate'), acceptedManifest: manifest('accepted'),
    candidateResult: result('b'.repeat(64)), acceptedResult: result('c'.repeat(64)), acceptedBefore: bytes, acceptedAfter: Buffer.from(bytes) };
  mutation(value);
  assert.throws(() => assertDistinctFinalEvidence(value), { reason });
});

test('distinct final evidence CLI rejects ambiguous accepted-CI and non-final profile combinations before file I/O', () => {
  const cli = (...args) => spawnSync(process.execPath, ['scripts/verify-production-evidence.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8' });
  for (const args of [['missing.json', '--accepted-ci', 'accepted.json'],
    ['missing.json', '--distinct-from', 'accepted.json', '--profile', 'train-a']]) {
    const value = cli(...args);
    assert.equal(value.status, 1);
    assert.equal(value.stdout, '');
    assert.equal(value.stderr.trim(), 'invalid_arguments');
  }
});

test('distinct final evidence CLI rejects one rich CI invocation reused for both signed runs', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'raibit-distinct-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sha = 'a'.repeat(40), nonce = '11111111-1111-4111-8111-111111111111';
  const tag = `raibit-gate-b-${sha}-${nonce}`, ref = `refs/tags/${tag}`, repository = 'jsk1004ha/RaibitServer';
  const execution = { repository, ref, sourceCommitSha: sha, runId: '7', runAttempt: 1,
    workflowRef: `${repository}/.github/workflows/production-evidence.yml@${ref}`, workflowSha: sha, event: 'push' };
  const invocation = { schema: 'raibitserver.ci-invocation/v1', repository, ref, tag, nonce, candidateSha: sha,
    workflowId: 42, workflowPath: '.github/workflows/production-evidence.yml', blobSha: 'b'.repeat(40), runId: '7', runAttempt: 1,
    event: 'push', createdAt: '2026-09-06T00:00:00.000Z', execution };
  const receipt = path.join(directory, 'ci.json');
  await writeFile(receipt, JSON.stringify(invocation));
  const value = spawnSync(process.execPath, ['scripts/verify-production-evidence.mjs', 'candidate.json', '--distinct-from', 'accepted.json',
    '--expected-ci', receipt, '--accepted-ci', receipt], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(value.status, 1);
  assert.equal(value.stdout, '');
  assert.equal(value.stderr.trim(), 'reused_ci_invocation');
});

test('public evidence verifier rejects caller-supplied durable proof objects before file I/O', async () => {
  await assert.rejects(verifyEvidenceFile('missing.json', { durableReceiptProof: {} }), { reason: 'invalid_arguments' });
});

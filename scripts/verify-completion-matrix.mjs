#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseCatalog, parseCompletionAttempt, parseTaskReceipt } from './completion-matrix-contract.mjs';
import { verifyEvidenceFile } from './verify-production-evidence.mjs';
import { verifyArtifacts } from './production-evidence/lib/run.mjs';
import { assertFresh } from './production-evidence/lib/manifest.mjs';
import { EvidenceError, assertRedacted, digest, loadOperatorContract, verifyApprovedSnapshot } from './production-evidence/lib/operator-inputs.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(SOURCE, 'docs/platform-expansion-completion.json');
const execute = promisify(execFile);
const git = async (args) => (await execute('git', args, { cwd: SOURCE, shell: false, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
function json(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new EvidenceError('completion_invalid_schema'); throw error; }
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function physical(file) {
  const target = path.resolve(file);
  if (await realpath(target) !== target || !(await lstat(target)).isFile()) throw new EvidenceError('invalid_artifact');
  const bytes = await readFile(target);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new EvidenceError('invalid_artifact');
  return bytes;
}
export async function verifyCatalogReferences(value) {
  const catalog = parseCatalog(value);
  const files = [...new Set(catalog.tasks.flatMap(({ code, tests }) => [...code, ...tests]))];
  for (const file of files) {
    try {
      await physical(path.join(SOURCE, file));
      const [actual, committed] = await Promise.all([git(['hash-object', `--path=${file}`, file]), git(['rev-parse', `HEAD:${file}`])]);
      if (actual.trim() !== committed.trim()) throw new EvidenceError('completion_reference_drift');
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError('completion_missing_reference');
    }
  }
  return { catalog, pending: catalog.tasks.filter(({ pending }) => pending.length).map(({ id, pending }) => ({ id, reasons: pending })) };
}
async function fingerprint() {
  const [head, tree, status, staged, unstaged] = await Promise.all([
    git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD^{tree}']), git(['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    git(['diff', '--cached', '--binary']), git(['diff', '--binary']),
  ]);
  if (status || staged || unstaged) throw new EvidenceError('completion_source_dirty');
  return { head: head.trim(), tree: tree.trim(), sha256: digest([head, tree, status, staged, unstaged]) };
}
async function checkedArtifact(root, artifact) {
  const file = path.resolve(root, artifact.path);
  if (!within(root, file) || file === root) throw new EvidenceError('invalid_artifact');
  const bytes = await physical(file);
  if (digest(bytes) !== artifact.sha256) throw new EvidenceError('artifact_digest_mismatch');
  assertRedacted(bytes.toString('utf8'));
  if (/"fixture"\s*:\s*true/.test(bytes.toString('utf8'))) throw new EvidenceError('fixture_not_release_evidence');
  return bytes;
}
export function assertCatalogDigest(matrix, bytes) {
  if (digest(bytes) !== matrix.catalogSha256) throw new EvidenceError('completion_catalog_digest_mismatch');
}
export async function verifyCompletionGate(root, reference, role) {
  if (!['gate-a', 'gate-b', 'domains'].includes(role)) throw new EvidenceError('completion_gate_profile_mismatch');
  const before = await checkedArtifact(root, reference.artifact);
  const manifest = json(before);
  if (digest(manifest.identity) !== digest(reference.identity) || digest(manifest) !== reference.manifestDigest) throw new EvidenceError('completion_gate_digest_mismatch');
  const profile = role === 'gate-a' ? 'train-a' : role === 'gate-b' ? 'final' : 'component';
  if (manifest.profile !== profile || manifest.fixture) throw new EvidenceError('completion_gate_profile_mismatch');
  if (role === 'gate-b') assertFresh(manifest.startedAt, manifest.observedAt);
  const ciBytes = role === 'domains' ? null : await checkedArtifact(root, reference.ciExecution);
  let expectedCi;
  if (ciBytes) {
    let ciParser;
    try { ciParser = (await import('./production-evidence/lib/ci-invocation.mjs')).parseCiExecutionContext; }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new EvidenceError('completion_ci_authority_unavailable');
      throw error;
    }
    expectedCi = ciParser(json(ciBytes));
    if (expectedCi.sourceCommitSha !== reference.identity.sourceCommitSha) throw new EvidenceError('completion_mixed_sha');
  }
  const options = { profile, expectedIdentity: reference.identity, expectedCi, ...(role === 'domains' ? { fragment: 'domains' } : {}),
    ...(role === 'gate-b' ? {} : { now: Date.parse(manifest.observedAt) }) };
  const result = await verifyEvidenceFile(path.resolve(root, reference.artifact.path), options);
  if (!result.valid || result.manifestDigest !== reference.manifestDigest || (role !== 'domains' && !result.releaseEligible)) throw new EvidenceError('completion_gate_not_eligible');
  if (digest(await checkedArtifact(root, reference.artifact)) !== digest(before)) throw new EvidenceError('completion_input_changed');
  if (ciBytes && digest(await checkedArtifact(root, reference.ciExecution)) !== digest(ciBytes)) throw new EvidenceError('completion_input_changed');
  return result;
}
async function ancestry(matrix) {
  for (const [index, slice] of matrix.prSlices.entries()) {
    const pairs = [[slice.baseCommitSha, slice.headCommitSha], [slice.headCommitSha, slice.mergedCommitSha],
      ...(index ? [[matrix.prSlices[index - 1].mergedCommitSha, slice.baseCommitSha]] : [])];
    for (const pair of pairs) {
      try { await git(['merge-base', '--is-ancestor', ...pair]); }
      catch { throw new EvidenceError('completion_pr_ancestry_mismatch'); }
    }
  }
}
export async function verifyCompletionFile(file, options = {}) {
  await loadOperatorContract();
  const bytes = await physical(file);
  const value = json(bytes);
  const matrix = options.catalog ? null : parseCompletionAttempt(value, options);
  if (options.catalog && digest(value) !== digest(json(await git(['show', 'HEAD:docs/platform-expansion-completion.json'])))) throw new EvidenceError('completion_catalog_digest_mismatch');
  const before = options.catalog ? null : await fingerprint();
  const catalogBytes = options.catalog ? bytes : await physical(CATALOG);
  const references = await verifyCatalogReferences(json(catalogBytes));
  if (references.pending.length) return { valid: false, releaseEligible: false, reason: 'completion_pending_references', pending: references.pending };
  if (options.catalog) return { valid: true, releaseEligible: false, reason: 'capability_references_only', taskCount: 50, components: references.catalog.components };
  const root = await realpath(path.dirname(path.resolve(file)));
  if (within(SOURCE, root)) throw new EvidenceError('completion_attempt_must_be_external');
  await verifyApprovedSnapshot(path.join(root, 'inputs/approved-draft-input-v1.md'));
  assertCatalogDigest(matrix, catalogBytes);
  if (before.head !== matrix.sourceCommitSha || before.tree !== matrix.sourceTreeSha) throw new EvidenceError('completion_mixed_sha');
  await ancestry(matrix);
  for (const slice of matrix.prSlices) await checkedArtifact(root, slice.artifact);
  for (const row of matrix.tasks) {
    const receipt = parseTaskReceipt(json(await checkedArtifact(root, row.receipt)), {
      taskId: row.id, sourceCommitSha: matrix.sourceCommitSha, sourceTreeSha: matrix.sourceTreeSha,
    });
    const requiredGate = [14, 16, 17, 18, 19, 24, 25, 27, 28].includes(row.id) ? matrix.gateA
      : row.id === 47 ? matrix.domainEvidence : row.id === 51 ? matrix.gateB : null;
    if (requiredGate && !receipt.artifacts.some((artifact) => digest(artifact) === digest(requiredGate.artifact))) throw new EvidenceError('completion_receipt_gate_mismatch');
    await verifyArtifacts(root, { fragments: [{ artifacts: receipt.artifacts }], fixture: false });
    await checkedArtifact(root, row.receipt);
  }
  await verifyCompletionGate(root, matrix.gateA, 'gate-a');
  await verifyCompletionGate(root, matrix.domainEvidence, 'domains');
  if (matrix.gateB) await verifyCompletionGate(root, matrix.gateB, 'gate-b');
  for (const reference of [matrix.gateA, matrix.domainEvidence, ...(matrix.gateB ? [matrix.gateB] : [])]) {
    await checkedArtifact(root, reference.artifact);
    if (reference.ciExecution) await checkedArtifact(root, reference.ciExecution);
  }
  if (digest(await physical(file)) !== digest(bytes) || digest(await physical(CATALOG)) !== digest(catalogBytes)
    || (await fingerprint()).sha256 !== before.sha256) throw new EvidenceError('completion_input_changed');
  await verifyApprovedSnapshot(path.join(root, 'inputs/approved-draft-input-v1.md'));
  return { valid: true, releaseEligible: Boolean(options.final), reason: options.final ? 'final_gate_verified' : 'gate_b_required',
    taskCount: matrix.tasks.length, sourceCommitSha: matrix.sourceCommitSha, matrixDigest: digest(bytes) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const args = process.argv.slice(2);
  const options = { final: args.includes('--final'), catalog: args.includes('--catalog') };
  if ((options.final && options.catalog) || args.filter((value) => value === '--final').length > 1 || args.filter((value) => value === '--catalog').length > 1) throw new EvidenceError('invalid_arguments');
  const files = args.filter((value) => !['--final', '--catalog'].includes(value));
  if (files.length !== 1 || files[0].startsWith('--')) throw new EvidenceError('invalid_arguments');
  const result = await verifyCompletionFile(path.resolve(files[0]), options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof EvidenceError ? error.reason : 'completion_io_failed'}\n`);
  process.exitCode = 1;
}

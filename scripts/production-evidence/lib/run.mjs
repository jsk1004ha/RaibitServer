import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceIdentitySchema, EvidenceFragmentSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { EvidenceError, digest, assertRedacted, readJson } from './operator-inputs.mjs';
import { assertFresh } from './manifest.mjs';
import { parseStepReceipt, stepNamesForIdentity } from './step-contract.mjs';
export { createRunnerContext } from './runner-context.mjs';

export async function createRun(parent, identity, startedAt = new Date().toISOString()) {
  const parsed = EvidenceIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new EvidenceError('invalid_schema');
  assertFresh(startedAt, startedAt);
  const root = await realpath(parent);
  const directory = path.join(root, parsed.data.runId);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new EvidenceError('reused_directory');
    throw error;
  }
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: parsed.data, startedAt }), { flag: 'wx', mode: 0o600 });
  return directory;
}
export async function checkRun(directory, manifest, now = Date.now()) {
  const receipt = await readJson(path.join(directory, 'run.json'), 'missing_run');
  if (receipt.schema !== 'raibitserver.evidence-run/v1' || digest(receipt.identity) !== digest(manifest.identity) || receipt.startedAt !== manifest.startedAt || path.basename(directory) !== manifest.identity.runId) throw new EvidenceError('identity_mismatch');
  assertFresh(receipt.startedAt, manifest.observedAt, now);
}
export async function writeFragment(directory, value) {
  assertRedacted(value);
  const parsed = EvidenceFragmentSchema.safeParse(value);
  if (!parsed.success) throw new EvidenceError('invalid_schema');
  const receipt = await readJson(path.join(directory, 'run.json'), 'missing_run');
  await checkRun(directory, { identity: parsed.data.identity, startedAt: receipt.startedAt, observedAt: parsed.data.observedAt });
  try { await writeFile(path.join(directory, `${parsed.data.component}.json`), JSON.stringify(parsed.data), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new EvidenceError('reused_fragment');
    throw error;
  }
}
export async function verifyArtifacts(directory, manifest) {
  const root = await realpath(directory);
  for (const artifact of manifest.fragments.flatMap(({ artifacts }) => artifacts)) {
    const target = path.resolve(root, artifact.path);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new EvidenceError('invalid_artifact');
    let resolved;
    try { resolved = await realpath(target); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new EvidenceError('missing_artifact');
      throw error;
    }
    if (resolved !== target || !(await lstat(target)).isFile()) throw new EvidenceError('invalid_artifact');
    const bytes = await readFile(target);
    if (!bytes.length || digest(bytes) !== artifact.sha256) throw new EvidenceError('artifact_digest_mismatch');
    assertRedacted(bytes.toString('utf8'));
    if (!manifest.fixture && /"fixture"\s*:\s*true/.test(bytes.toString('utf8'))) throw new EvidenceError('fixture_not_release_evidence');
  }
}

async function physicalArtifact(root, relative) {
  const target = path.resolve(root, relative);
  const within = path.relative(root, target);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new EvidenceError('invalid_artifact');
  let resolved;
  try { resolved = await realpath(target); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new EvidenceError('missing_artifact');
    throw error;
  }
  if (resolved !== target || !(await lstat(target)).isFile()) throw new EvidenceError('invalid_artifact');
  const bytes = await readFile(target);
  if (!bytes.length) throw new EvidenceError('missing_artifact');
  assertRedacted(bytes.toString('utf8'));
  try { return { value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) }; }
  catch (error) { if (error instanceof SyntaxError) throw new EvidenceError('invalid_schema'); throw error; }
}

export async function verifyFragmentFiles(directory, manifest) {
  const root = await realpath(directory);
  for (const fragment of manifest.fragments) {
    const physical = await physicalArtifact(root, `${fragment.component}.json`);
    if (digest(physical.value) !== digest(fragment) || digest(physical.value.identity) !== digest(manifest.identity)) throw new EvidenceError('identity_mismatch');
  }
}

function verifyCleanupReceipt(value, expected, manifest) {
  const common = ['schema', ...(expected.component ? ['component'] : []), 'identity', 'startedAt', 'observedAt', 'status', 'reason', 'assertions', 'redacted', 'fixture'];
  if (!value || Object.keys(value).length !== common.length || common.some((key) => !Object.hasOwn(value, key))
    || value.schema !== expected.schema || (expected.component && value.component !== expected.component)
    || digest(value.identity) !== digest(manifest.identity) || value.status !== 'PASS' || value.reason !== null
    || value.redacted !== true || value.fixture !== manifest.fixture || !Array.isArray(value.assertions) || value.assertions.length !== 1
    || Object.keys(value.assertions[0]).length !== 2 || value.assertions[0].id !== expected.assertion || value.assertions[0].status !== 'PASS') throw new EvidenceError('cleanup_failed');
  assertFresh(value.startedAt, value.observedAt);
  if (Date.parse(value.startedAt) < Date.parse(manifest.startedAt) || Date.parse(value.observedAt) > Date.parse(manifest.observedAt)) throw new EvidenceError('stale_state');
}

export async function verifyRunReceipts(directory, manifest, now = Date.now()) {
  const root = await realpath(directory);
  const manifestArtifacts = new Map(manifest.fragments.flatMap(({ artifacts }) => artifacts.map((artifact) => [artifact.path, artifact.sha256])));
  const returnedArtifacts = new Set();
  for (const step of stepNamesForIdentity(manifest.identity)) {
    const component = ['resources', 'backup-sql', 'backup-nosql'].includes(step) ? 'resources'
      : step === 'rollback' ? 'operations' : step === 'domains' ? 'domains' : step === 'cleanup' ? 'cleanup' : 'lifecycle';
    const relative = step === 'cleanup' ? 'cleanup/cleanup.json' : `artifacts/${component}/${step}.json`;
    let physical;
    try { physical = await physicalArtifact(root, relative); }
    catch (error) {
      if (error instanceof SyntaxError) throw new EvidenceError('invalid_step_contract');
      throw error;
    }
    const receipt = parseStepReceipt(physical.value);
    if (receipt.step !== step || digest(receipt.identity) !== digest(manifest.identity) || receipt.fixture !== manifest.fixture) throw new EvidenceError('identity_mismatch');
    assertFresh(receipt.startedAt, receipt.observedAt, now);
    if (Date.parse(receipt.startedAt) < Date.parse(manifest.startedAt) || Date.parse(receipt.observedAt) > Date.parse(manifest.observedAt)) throw new EvidenceError('stale_state');
    if (!manifest.fixture && (receipt.status !== 'PASS' || receipt.assertions.some(({ status }) => status !== 'PASS'))) throw new EvidenceError(receipt.status === 'NOT_RUN' ? 'not_run' : 'assertion_failed');
    if (manifestArtifacts.get(relative) !== physical.sha256) throw new EvidenceError('artifact_digest_mismatch');
    for (const artifact of receipt.artifacts) {
      if (returnedArtifacts.has(artifact.path)) throw new EvidenceError('reused_artifact');
      returnedArtifacts.add(artifact.path);
      if (manifestArtifacts.get(artifact.path) !== artifact.sha256) throw new EvidenceError('artifact_digest_mismatch');
    }
  }
  for (const component of ['local', 'cluster', 'lifecycle', 'resources', 'operations', ...(manifest.profile === 'final' ? ['domains'] : [])]) {
    const relative = `cleanup/${component}.json`;
    const physical = await physicalArtifact(root, relative);
    verifyCleanupReceipt(physical.value, { schema: 'raibitserver.production-evidence-component-cleanup/v1', component, assertion: 'component_cleanup' }, manifest);
    if (manifestArtifacts.get(relative) !== physical.sha256) throw new EvidenceError('cleanup_failed');
  }
  const run = await physicalArtifact(root, 'cleanup/run.json');
  verifyCleanupReceipt(run.value, { schema: 'raibitserver.production-evidence-run-cleanup/v1', assertion: 'run_cleanup' }, manifest);
  if (manifestArtifacts.get('cleanup/run.json') !== run.sha256) throw new EvidenceError('cleanup_failed');
}

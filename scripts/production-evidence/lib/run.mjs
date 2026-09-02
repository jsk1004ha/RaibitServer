import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceIdentitySchema, EvidenceFragmentSchema } from '../../../packages/schemas/src/production-evidence.ts';
import { EvidenceError, digest, assertRedacted, readJson } from './operator-inputs.mjs';
import { assertFresh } from './manifest.mjs';

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
export async function checkRun(directory, manifest) {
  const receipt = await readJson(path.join(directory, 'run.json'), 'missing_run');
  if (receipt.schema !== 'raibitserver.evidence-run/v1' || digest(receipt.identity) !== digest(manifest.identity) || receipt.startedAt !== manifest.startedAt || path.basename(directory) !== manifest.identity.runId) throw new EvidenceError('identity_mismatch');
  assertFresh(receipt.startedAt, manifest.observedAt);
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

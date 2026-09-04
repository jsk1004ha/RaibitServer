import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSafeArtifactWriter } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';

async function sandbox(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'raibit-artifact-writer-'));
  const run = path.join(parent, 'run');
  await mkdir(run, { mode: 0o700 });
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return { parent, runDirectory: await realpath(run) };
}

test('Given an approved path, When JSON is written, Then one immutable redacted artifact is created', async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);
  const writer = await createSafeArtifactWriter({ runDirectory, allowedPaths: ['artifacts/lifecycle/runtime.json'] });

  // When
  const descriptor = await writer.writeJson('artifacts/lifecycle/runtime.json', { schema: 'test/v1', status: 'PASS', redacted: true });

  // Then
  assert.deepEqual(Object.keys(descriptor).sort(), ['path', 'redacted', 'sha256']);
  assert.equal(descriptor.path, 'artifacts/lifecycle/runtime.json');
  assert.equal(descriptor.redacted, true);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(runDirectory, ...descriptor.path.split('/')), 'utf8'), '{"schema":"test/v1","status":"PASS","redacted":true}\n');
  if (process.platform !== 'win32') assert.equal((await lstat(path.join(runDirectory, ...descriptor.path.split('/')))).mode & 0o777, 0o600);
  await assert.rejects(writer.writeJson(descriptor.path, { redacted: true }), { reason: 'reused_artifact' });
});

test('Given traversal, device, ADS, or unapproved paths, When writing, Then every path is rejected', async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);
  const writer = await createSafeArtifactWriter({ runDirectory, allowedPaths: () => true });
  const invalidPaths = ['../escape.json', 'artifacts\\escape.json', '/absolute.json', 'artifacts/./x.json', 'artifacts/a:b.json', 'artifacts/nul.json', 'artifacts/file.', 'artifacts//x.json'];

  // When / Then
  for (const artifactPath of invalidPaths) await assert.rejects(writer.writeJson(artifactPath, { redacted: true }), { reason: 'invalid_artifact' });
  await assert.rejects(
    (await createSafeArtifactWriter({ runDirectory, allowedPaths: ['artifacts/approved.json'] })).writeJson('artifacts/other.json', { redacted: true }),
    { reason: 'invalid_artifact' },
  );
});

test('Given a link in the artifact ancestry, When writing, Then the link escape is rejected', async (t) => {
  // Given
  const { parent, runDirectory } = await sandbox(t);
  const outside = path.join(parent, 'outside');
  await mkdir(outside);
  await mkdir(path.join(runDirectory, 'artifacts'));
  await symlink(outside, path.join(runDirectory, 'artifacts', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const writer = await createSafeArtifactWriter({ runDirectory, allowedPaths: ['artifacts/linked/escape.json'] });

  // When / Then
  await assert.rejects(writer.writeJson('artifacts/linked/escape.json', { redacted: true }), { reason: 'invalid_artifact' });
  await assert.rejects(readFile(path.join(outside, 'escape.json')), { code: 'ENOENT' });
});

test('Given a link at the final artifact path, When writing, Then it is rejected as an escape', async (t) => {
  // Given
  const { parent, runDirectory } = await sandbox(t);
  const outside = path.join(parent, process.platform === 'win32' ? 'outside-dir' : 'outside.json');
  if (process.platform === 'win32') await mkdir(outside);
  else await writeFile(outside, '{"outside":true}\n');
  await mkdir(path.join(runDirectory, 'artifacts'));
  await symlink(outside, path.join(runDirectory, 'artifacts', 'linked.json'), process.platform === 'win32' ? 'junction' : 'file');
  const writer = await createSafeArtifactWriter({ runDirectory, allowedPaths: ['artifacts/linked.json'] });

  // When / Then
  await assert.rejects(writer.writeJson('artifacts/linked.json', { redacted: true }), { reason: 'invalid_artifact' });
  if (process.platform !== 'win32') assert.equal(await readFile(outside, 'utf8'), '{"outside":true}\n');
});

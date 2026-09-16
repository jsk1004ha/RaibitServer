import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createSafeArtifactWriter, createUnsafeFixtureArtifactWriter, isPrivateArtifactWriterMetadata, PRIVATE_WRITER_SESSION_PATH } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';

const execFileAsync = promisify(execFile);

async function sandbox(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'raibit-artifact-writer-'));
  const run = path.join(parent, 'run');
  await mkdir(run, { mode: 0o700 });
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return { parent, runDirectory: await realpath(run) };
}

async function fixtureWriter(t, options) {
  const writer = await createUnsafeFixtureArtifactWriter(options);
  t.after(async () => { await writer.close(); });
  return writer;
}

test('Given an approved path, When JSON is written, Then one immutable redacted artifact is created', async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);
  const writer = await fixtureWriter(t, { runDirectory, allowedPaths: ['artifacts/lifecycle/runtime.json'] });

  // When
  const descriptor = await writer.writeJson('artifacts/lifecycle/runtime.json', { schema: 'test/v1', status: 'PASS', redacted: true });

  // Then
  assert.deepEqual(Object.keys(descriptor).sort(), ['path', 'redacted', 'sha256']);
  assert.equal(descriptor.path, 'artifacts/lifecycle/runtime.json');
  assert.equal(descriptor.redacted, true);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
  const written = await readFile(path.join(runDirectory, ...descriptor.path.split('/')));
  assert.equal(written.toString('utf8'), '{"schema":"test/v1","status":"PASS","redacted":true}\n');
  assert.equal(descriptor.sha256, createHash('sha256').update(written).digest('hex'));
  assert.equal(await readFile(path.join(runDirectory, PRIVATE_WRITER_SESSION_PATH), 'utf8'), '{"schema":"raibitserver.production-evidence-writer-session/v1","privateMetadata":true,"redacted":true}\n');
  assert.equal(isPrivateArtifactWriterMetadata(PRIVATE_WRITER_SESSION_PATH), true);
  assert.equal(isPrivateArtifactWriterMetadata(descriptor.path), false);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path.join(runDirectory, ...descriptor.path.split('/')))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.join(runDirectory, PRIVATE_WRITER_SESSION_PATH))).mode & 0o777, 0o600);
  }
  await assert.rejects(writer.writeJson(descriptor.path, { redacted: true }), { reason: 'reused_artifact' });
  await assert.rejects(createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: ['artifacts/other.json'] }), { reason: 'run_already_opened' });
});

test('Given traversal, device, ADS, or unapproved paths, When writing, Then every path is rejected', async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);
  const writer = await fixtureWriter(t, { runDirectory, allowedPaths: (value) => value === 'artifacts/approved.json' });
  const invalidPaths = ['../escape.json', 'artifacts\\escape.json', '/absolute.json', 'artifacts/./x.json', 'artifacts/a:b.json', 'artifacts/nul.json', 'artifacts/file.', 'artifacts//x.json'];

  // When / Then
  for (const artifactPath of invalidPaths) await assert.rejects(writer.writeJson(artifactPath, { redacted: true }), { reason: 'invalid_artifact' });
  await assert.rejects(writer.writeJson('artifacts/other.json', { redacted: true }), { reason: 'invalid_artifact' });
});

test('Given a link in the artifact ancestry, When writing, Then the link escape is rejected', async (t) => {
  // Given
  const { parent, runDirectory } = await sandbox(t);
  const outside = path.join(parent, 'outside');
  await mkdir(outside);
  await mkdir(path.join(runDirectory, 'artifacts'));
  await symlink(outside, path.join(runDirectory, 'artifacts', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const writer = await fixtureWriter(t, { runDirectory, allowedPaths: ['artifacts/linked/escape.json'] });

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
  const writer = await fixtureWriter(t, { runDirectory, allowedPaths: ['artifacts/linked.json'] });

  // When / Then
  await assert.rejects(writer.writeJson('artifacts/linked.json', { redacted: true }), { reason: 'invalid_artifact' });
  if (process.platform !== 'win32') assert.equal(await readFile(outside, 'utf8'), '{"outside":true}\n');
});

test('Given stat, write, sync, or close failure, When retrying the failed path, Then the run stays poisoned and O_EXCL blocks reuse', async (t) => {
  // Given
  for (const stage of ['stat', 'write', 'sync', 'close']) {
    const { runDirectory } = await sandbox(t);
    const artifactPath = `artifacts/lifecycle/${stage}.json`;
    const testHooks = stage === 'stat' ? { stat: async () => { throw new Error('injected_stat_failure'); } }
      : stage === 'write' ? { write: async () => { throw new Error('injected_write_failure'); } }
      : stage === 'sync' ? { sync: async () => { throw new Error('injected_sync_failure'); } }
        : { close: async (handle) => { await handle.close(); throw new Error('injected_close_failure'); } };
    const failing = await fixtureWriter(t, { runDirectory, allowedPaths: [artifactPath], testHooks });

    // When
    await assert.rejects(failing.writeJson(artifactPath, { stage, redacted: true }), { reason: 'artifact_write_failed' });
    await assert.rejects(failing.writeJson(artifactPath, { stage, redacted: true }), { reason: 'artifact_write_failed' });
    await failing.close();

    // Then
    await assert.rejects(createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: [`artifacts/lifecycle/${stage}-other.json`] }), { reason: 'run_already_opened' });
    assert.equal((await lstat(path.join(runDirectory, ...artifactPath.split('/')))).isFile(), true);
    await assert.rejects(readFile(path.join(runDirectory, 'artifacts', 'lifecycle', `${stage}-other.json`)), { code: 'ENOENT' });
  }
});

test('Given a parent swap between validation and open, When writing, Then it is rejected without unlinking the raced file', async (t) => {
  // Given
  const { parent: sandboxRoot, runDirectory } = await sandbox(t);
  const outside = path.join(sandboxRoot, 'outside');
  await mkdir(outside);
  const writer = await fixtureWriter(t, {
    runDirectory,
    allowedPaths: ['artifacts/lifecycle/runtime.json'],
    testHooks: { beforeOpen: async ({ parent }) => {
      await rename(parent, `${parent}-displaced`);
      await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    } },
  });

  // When / Then
  await assert.rejects(writer.writeJson('artifacts/lifecycle/runtime.json', { redacted: true }), { reason: 'invalid_artifact' });
  assert.equal((await readFile(path.join(outside, 'runtime.json'))).length, 0);
  await assert.rejects(writer.writeJson('artifacts/lifecycle/runtime.json', { redacted: true }), { reason: 'artifact_write_failed' });
});

test('Given a hardlink added after exclusive open, When writing, Then link-count validation rejects before bytes are written', async (t) => {
  // Given
  const { parent, runDirectory } = await sandbox(t);
  const outside = path.join(parent, 'outside-hardlink.json');
  const writer = await fixtureWriter(t, {
    runDirectory,
    allowedPaths: ['artifacts/runtime.json'],
    testHooks: { afterOpen: async ({ target }) => { await link(target, outside); } },
  });

  // When / Then
  await assert.rejects(writer.writeJson('artifacts/runtime.json', { redacted: true }), { reason: 'invalid_artifact' });
  assert.equal((await readFile(outside)).length, 0);
  assert.equal((await readFile(path.join(runDirectory, 'artifacts', 'runtime.json'))).length, 0);
});

test('Given final-path substitution after open, When validation fails, Then neither replacement nor opened inode is pathname-unlinked', async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);
  const writer = await fixtureWriter(t, {
    runDirectory,
    allowedPaths: ['artifacts/runtime.json'],
    testHooks: {
      afterOpen: async ({ target }) => {
        await rename(target, `${target}.partial`);
        await writeFile(target, '{"adversary":true}\n');
      },
    },
  });

  // When / Then
  await assert.rejects(writer.writeJson('artifacts/runtime.json', { redacted: true }), { reason: 'invalid_artifact' });
  assert.equal(await readFile(path.join(runDirectory, 'artifacts', 'runtime.json'), 'utf8'), '{"adversary":true}\n');
  assert.equal((await readFile(path.join(runDirectory, 'artifacts', 'runtime.json.partial'))).length, 0);
  await assert.rejects(createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: ['artifacts/other.json'] }), { reason: 'run_already_opened' });
  await assert.rejects(readFile(path.join(runDirectory, 'artifacts', 'other.json')), { code: 'ENOENT' });
});

test('Given Windows without a portable no-reparse ACL guarantee, When creating a release writer, Then it fails closed', { skip: process.platform !== 'win32' }, async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);

  // When / Then
  await assert.rejects(createSafeArtifactWriter({ runDirectory, allowedPaths: ['artifacts/runtime.json'] }), { reason: 'artifact_platform_not_release_safe' });
});

test('Given a successful write and closed session, When same-process and child-process writers target different paths, Then the durable marker blocks both', async (t) => {
  // Given
  const { runDirectory } = await sandbox(t);
  const writer = await fixtureWriter(t, { runDirectory, allowedPaths: ['artifacts/complete.json'] });
  await writer.writeJson('artifacts/complete.json', { status: 'PASS', redacted: true });
  await writer.close();

  // When
  const sameProcess = assert.rejects(
    createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: ['artifacts/restarted.json'] }),
    { reason: 'run_already_opened' },
  );
  const moduleUrl = new URL('../scripts/production-evidence/lib/safe-artifact-writer.mjs', import.meta.url).href;
  const childScript = `import { createUnsafeFixtureArtifactWriter } from ${JSON.stringify(moduleUrl)};
try {
  await createUnsafeFixtureArtifactWriter({ runDirectory: ${JSON.stringify(runDirectory)}, allowedPaths: ['artifacts/restarted-child.json'] });
  process.stdout.write('unexpected_success'); process.exitCode = 2;
} catch (error) {
  process.stdout.write(error?.reason ?? 'unknown');
  if (error?.reason !== 'run_already_opened') process.exitCode = 3;
}`;
  const child = await execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], { timeout: 5_000, windowsHide: true });

  // Then
  await sameProcess;
  assert.equal(child.stdout, 'run_already_opened');
  await assert.rejects(readFile(path.join(runDirectory, 'artifacts', 'restarted.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(runDirectory, 'artifacts', 'restarted-child.json')), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runCommand } from '../packages/core/src/command-runner.ts';

function nodeCommand(source) {
  return { executable: process.execPath, args: ['-e', source] };
}

test('normal command completion returns exit zero and redacted output', async () => {
  const result = await runCommand(nodeCommand("console.log('success'); console.error('API_TOKEN=example-secret')"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /success/);
  assert.match(result.stderr, /API_TOKEN=\*\*\*\*/);
  assert.doesNotMatch(result.stderr, /example-secret/);
});

test('nonzero exit codes remain failures with command results', async () => {
  await assert.rejects(runCommand(nodeCommand("console.error('failed'); process.exitCode = 7")), (error) => {
    assert.equal(error.result.exitCode, 7);
    assert.equal(error.result.timedOut, false);
    assert.match(error.result.stderr, /failed/);
    return true;
  });
});

test('timeout termination cannot be reported as success', async () => {
  await assert.rejects(runCommand(nodeCommand('setInterval(() => {}, 1000)'), { timeoutMs: 150 }), (error) => {
    assert.equal(error.result.exitCode, 124);
    assert.equal(error.result.timedOut, true);
    assert.match(error.message, /timed out.*150/);
    return true;
  });
});

test('a process exiting zero in response to timeout is still a timeout failure', { skip: process.platform === 'win32' }, async () => {
  const command = nodeCommand("process.on('SIGTERM', () => { console.log('handled timeout'); process.exit(0); }); setInterval(() => {}, 1000);");
  await assert.rejects(runCommand(command, { timeoutMs: 2000 }), (error) => {
    assert.equal(error.result.exitCode, 124);
    assert.equal(error.result.timedOut, true);
    assert.equal(error.result.signal, null);
    assert.match(error.result.stdout, /handled timeout/);
    return true;
  });
});

test('signal termination without a timeout is a failure', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(runCommand(nodeCommand("process.kill(process.pid, 'SIGTERM')")), (error) => {
    assert.notEqual(error.result.exitCode, 0);
    assert.equal(error.result.signal, 'SIGTERM');
    assert.equal(error.result.timedOut, false);
    assert.match(error.message, /SIGTERM/);
    return true;
  });
});

test('spawn errors clear the timeout and preserve the original error', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle);
    return originalClearTimeout(handle);
  };
  try {
    await assert.rejects(runCommand({ executable: `raibit-missing-${randomUUID()}` }, { timeoutMs: 1000 }), { code: 'ENOENT' });
    assert.equal(pending.size, 0);
  } finally {
    for (const handle of pending) originalClearTimeout(handle);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('dry run never spawns a process or records a timeout', async () => {
  const result = await runCommand({ executable: 'does-not-exist' }, { dryRun: true, timeoutMs: 0 });
  assert.equal(result.dryRun, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
});

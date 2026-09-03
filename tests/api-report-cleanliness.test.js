import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Given a clean checkout and no report override, when real Nest parity runs, then it leaves git status clean', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'raibit-parity-'));
  const git = args => spawnSync('git', args, { cwd: sandbox, encoding: 'utf8' });
  try {
    assert.equal(git(['init', '--quiet']).status, 0);
    const before = git(['status', '--porcelain=v1']);
    assert.equal(before.status, 0);
    assert.equal(before.stdout, '');
    const env = { ...process.env };
    delete env.RAIBIT_API_PARITY_REPORT;
    delete env.RAIBIT_API_PARITY_MUTATION;
    delete env.NODE_TEST_CONTEXT;
    const args = ['--test', '--test-name-pattern=Given the running Nest graph', fileURLToPath(new URL('./api-semantic-parity.test.js', import.meta.url))];
    const result = spawnSync(process.execPath, args, { cwd: sandbox, env, encoding: 'utf8', timeout: 30000 });
    const after = git(['status', '--porcelain=v1']);
    if (process.env.RAIBIT_API_PARITY_REPORT) {
      const prefix = process.env.RAIBIT_API_PARITY_REPORT + '.default-report';
      await writeFile(prefix + '.stdout.log', result.stdout || '');
      await writeFile(prefix + '.stderr.log', result.stderr || '');
      await writeFile(prefix + '.metadata.json', JSON.stringify({ command: process.execPath, args, cwd: sandbox, status: result.status, before: before.stdout, after: after.stdout }, null, 2));
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /checked=74; HTTP=41; cleanup=true/, 'the child must execute real Nest parity, not skip nested tests');
    assert.equal(after.status, 0);
    assert.equal(after.stdout, before.stdout, 'default parity reporting must not create checkout files');
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const workspaceStatePath = path.join(root, 'node_modules', '.pnpm-workspace-state-v1.json');

test('Given production dependencies, when Docker packages the CLI, then Node loads validated client operations without TypeScript', () => {
  const workspaceStateBeforeDeploy = existsSync(workspaceStatePath) ? readFileSync(workspaceStatePath) : null;
  assert.ok(existsSync(path.join(root, 'scripts/build-cli-runtime.mjs')), 'CLI production packaging must compile the runtime schema dependency graph');
  const evidence = process.env.RAIBITSERVER_CLI_PACKAGING_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const sandbox = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'raibit-cli-')));
  const logs = evidence ? path.join(evidence, path.basename(sandbox)) : sandbox;
  mkdirSync(logs, { recursive: true });
  const deployed = path.join(sandbox, 'cli');
  function run(name, command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180_000, ...options });
    writeFileSync(path.join(logs, `${name}.metadata.json`), JSON.stringify({ command, args, cwd: options.cwd || root, status: result.status, signal: result.signal, error: result.error?.message }, null, 2) + '\n');
    writeFileSync(path.join(logs, `${name}.stdout.log`), result.stdout || '');
    writeFileSync(path.join(logs, `${name}.stderr.log`), result.stderr || '');
    assert.equal(result.status, 0, `${name}: ${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  try {
    const pnpmScript = process.env.RAIBITSERVER_PNPM_CLI || process.env.npm_execpath;
    const deployArgs = ['--filter', '@raibitserver/cli', 'deploy', '--legacy', '--prod', path.relative(root, deployed)];
    if (pnpmScript?.includes('pnpm')) run('deploy', process.execPath, [pnpmScript, ...deployArgs]);
    else run('deploy', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', deployArgs, { shell: process.platform === 'win32' });
    run('build', process.execPath, ['scripts/build-cli-runtime.mjs', deployed]);
    const probe = `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { once } from 'node:events';
      import { RAIBITSERVERClient } from '@raibitserver/api-client';
      import { apiOperations } from '@raibitserver/schemas';
      const client = new RAIBITSERVERClient({ baseUrl: 'http://127.0.0.1:1' });
      assert.equal(typeof client.operations.health, 'function');
      assert.equal(typeof client.listProjects, 'function');
      assert.throws(() => apiOperations.health.response.parse({ status: false }));
      await assert.rejects(client.operations['projects-get']({ path: { projectId: 42 }, query: {}, body: {} }), error => error.name === 'ZodError');
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: false }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const httpClient = new RAIBITSERVERClient({ baseUrl: 'http://127.0.0.1:' + server.address().port });
        await assert.rejects(httpClient.operations.health({ path: {}, query: {}, body: {} }), error => error.name === 'ZodError');
      } finally {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
      }
      console.log(JSON.stringify({ imported: true, legacyWrapper: true, invalidResponseRejected: true, invalidRequestRejected: true, httpResponseRejected: true, listenerClosed: true }));
    `;
    const observed = JSON.parse(run('runtime-import', process.execPath, ['--input-type=module', '-e', probe], { cwd: deployed }));
    assert.equal(observed.invalidRequestRejected, true);
    const help = run('cli-help', process.execPath, ['dist/index.js', '--help'], { cwd: deployed });
    assert.match(help, /RAIBITSERVER/);
    const dockerfile = readFileSync(path.join(root, 'apps/cli/Dockerfile'), 'utf8');
    assert.match(dockerfile, /RUN node scripts\/build-cli-runtime\.mjs \/opt\/raibitserver\/cli/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    if (workspaceStateBeforeDeploy === null) rmSync(workspaceStatePath, { force: true });
    else writeFileSync(workspaceStatePath, workspaceStateBeforeDeploy);
  }
  assert.deepEqual(
    existsSync(workspaceStatePath) ? readFileSync(workspaceStatePath) : null,
    workspaceStateBeforeDeploy,
    'CLI production deploy must restore root pnpm workspace state before later scripts run',
  );
});

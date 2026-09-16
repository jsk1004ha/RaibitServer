import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function hasCommand(command) {
  return spawnSync(command, ['version'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

test('Go builder worker contract is executable when Go exists or statically present otherwise', async (t) => {
  if (hasCommand('go')) {
    const result = spawnSync('go', ['test', './...'], { cwd: 'services/builder', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return;
  }

  const [main, worker, store, postgresStore, errorSpec] = await Promise.all([
    fs.readFile('services/builder/cmd/builder/main.go', 'utf8'),
    fs.readFile('services/builder/internal/worker/builder.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/store.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/postgres_store.go', 'utf8'),
    fs.readFile('services/builder/internal/controlplane/error_spec.go', 'utf8'),
  ]);
  assert.match(main, /StateFileFromEnv/);
  assert.match(main, /PostgresDSNFromEnv/);
  assert.match(store, /ClaimNextWorkflowJob/);
  assert.match(store, /AppendBuildLog/);
  assert.match(postgresStore, /FOR UPDATE SKIP LOCKED/);
  assert.match(postgresStore, /RAIBITSERVER_CONTROL_PLANE_DATABASE_URL/);
  assert.match(postgresStore, /AppendDeploymentEvent/);
  assert.match(worker, /git.*clone/s);
  assert.match(worker, /docker.*buildx.*build/s);
  assert.match(worker, /DeploymentStatusImageReady/);
  assert.match(worker, /DeploymentStatusBuildFailed/);
  assert.match(worker, /errorCode/);
  assert.match(worker, /errorMessage/);
  assert.match(worker, /ErrorCodeBuildFailed/);
  assert.match(worker, /ErrorSpecForFailure/);
  assert.match(store, /lastErrorSpec/);
  assert.match(postgresStore, /lastErrorSpec/);
  assert.match(errorSpec, /ErrorCodeImagePullBackoff/);
  assert.match(errorSpec, /ErrorCodeKubernetesReconcileFailed/);
  assert.match(errorSpec, /UserMessage/);
  assert.match(worker, /imageDigest/);
  assert.match(worker, /generated Dockerfile/);
  assert.match(worker, /credentialed git URLs are not allowed/);
});

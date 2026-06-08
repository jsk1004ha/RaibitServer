import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

test('CI dry-run CLI smoke commands return stable PaaS and DBaaS artifacts', async () => {
  const validation = await runCli(['validate', 'examples/project.json']);
  assert.equal(validation.ok, true);
  assert.equal(validation.serviceFindings.some((finding) => finding.service === 'web'), true);

  const manifest = await runCli(['manifest', 'examples/project.json']);
  assert.equal(manifest.kind, 'ProjectDeploymentPlan');
  assert.equal(manifest.manifests.some((resource) => resource.kind === 'Deployment'), true);
  assert.equal(manifest.resourcePlans.some((resource) => resource.catalogKey === 'postgresql' && resource.operator === 'CloudNativePG'), true);

  const compose = await runCli(['compose', 'examples/docker-compose.yml']);
  assert.deepEqual(compose.resources.map((resource) => resource.engine).sort(), ['object-storage', 'postgresql', 'redis']);
  assert.equal(compose.services.some((service) => service.name === 'worker' && service.type === 'worker'), true);

  const provisioning = await runCli(['provision-plan', 'examples/project.json']);
  assert.equal(provisioning.manifests.some((resource) => resource.kind === 'ManagedDatabase'), true);
  assert.equal(JSON.stringify(provisioning).includes('festival_app:secret'), false);

  const apply = await runCli(['k8s-apply', 'examples/project.json']);
  assert.equal(apply.apply.dryRun, true);
  assert.match(apply.apply.command, /^kubectl apply --server-side -f /);
  assert.equal(apply.compiled.manifests.some((resource) => resource.kind === 'Ingress'), true);

  const readOnlyQuery = await runCli(['guard-query', 'SELECT', '1']);
  assert.equal(readOnlyQuery.allowed, false);
  assert.match(readOnlyQuery.reason, /db:data:read/);
  assert.equal(readOnlyQuery.readOnly, true);

  const destructiveQuery = await runCli(['guard-query', 'DROP']);
  assert.equal(destructiveQuery.allowed, false);
  assert.equal(destructiveQuery.destructive, true);

  const legacyFile = `SELECT.${process.pid}.sql`;
  await fs.writeFile(new URL(`../${legacyFile}`, import.meta.url), 'DROP TABLE users;');
  try {
    const guardedFile = await runCli(['guard-query', legacyFile]);
    assert.equal(guardedFile.allowed, false);
    assert.equal(guardedFile.destructive, true);
    assert.equal(guardedFile.readOnly, false);
  } finally {
    await fs.rm(new URL(`../${legacyFile}`, import.meta.url), { force: true });
  }
});

test('CI workflow keeps local smoke checks and Prisma validation environment', async () => {
  const ci = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm test',
    'pnpm typecheck',
    'node scripts/check-structure.js',
    'node src/cli.js validate examples/project.json',
    'node src/cli.js manifest examples/project.json',
    'node src/cli.js compose examples/docker-compose.yml',
    'node src/cli.js provision-plan examples/project.json',
    'node src/cli.js k8s-apply examples/project.json',
    'pnpm prisma:validate',
    'pnpm prisma:generate',
    'pnpm e2e:dry',
  ]) {
    assert.match(ci, new RegExp(escapeRegExp(command)));
  }
  assert.match(ci, /DATABASE_URL:\s*postgresql:\/\/raibitserver:raibitserver@localhost:5432\/raibitserver/);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/cli.js', ...args], { cwd: new URL('..', import.meta.url).pathname });
    const stdout = [];
    const stderr = [];
    proc.stdout.on('data', (chunk) => stdout.push(chunk));
    proc.stderr.on('data', (chunk) => stderr.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code) {
        reject(new Error(errorOutput || `cli exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch (error) {
        reject(new Error(`failed to parse CLI JSON for ${args.join(' ')}: ${error.message}\n${errorOutput}`));
      }
    });
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

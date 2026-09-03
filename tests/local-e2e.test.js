import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { RAIBITSERVERClient } from '../packages/api-client/src/index.ts';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { sealSecretValue, unsealSecretValue, maskSecrets } from '../packages/core/src/secrets.ts';
import { RESOURCE_CAPABILITIES } from '../packages/core/src/resource-capabilities.ts';


test('local E2E script verifies approval, quota, logs, preview, and SQLite console', async (t) => {
  const outputDir = process.env.RAIBITSERVER_E2E_OUTPUT_DIR
    ? path.join(path.resolve(process.env.RAIBITSERVER_E2E_OUTPUT_DIR), 'local-e2e-test')
    : path.join(os.tmpdir(), `raibit-H1-local-${randomUUID()}`);
  console.log(`E2E_TEST_OUTPUT ${outputDir}`);
  if (!process.env.RAIBITSERVER_E2E_OUTPUT_DIR) t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const result = await runNode(['scripts/dev-e2e.mjs', '--mode', 'dry'], { RAIBITSERVER_AUTH_JWT_SECRET: 'test-local-e2e-secret-32-bytes', RAIBITSERVER_E2E_OUTPUT_DIR: outputDir });
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outputDir, 'stdout.log'), result.stdout),
    fs.writeFile(path.join(outputDir, 'stderr.log'), result.stderr),
  ]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.deploymentStatus, 'READY');
  assert.equal(parsed.requestedMode, 'dry');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.buildDryRun, true);
  assert.equal(parsed.kubernetesDryRun, true);
  assert.equal(parsed.provisionDryRun, true);
  assert.equal(parsed.checks.some((check) => check.includes('non-club pending blocked')), true);
  const report = JSON.parse(await fs.readFile(path.join(outputDir, 'e2e-report.json'), 'utf8'));
  assert.equal(report.outputDir, outputDir);
  assert.deepEqual(report.cleanup, { workDirRemoved: true, listenersClosed: true });
  await assert.rejects(fs.stat(report.workDir), { code: 'ENOENT' });
  for (const entry of RESOURCE_CAPABILITIES.filter(entry => !['postgresql', 'sqlite'].includes(entry.engine))) {
    const observed = report.betaResourceEvidence.find(row => row.engine === entry.engine);
    assert.ok(observed, entry.engine);
    assert.equal(observed.statusCode, entry.local.provision ? 201 : 400, entry.engine);
    if (entry.local.provision) assert.equal(observed.attachment, 'blocked-until-ready');
    else {
      assert.equal(observed.reasonCode, entry.reasonCode);
      assert.equal(observed.persisted, false);
    }
  }
  assert.match(report.previewDeploymentId, /^dep[-_]/);
  assert.equal(report.checks.includes('SQLite DB console query works'), true);
  assert.equal(report.checks.includes('PostgreSQL provider dry-run and env injection works'), true);
  assert.equal(report.checks.includes('preview cleanup workflow enqueued'), true);
  assert.equal(report.checks.includes('build/Kubernetes/provisioning dry-run artifacts generated'), true);
  assert.equal(report.postgresProviderDryRun, true);
  assert.equal(report.postgresEnvInjected, true);
  assert.equal(report.previewCleanupAction, 'preview-cleanup-enqueued');
  assert.equal(report.liveSetup.clusterEngine, 'dry-run');
  assert.deepEqual(Object.values(report.liveBeta.betaChecklist).filter(Boolean).length, Object.keys(report.liveBeta.betaChecklist).length);
  assert.equal(report.liveBeta.services.some((service) => service.service === 'express-api' && service.imageDigest), true);
  assert.equal(report.liveBeta.services.some((service) => service.service === 'vite-web' && service.imageDigest), true);
  assert.equal(report.liveBeta.services.some((service) => service.service === 'generated-node' && service.imageDigest), true);
  assert.equal(report.liveBeta.services.some((service) => service.service === 'prebuilt-web' && service.imageDigest), true);
  assert.equal(report.liveBeta.httpResults.every((row) => row.statusCode === 200), true);
});

test('api-client matches prototype API project/service/resource contract', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new RAIBITSERVERClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const org = await client.createOrganization({ name: 'Client Org', slug: 'client-org' });
    const project = await client.createProject({ name: 'Client App', slug: 'client-app' }, org.id);
    const service = await client.createService(project.id, { name: 'web', sourceType: 'image', image: 'localhost:5000/client/web:latest' });
    const resource = await client.createResource(project.id, { name: 'data', type: 'database', engine: 'sqlite' });
    assert.equal(service.projectId, project.id);
    assert.equal(resource.projectId, project.id);
    assert.equal((await client.listServices(project.id)).services.length, 1);
  } finally {
    server.close();
  }
});

test('secret helpers encrypt at rest and mask nested primitive values', () => {
  const sealed = sealSecretValue('postgresql://user:secret@db/app', { ENCRYPTION_KEY: 'x'.repeat(32) });
  assert.equal(sealed.sealedValue.includes('postgresql://user:secret@db/app'), false);
  assert.equal(unsealSecretValue(sealed.sealedValue, { ENCRYPTION_KEY: 'x'.repeat(32) }), 'postgresql://user:secret@db/app');
  const masked = maskSecrets({ nested: { token: 123456789, password: 'super-secret' } });
  assert.equal(masked.nested.token, '12****89');
  assert.equal(masked.nested.password, 'su****et');
});

function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ...env } });
    const stdout = [];
    const stderr = [];
    proc.stdout.on('data', (chunk) => stdout.push(chunk));
    proc.stderr.on('data', (chunk) => stderr.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

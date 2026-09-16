import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runProductionEvidence } from '../scripts/production-evidence/lib/orchestrator.mjs';
import { STEP_NAMES } from '../scripts/production-evidence/lib/step-contract.mjs';
import { INPUTS } from './fixtures/receipt-authority-fixture.mjs';
import { createLifecycleTransport, ok, response } from './fixtures/production-evidence/lifecycle-transport.mjs';

test('Actual fixed auth and supply producers commit before runtime NOT_RUN and actual cleanup finally', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-composed-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runId = randomUUID(), calls = [], imageDigest = `sha256:${'2'.repeat(64)}`, tenantSha = '3'.repeat(40);
  let disposed = false, journal;
  const clock = { now: () => new Date() };
  const repository = { id: 'repo-id', fullName: 'fixture/repository', private: true, defaultBranch: 'main' };
  const deployment = { id: 'deployment-a', projectId: 'project-a', serviceId: 'service-a', status: 'READY',
    commitSha: tenantSha, branch: 'main', imageDigest, imageUrl: `registry.example/fixture@${imageDigest}`,
    publicUrl: 'https://app.fixture.example', namespace: 'fixture-run', deploymentName: 'web',
    desiredSpecSnapshot: { livenessPath: '/healthz/live', readinessPath: '/healthz/ready' } };
  const transport = createLifecycleTransport({ calls, control: [
    response(200, { memberships: [{ organizationId: 'org-a' }] }),
    response(200, { installations: [{ installationId: '123', organizationId: 'org-a', integrationId: 'integration-a' }] }),
    response(200, { repositories: [repository] }), response(201, { id: 'project-a' }),
    response(201, { service: { id: 'service-a', githubRepository: repository.fullName, githubRepositoryVisibility: 'private', sourceAccess: 'github-app-private' } }),
    response(200, { repositories: [repository] }), response(202, { id: deployment.id }), response(200, deployment),
    response(200, { events: [{ id: 'event-image-ready', deploymentId: deployment.id, type: 'build.image_ready', metadata: { dryRun: false, imageDigest, image: deployment.imageUrl } }], nextCursor: null }),
    response(200, deployment), response(202, { deletionRequested: true, projectId: 'project-a' }), response(404, {}),
  ], files: [ok(imageDigest), ok({ Results: [] }), ok([{}]), ok('rolled'),
    ok({ metadata: { uid: 'workload-uid', generation: 7, labels: { 'raibitserver.io/project-id': 'project-a',
      'raibitserver.io/service-id': 'service-a', 'raibitserver.io/deployment-id': deployment.id } },
    status: { observedGeneration: 7, readyReplicas: 1, updatedReplicas: 1 },
    spec: { replicas: 1, template: { metadata: { labels: {} }, spec: { containers: [{ image: deployment.imageUrl }] } } } }),
    ok('subjectAltName=DNS:app.fixture.example')], publicHttp: [response(200, {}), response(200, {}),
    (request) => response(200, { nonce: request.body.nonce, readBack: request.body.nonce })] });
  const result = await runProductionEvidence({ profile: 'train-a', scenario: 'happy', faultMatrix: null,
    attemptDir: parent, inputs: INPUTS, executeStep: null, fixture: true, clock, uuid: () => runId,
    testOnly: { bootstrap: async ({ identity, journalAuthority, writer }) => {
      journal = journalAuthority;
      await journal.appendBinding({ role: 'identity', bindingId: 'membership', createdAt: clock.now().toISOString(),
        payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'member-a', userId: 'user-a', role: 'OWNER' } });
      await journal.appendBinding({ role: 'source', bindingId: 'repository', createdAt: clock.now().toISOString(),
        payload: { kind: 'github-repository', installationId: '123', repositoryId: repository.id, repository: repository.fullName, branch: 'main' } });
      return { state: { cleanupInventory: [] }, contextFor: () => ({ ...transport, journalAuthority,
        now: () => clock.now().toISOString(), wait: async () => {}, waitForCleanup: async () => true,
        writeArtifact: (component, name, value) => writer.writeJson(component === 'cleanup' ? `cleanup/${name}` : `artifacts/${component}/${name}`, value),
      }), dispose: async () => { disposed = true; } };
    } },
  });
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'trusted_proxy_observation_unavailable');
  assert.equal(result.verification.releaseEligible, false);
  assert.equal(disposed, true);
  const receipts = await Promise.all(STEP_NAMES.map((step) => readFile(path.join(result.runDirectory, 'receipts', `${String(STEP_NAMES.indexOf(step) + 1).padStart(6, '0')}--${step}.json`), 'utf8').then(JSON.parse)));
  const payloads = await Promise.all(receipts.map((entry) => readFile(path.join(result.runDirectory, entry.receiptPath), 'utf8').then(JSON.parse)));
  assert.deepEqual(payloads.map(({ step }) => step), STEP_NAMES);
  assert.deepEqual(payloads.slice(0, 3).map(({ status }) => status), ['PASS', 'PASS', 'NOT_RUN']);
  assert.ok(payloads.slice(3, -1).every(({ status, reason }) => status === 'NOT_RUN' && reason === 'dependency_failed'));
  assert.ok(payloads.every(({ fixture, requestSha256 }) => fixture === true && /^[a-f0-9]{64}$/.test(requestSha256)));
  assert.equal(payloads.at(-1).status, 'PASS');
  assert.equal(calls.filter(({ kind, request }) => kind === 'control' && request.method === 'DELETE').length, 1);
  assert.equal(calls.at(-1).request.path, '/api/projects/project-a');
  const bindingFiles = JSON.parse(await readFile(path.join(result.runDirectory, 'manifest.json'), 'utf8')).bindingJournal.entryCount;
  assert.equal(bindingFiles, 7);
  assert.equal(existsSync(path.join(result.runDirectory, 'work')), false);
});

test('Public CLI without enablement returns exact NOT_RUN before any attempt I/O', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-public-gate-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const attempt = path.join(parent, 'not-created');
  const environment = { ...process.env }; delete environment.RAIBITSERVER_PRODUCTION_EVIDENCE;
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/production-evidence/lib/public-cli.mjs',
    '--profile', 'train-a', '--scenario', 'happy', '--attempt-dir', attempt], { env: environment, timeout: 10_000 }), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stdout), { status: 'NOT_RUN', releaseEligible: false, reason: 'production_evidence_not_enabled' });
    return true;
  });
  assert.equal(existsSync(attempt), false);
});

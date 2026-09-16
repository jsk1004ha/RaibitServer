import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { createUnsafeFixtureArtifactWriter } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { digest as evidenceDigest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { deriveRunResourceName } from '../scripts/production-evidence/lib/cleanup-intent-journal.mjs';
import { execute as authSource } from '../scripts/production-evidence/steps/auth-source.mjs';
import { execute as supplyChain } from '../scripts/production-evidence/steps/supply-chain.mjs';
import { execute as runtime } from '../scripts/production-evidence/steps/runtime.mjs';
import { execute as observability } from '../scripts/production-evidence/steps/observability.mjs';
import { execute as preview } from '../scripts/production-evidence/steps/preview.mjs';
import { execute as rollback } from '../scripts/production-evidence/steps/rollback.mjs';
import { createLifecycleTransport, ok, response } from './fixtures/production-evidence/lifecycle-transport.mjs';

const sourceSha = 'a'.repeat(40); const tenantSha = '2'.repeat(40); const imageDigest = `sha256:${'b'.repeat(64)}`;
const selectors = Object.freeze({ RAIBITSERVER_RELEASE_KUBE_CONTEXT: 'fixture-context', RAIBITSERVER_RELEASE_NAMESPACE_PREFIX: 'fixture', RAIBITSERVER_RELEASE_BASE_DOMAIN: 'apps.example', RAIBITSERVER_RELEASE_REGISTRY_REPOSITORY: 'registry.example/club/app', RAIBITSERVER_RELEASE_FIXTURE_REPOSITORY: 'club/private-app', RAIBITSERVER_RELEASE_GITHUB_INSTALLATION_ID: '123', RAIBITSERVER_RELEASE_BACKUP_ENDPOINT: 'https://backup.example', RAIBITSERVER_RELEASE_BACKUP_BUCKET: 'fixture-backups' });
const helmRef = (role, binding) => ({ kind: 'helm-existingSecret', role, binding, namespace: 'fixture-system', existingSecret: `${role}-secret`, keys: ['value'] });
const workerRef = (role) => ({ kind: 'worker-secretKeyRef', role, binding: role, namespace: 'fixture-system', secretKeyRef: { name: `${role}-secret`, key: 'value', optional: false } });
const secretRefs = Object.freeze([helmRef('database', 'database'), helmRef('runtime', 'runtimeSecrets'), helmRef('registry', 'builder.registryCredentials'), helmRef('github', 'builder.githubAppCredentials'), helmRef('signing', 'builder.signing'), helmRef('dispatch', 'builder.dispatch'), helmRef('trust-root', 'security.imageVerification.trustRoot'), workerRef('scanner'), workerRef('backup')]);
const execFileAsync = promisify(execFile);

function bindings(level = 'full') {
  const values = [
    ['identity', 'membership', { kind: 'organization-membership', organizationId: 'org', membershipId: 'member', userId: 'user', role: 'OWNER' }],
    ['source', 'repository', { kind: 'github-repository', installationId: '123', repositoryId: '456', repository: 'club/private-app', branch: 'main' }],
  ];
  if (level === 'auth') return values;
  values.push(['project', 'primary', { kind: 'project', projectId: 'project', organizationId: 'org' }], ['service', 'primary', { kind: 'service', serviceId: 'service', projectId: 'project' }]);
  if (level === 'source') return values;
  values.push(
    ['revision', 'candidate', { kind: 'tenant-revision', tenantRevisionId: 'revision-good', purpose: 'candidate', observationId: 'build-event', repositoryId: '456', repository: 'club/private-app', branch: 'main', tenantCommitSha: tenantSha }],
    ['deployment', 'candidate', { kind: 'deployment', role: 'candidate', deploymentId: 'deployment', serviceId: 'service', tenantRevisionId: 'revision-good', tenantCommitSha: tenantSha, repositoryId: '456', repository: 'club/private-app', branch: 'main' }],
  );
  return values;
}

async function scenario(t, { level = 'full', files = [], control = [], publicHttp = [], calls = [], clock } = {}) {
  const identity = Object.freeze({ runId: randomUUID(), environmentFingerprint: 'c'.repeat(64), sourceCommitSha: sourceSha, migrationDigest: 'd'.repeat(64), approvedInputSha256: '0EC3728F53E872561F78D2A4849EBB11C037FF65529439AD5E55DAD49EB9AEE2', operatorContractDigest: 'f'.repeat(64), operatorInputFingerprint: '1'.repeat(64) });
  const parent = await mkdtemp(path.join(os.tmpdir(), 'raibit-lifecycle-')); const runDirectory = path.join(parent, identity.runId); await mkdir(runDirectory);
  await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity, startedAt: '2026-09-04T00:00:00.000Z' }));
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: (relative) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(relative) || /^artifacts\/(?:lifecycle|operations)\/[a-z0-9.-]+\.json$/.test(relative) });
  t.after(async () => { await writer.close(); await rm(parent, { recursive: true, force: true }); });
  const journalAuthority = await createJournalAuthorityFixtureUnsafe({ runDirectory, identity, genuineSafeWriter: writer }); let sequence = 1;
  for (const [role, bindingId, payload] of bindings(level)) { await journalAuthority.appendBinding({ role, bindingId, payload, createdAt: `2026-09-04T00:00:${String(sequence).padStart(2, '0')}.000Z` }); sequence += 1; }
  let currentTime = Date.parse('2026-09-04T00:01:00.000Z');
  const context = {
    ...createLifecycleTransport({ files, control, publicHttp, calls }),
    journalAuthority, now: clock ?? (() => new Date(currentTime).toISOString()), wait: async durationMs => { assert.ok(durationMs > 0 && durationMs <= 30_000); calls.push({ kind: 'wait', durationMs }); currentTime += durationMs; },
    writeArtifact: async (component, name, value) => writer.writeJson(`artifacts/${component}/${name}`, value),
  };
  const request = (step, state = {}) => ({ schema: 'raibitserver.production-evidence-step-request/v1', step, identity, startedAt: '2026-09-04T00:00:00.000Z', deadlineAt: '2026-09-04T01:00:00.000Z', runDirectory, selectors, secretRefs, state });
  return { identity, runDirectory, writer, journalAuthority, context, request, calls };
}

const authResponses = () => [response(200, { memberships: [{ organizationId: 'org' }] }), response(200, { installations: [{ installationId: '123', organizationId: 'org', integrationId: 'integration' }] }), response(200, { repositories: [{ id: '456', fullName: 'club/private-app', private: true, defaultBranch: 'main' }] }), response(201, { id: 'project' }), response(201, { service: { id: 'service', githubRepository: 'club/private-app', githubRepositoryVisibility: 'private', sourceAccess: 'github-app-private' } })];
const supplyResponses = (observed = imageDigest) => [response(200, { repositories: [{ id: '456', fullName: 'club/private-app', private: true, defaultBranch: 'main' }] }), response(202, { id: 'deployment' }), response(200, { id: 'deployment', projectId: 'project', serviceId: 'service', status: 'IMAGE_READY', commitSha: tenantSha, branch: 'main', imageDigest: observed, imageUrl: `registry.example/club/app@${observed}` }), response(200, { events: [{ id: 'build-event', deploymentId: 'deployment', type: 'build.image_ready', metadata: { dryRun: false, imageDigest: observed, image: `registry.example/club/app@${observed}` } }], nextCursor: null })];
const deployment = () => ({ id: 'deployment', projectId: 'project', serviceId: 'service', status: 'READY', commitSha: tenantSha, branch: 'main', imageDigest, publicUrl: 'https://app.example', namespace: 'run-a', deploymentName: 'web', desiredSpecSnapshot: { livenessPath: '/healthz/live', readinessPath: '/healthz/ready' } });
const kubeDeployment = (projectId = 'project') => ({ metadata: { uid: 'uid', generation: 7, labels: { 'raibitserver.io/project-id': projectId, 'raibitserver.io/service-id': 'service', 'raibitserver.io/deployment-id': 'deployment' } }, status: { observedGeneration: 7, readyReplicas: 1, updatedReplicas: 1 }, spec: { replicas: 1, template: { metadata: { labels: {} }, spec: { containers: [{ image: `registry.example/club/app@${imageDigest}` }] } } } });

test('Given a physical source journal, auth-source records API-created project/service and cleanup intent', async (t) => {
  const fixture = await scenario(t, { level: 'auth', control: authResponses() });
  assert.equal((await authSource(fixture.request('auth-source'), fixture.context)).status, 'PASS');
  const entries = await fixture.journalAuthority.loadBindings(); assert.equal(entries.find((entry) => entry.role === 'project')?.payload.projectId, 'project'); assert.equal(entries.find((entry) => entry.role === 'service')?.payload.serviceId, 'service');
  assert.equal((await fixture.journalAuthority.loadCleanup({ approvedRuntimeSelector: null })).entries.length, 4);
});

test('Given a standalone runner, direct execution is forbidden without writing a receipt', async (t) => {
  const fixture = await scenario(t, { level: 'auth' }); const requestPath = path.join(fixture.runDirectory, 'request.json'); const outputPath = path.join(fixture.runDirectory, 'receipt.json'); await writeFile(requestPath, JSON.stringify(fixture.request('auth-source')));
  await assert.rejects(execFileAsync(process.execPath, ['scripts/production-evidence/steps/auth-source.mjs', '--request', requestPath, '--output', outputPath], { cwd: process.cwd(), timeout: 10_000 }),
    (error) => error?.code === 1 && error.stderr.trim() === 'direct_component_execution_forbidden');
  await assert.rejects(readFile(outputPath, 'utf8'), { code: 'ENOENT' });
});

test('Given initial private source, supply-chain omits caller SHA and binds observed tenant revision', async (t) => {
  const calls = []; const fixture = await scenario(t, { level: 'source', calls, control: supplyResponses(), files: [ok(imageDigest), ok({ Results: [] }), ok([{}])] }); const result = await supplyChain(fixture.request('supply-chain'), fixture.context);
  assert.equal(result.status, 'PASS', result.reason); const create = calls.find(({ request }) => request?.method === 'POST').request; assert.deepEqual(create.body, { deploymentType: 'production', branch: 'main' }); assert.equal(Object.hasOwn(create.body, 'commitSha'), false);
  assert.equal((await fixture.journalAuthority.loadBindings()).find((entry) => entry.role === 'revision')?.payload.tenantCommitSha, tenantSha);
});

for (const [name, files, assertion] of [['digest', [ok(`sha256:${'9'.repeat(64)}`)], 'image_digest'], ['scan', [ok(imageDigest), ok({ Results: [{ Vulnerabilities: [{ Severity: 'CRITICAL', FixedVersion: '' }] }] })], 'scan_policy'], ['signature', [ok(imageDigest), ok({ Results: [] }), { ...ok(''), exitCode: 1 }], 'signature']]) test(`Given invalid ${name} evidence, supply-chain fails closed`, async (t) => {
  const fixture = await scenario(t, { level: 'source', control: supplyResponses(), files }); const result = await supplyChain(fixture.request('supply-chain'), fixture.context); assert.equal(result.assertions.find(({ id }) => id === assertion).status, 'FAIL');
});

test('Given exact READY runtime and fixture DB response, nonce passes but proxy evidence remains unavailable', async (t) => {
  const fixture = await scenario(t, { level: 'candidate', control: [response(200, deployment())], files: [ok('rolled'), ok(kubeDeployment()), ok('subjectAltName=DNS:app.example')], publicHttp: [response(200, {}), response(200, {}), request => response(200, { nonce: request.body.nonce, readBack: request.body.nonce })] });
  const result = await runtime(fixture.request('runtime'), fixture.context); assert.equal(result.status, 'NOT_RUN', result.reason); assert.equal(result.reason, 'trusted_proxy_observation_unavailable');
  assert.equal(result.assertions.find(row => row.id === 'functional_write_read').status, 'PASS');
  const operation = fixture.calls.find(call => call.request?.method === 'POST').request;
  assert.deepEqual(operation.body, { runId: fixture.identity.runId, deploymentId: 'deployment', nonce: evidenceDigest({ runId: fixture.identity.runId, deploymentId: 'deployment', purpose: 'runtime' }) });
  const artifact = JSON.parse(await readFile(path.join(fixture.runDirectory, 'artifacts/lifecycle/runtime-observation.json'), 'utf8')); assert.equal(Object.hasOwn(artifact, 'operation'), false);
});

test('Given mismatched runtime identity and SAN, runtime fails the relevant assertion', async (t) => {
  const wrong = await scenario(t, { level: 'candidate', control: [response(200, deployment())], files: [ok('rolled'), ok(kubeDeployment('other'))] }); assert.equal((await runtime(wrong.request('runtime'), wrong.context)).reason, 'rollout_not_ready');
  const san = await scenario(t, { level: 'candidate', control: [response(200, deployment())], files: [ok('rolled'), ok(kubeDeployment()), { ...ok('bad'), exitCode: 1 }] }); assert.equal((await runtime(san.request('runtime'), san.context)).assertions.find(({ id }) => id === 'https').status, 'FAIL');
});

test('Given a nonce read-back mismatch, runtime rejects the functional operation', async (t) => {
  const fixture = await scenario(t, { level: 'candidate', control: [response(200, deployment())], files: [ok('rolled'), ok(kubeDeployment()), ok('subjectAltName=DNS:app.example')], publicHttp: [response(200, {}), response(200, {}), response(200, { nonce: 'forged', readBack: 'forged' })] });
  const result = await runtime(fixture.request('runtime'), fixture.context); assert.equal(result.reason, 'nonce_round_trip_failed'); assert.equal(result.assertions.find(({ id }) => id === 'functional_write_read').status, 'FAIL');
});

test('Given an undeployed fixture DB contract, runtime records an unresolved prerequisite', async (t) => {
  const fixture = await scenario(t, { level: 'candidate', control: [response(200, deployment())], files: [ok('rolled'), ok(kubeDeployment()), ok('subjectAltName=DNS:app.example')], publicHttp: [response(200, {}), response(200, {}), response(404, {})] });
  const result = await runtime(fixture.request('runtime'), fixture.context); assert.equal(result.status, 'NOT_RUN'); assert.equal(result.reason, 'fixture_functional_contract_unavailable');
});

test('Given authenticated and cluster correlations, observability parses real response shapes', async (t) => {
  const correlated = { runId: 'pending', correlationId: 'corr' }; const fixture = await scenario(t, { level: 'candidate' }); correlated.runId = fixture.identity.runId;
  const queue = [response(200, deployment()), response(200, { logs: [correlated] }), response(200, { events: [correlated] }), response(200, { logs: [correlated] }), response(200, { usage: [{ ...correlated, reservationId: 'r', releaseId: 'x', auditId: 'a' }] })]; fixture.context.controlPlaneJson = async () => queue.shift(); fixture.context.executeFile = async () => ok(JSON.stringify({ ...correlated, value: 1 }));
  assert.equal((await observability(fixture.request('observability'), fixture.context)).status, 'PASS');
});

test('Given cluster-only logs or missing metrics, observability cannot PASS', async (t) => {
  const fixture = await scenario(t, { level: 'candidate', control: [response(200, deployment()), response(200, { logs: [] }), response(200, { events: [] }), response(200, { logs: [] })], files: [ok(JSON.stringify({ correlationId: 'corr' }))] }); const result = await observability(fixture.request('observability'), fixture.context); assert.equal(result.status, 'FAIL'); assert.equal(result.reason, 'correlated_log_missing');
});

test('Given correlated API logs but no ingester sample, observability fails metrics', async (t) => {
  const fixture = await scenario(t, { level: 'candidate' }); const record = { runId: fixture.identity.runId, correlationId: 'corr' }; const queue = [response(200, deployment()), response(200, { logs: [record] }), response(200, { events: [record] }), response(200, { logs: [record] }), response(200, { usage: [{ ...record, reservationId: 'r', releaseId: 'x', auditId: 'a' }] })]; fixture.context.controlPlaneJson = async () => queue.shift(); const commands = [ok(JSON.stringify(record)), ok(JSON.stringify({ ...record, value: 0 }))]; fixture.context.executeFile = async () => commands.shift();
  const result = await observability(fixture.request('observability'), fixture.context); assert.equal(result.reason, 'correlated_metric_missing'); assert.equal(result.assertions.find(({ id }) => id === 'metrics').status, 'FAIL');
});

function previewResponses() {
  const event = { deliveryId: '12345678-1234-4234-8234-123456789abc', installationId: '123', repositoryId: '456', repository: 'club/private-app', pullRequestNumber: 42, action: 'opened', headSha: tenantSha, headRef: 'test-preview', baseRef: 'main', beforeSha: null, updatedAt: '2026-09-04T00:00:01.000Z' };
  const candidate = { id: 'preview-dep', projectId: 'project', serviceId: 'service', status: 'READY', deploymentType: 'preview', triggerType: 'github_pull_request', commitSha: event.headSha, branch: event.headRef, pullRequestNumber: event.pullRequestNumber, previewLineageId: 'lineage', namespace: 'preview-ns' };
  return [response(200, { deployments: [candidate], nextCursor: null }), response(200, { events: [{ id: 'preview-event', deploymentId: candidate.id, type: 'preview.workload.queued', metadata: { source: 'github-webhook', webhookEventId: `whe-github-${event.deliveryId}`, lineageId: 'lineage', ...event } }], nextCursor: null }), response(202, { lineageId: 'lineage' }), response(200, { id: candidate.id, status: 'CLEANED_UP' })];
}

test('Given fresh preview state and canonical signed-event metadata, discovery binds actual lineage and cleans it', async (t) => {
  const fixture = await scenario(t, { level: 'source', control: previewResponses(), files: [ok({ items: [] }), ok({ items: [] })] });
  assert.equal((await preview(fixture.request('preview'), fixture.context)).status, 'PASS');
  const entries = await fixture.journalAuthority.loadBindings(), revision = entries.find(entry => entry.role === 'revision');
  assert.equal(revision.payload.observationId, 'preview-event'); assert.equal(revision.payload.tenantRevisionId, 'preview-dep'); assert.equal(revision.payload.purpose, 'preview');
  const artifact = JSON.parse(await readFile(path.join(fixture.runDirectory, 'artifacts/lifecycle/preview-observation.json'), 'utf8'));
  assert.deepEqual(artifact.event, entries.find(entry => entry.role === 'webhook').payload.event); assert.equal(artifact.deploymentId, 'preview-dep'); assert.equal(artifact.lineageId, 'lineage');
});

test('Given no externally observed webhook lineage, preview is NOT_RUN before mutation', async (t) => {
  const calls = []; const fixture = await scenario(t, { calls, control: [response(200, { deployments: [] })] }); const result = await preview(fixture.request('preview', { forgedWebhook: true }), fixture.context); assert.equal(result.status, 'NOT_RUN'); assert.equal(calls.some(({ request }) => request?.method === 'POST'), false);
});

test('Given a completed preview cleanup with a remaining owned object, preview fails leak proof', async (t) => {
  const fixture = await scenario(t, { level: 'source', control: previewResponses(), files: [ok({ items: [] }), ok({ items: [{}] })] }); const result = await preview(fixture.request('preview'), fixture.context); assert.equal(result.reason, 'preview_cleanup_leak'); const artifact = JSON.parse(await readFile(path.join(fixture.runDirectory, 'artifacts/lifecycle/preview-observation.json'), 'utf8')); assert.equal(artifact.status, 'FAIL'); assert.equal(artifact.remainingObjects, 1);
});

async function rollbackScenario(t, { failedStatus = 'FAILED', restoredDigest = imageDigest, probeStatus = 404, buildingPolls = 0 } = {}) {
  let failingPath;
  const service = { id: 'service', projectId: 'project', livenessPath: '/healthz/live', readinessPath: '/healthz/ready' };
  const restored = { ...deployment(), id: 'rollback-dep' }, kube = kubeDeployment(); kube.metadata.labels['raibitserver.io/deployment-id'] = restored.id; kube.spec.template.spec.containers[0].image = `registry.example/club/app@${restoredDigest}`;
  const control = [response(200, deployment()), response(200, service),
    request => { failingPath = request.body.readinessPath; return response(200, { ...service, readinessPath: failingPath }); },
    request => { assert.deepEqual(request.body, { deploymentType: 'production', commitSha: tenantSha, branch: 'main' }); return response(202, { id: 'bad-dep' }); },
    ...Array.from({ length: buildingPolls }, () => response(200, { ...deployment(), id: 'bad-dep', status: 'BUILDING' })),
    () => response(200, { ...deployment(), id: 'bad-dep', status: failedStatus, errorCode: 'ROLLOUT_FAILED', snapshotVersion: 1, desiredSpecSnapshot: { readinessPath: failingPath, githubRepositoryId: '456', githubRepository: 'club/private-app' } }),
    response(200, { events: [{ id: 'rollout-event', deploymentId: 'bad-dep', type: 'rollout.failed', metadata: { errorSpec: { code: 'ROLLOUT_FAILED' } } }], nextCursor: null }),
    request => { assert.deepEqual(request.body, { readinessPath: service.readinessPath }); return response(200, service); },
    request => { assert.equal(request.path, '/api/deployments/bad-dep/rollback'); assert.deepEqual(request.body, { confirmed: true, previousDeploymentId: 'deployment' }); return response(202, { deployment: { id: restored.id } }); }, response(200, restored)];
  const fixture = await scenario(t, { level: 'candidate', control, files: [ok('rolled'), ok(kube)], publicHttp: [response(200, {}), response(200, {}), response(probeStatus, {}), response(200, {}), response(200, {})] });
  const intentId = 'candidate-deployment', resourceName = deriveRunResourceName(fixture.identity, intentId);
  await fixture.journalAuthority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-create-deployment', bindingRefs: (await fixture.journalAuthority.loadBindings()).map(entry => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 })), resourceName, method: 'POST', routeTemplate: '/api/projects/:projectId/services/:serviceId/deployments', relativeRoute: '/api/projects/project/services/service/deployments', recoverySelector: { kind: 'Deployment', projectId: 'project', serviceId: 'service', name: resourceName, runIdentitySha256: evidenceDigest(fixture.identity) }, approvedRuntimeSelector: null, createdAt: '2026-09-04T00:01:00.020Z', deadlineAt: '2026-09-04T01:00:00.000Z' });
  await fixture.journalAuthority.appendOutcome({ intentId, actualId: 'deployment', actualUid: null, responseSha256: evidenceDigest({ id: 'deployment' }), resolvedAt: '2026-09-04T00:01:00.021Z', approvedRuntimeSelector: null });
  return fixture;
}

test('Given fresh failure state, controlled readiness rollout pins source and rollback intent targets the actual failed deployment', async (t) => {
  const fixture = await rollbackScenario(t); const result = await rollback(fixture.request('rollback'), fixture.context); assert.equal(result.status, 'PASS', result.reason);
  const artifact = JSON.parse(await readFile(path.join(fixture.runDirectory, 'artifacts/operations/rollback-observation.json'), 'utf8'));
  assert.equal(artifact.controlledBadObservationId, 'rollout-event'); assert.equal(artifact.failureRevision.commitSha, tenantSha); assert.equal(artifact.controlledFault.deploymentReadinessPath, artifact.controlledFault.failingPath); assert.equal(artifact.controlledFault.restoredReadinessPath, '/healthz/ready'); assert.equal(artifact.servedDigest, imageDigest);
  const cleanup = await fixture.journalAuthority.loadCleanup({ approvedRuntimeSelector: null }); const intent = cleanup.entries.find(entry => entry.intentId === 'rollback' && entry.relativeRoute);
  assert.equal(intent.relativeRoute, fixture.calls.find(call => call.request?.path === '/api/deployments/bad-dep/rollback').request.path); assert.equal(intent.recoverySelector.deploymentId, 'bad-dep');
});

test('Given a fault path that succeeds, controlled rollback is NOT_RUN before mutation', async (t) => {
  const fixture = await rollbackScenario(t, { probeStatus: 200 }); const result = await rollback(fixture.request('rollback'), fixture.context); assert.equal(result.reason, 'controlled_fault_path_unavailable'); assert.equal(fixture.calls.some(call => ['POST', 'PATCH'].includes(call.request?.method)), false);
});

test('Given a build longer than eight polls, controlled rollback uses its remaining deadline', async (t) => {
  const fixture = await rollbackScenario(t, { buildingPolls: 9 });
  const request = { ...fixture.request('rollback'), deadlineAt: '2026-09-04T00:11:00.000Z' };
  assert.equal((await rollback(request, fixture.context)).status, 'PASS');
  const waits = fixture.calls.filter(call => call.kind === 'wait'); assert.equal(waits.length, 9); assert.ok(waits.reduce((total, call) => total + call.durationMs, 0) > 120_000);
});

test('Given a build failure instead of rollout failure, original health restores but rollback cannot pass', async (t) => {
  const fixture = await rollbackScenario(t, { failedStatus: 'BUILD_FAILED' }); const result = await rollback(fixture.request('rollback'), fixture.context); assert.equal(result.reason, 'controlled_bad_rollout_not_observed');
  assert.deepEqual(fixture.calls.filter(call => call.request?.method === 'PATCH').at(-1).request.body, { readinessPath: '/healthz/ready' }); assert.equal(fixture.calls.some(call => call.request?.path?.endsWith('/rollback')), false);
});

test('Given rollback workload serving another digest, rollback fails exact restoration', async (t) => {
  const fixture = await rollbackScenario(t, { restoredDigest: `sha256:${'9'.repeat(64)}` }); const result = await rollback(fixture.request('rollback'), fixture.context); assert.equal(result.reason, 'rollback_digest_mismatch');
});

test('Given plain, foreign, tampered, or spliced journal authority, protected mutation never starts', async (t) => {
  const cases = [];
  const plain = await scenario(t, { level: 'source' }); plain.context.journalAuthority = Object.freeze({ loadBindings: async () => [] }); cases.push(plain);
  const foreign = await scenario(t, { level: 'source' }); const other = await scenario(t, { level: 'source' }); foreign.context.journalAuthority = other.journalAuthority; cases.push(foreign);
  const tampered = await scenario(t, { level: 'source' }); const bindingFile = (await readdir(path.join(tampered.runDirectory, 'bindings'))).find((name) => /^000002-/.test(name)); await writeFile(path.join(tampered.runDirectory, 'bindings', bindingFile), '{}\n'); cases.push(tampered);
  const spliced = await scenario(t, { level: 'source' }); const donor = await scenario(t, { level: 'auth' }); const donorFile = (await readdir(path.join(donor.runDirectory, 'bindings'))).find((name) => /^000001-/.test(name)); await copyFile(path.join(donor.runDirectory, 'bindings', donorFile), path.join(spliced.runDirectory, 'bindings', `000005--${'a'.repeat(16)}.json`)); cases.push(spliced);
  for (const fixture of cases) { const result = await supplyChain(fixture.request('supply-chain'), fixture.context); assert.equal(result.status, 'NOT_RUN'); assert.equal(fixture.calls.length, 0); }
});

test('Given secret-looking API data, lifecycle artifacts remain redacted', async (t) => {
  const fixture = await scenario(t, { level: 'auth', control: authResponses().map((item, index) => index === 2 ? response(200, { ...item.body, token: 'github_pat_never-persist' }) : item) }); assert.equal((await authSource(fixture.request('auth-source'), fixture.context)).status, 'PASS');
  const artifact = await readFile(path.join(fixture.runDirectory, 'artifacts/lifecycle/auth-source-observation.json'), 'utf8'); assert.equal(artifact.includes('github_pat_never-persist'), false);
});

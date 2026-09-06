import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execute as cleanup } from '../scripts/production-evidence/steps/cleanup.mjs';
import { createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { deriveRunResourceName, MUTATION_CONTRACT } from '../scripts/production-evidence/lib/binding-graph.mjs';
import { createUnsafeFixtureArtifactWriter } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { APPROVED_INPUT_SHA256, digest, loadOperatorContract, OPERATOR_CONTRACT_DIGEST } from '../scripts/production-evidence/lib/operator-inputs.mjs';

const contract = await loadOperatorContract();
const cleanupStartedAt = new Date(Date.now() - 60_000).toISOString();
const cleanupDeadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
const tenant = Object.freeze({ organizationId: 'fixture-org', projectId: 'fixture-project', serviceId: 'fixture-service' });

function identity(runId = randomUUID()) {
  return {
    runId, environmentFingerprint: digest(`environment:${runId}`), sourceCommitSha: 'a'.repeat(40),
    migrationDigest: digest(`migration:${runId}`), approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: digest(`inputs:${runId}`),
  };
}

function inputs() {
  const values = ['fixture-context', 'fixture-prefix', 'fixture.example', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
  return {
    schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: Object.fromEntries(contract.selectors.map(({ name }, index) => [name, values[index]])),
    secretRefs: contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
      ? { role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`, keys: Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key'] }
      : { role, binding, kind, namespace: 'fixture-system', secretKeyRef: { name: `fixture-${role}`, key: 'fixture-key', optional: false } }),
  };
}

async function physicalCleanupJournal(t, runDirectory, run, controlItems) {
  await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: run, startedAt: cleanupStartedAt }), { flag: 'wx', mode: 0o600 });
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: (relative) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(relative) });
  t.after(() => writer.close());
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory, identity: run, genuineSafeWriter: writer });
  let at = Date.now() - 20_000;
  const next = () => new Date(at += 10).toISOString();
  const refs = [];
  const add = async (role, bindingId, payload) => {
    const appended = await authority.appendBinding({ role, bindingId, payload, createdAt: next() });
    refs.push(appended.entry); return appended.entry;
  };
  const member = await add('identity', 'membership', { kind: 'organization-membership', organizationId: tenant.organizationId, membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' });
  const project = await add('project', 'primary', { kind: 'project', projectId: tenant.projectId, organizationId: tenant.organizationId });
  const repository = await add('repository', 'primary', { kind: 'github-repository', installationId: 'install-a', repositoryId: 'repository-a', repository: 'fixture/repository', branch: 'main' });
  const revision = await add('revision', 'candidate', { kind: 'tenant-revision', tenantRevisionId: 'revision-a', purpose: 'candidate', observationId: 'observation-a', repositoryId: 'repository-a', repository: 'fixture/repository', branch: 'main', tenantCommitSha: 'a'.repeat(40) });
  const service = await add('service', 'primary', { kind: 'service', serviceId: tenant.serviceId, projectId: tenant.projectId });
  const source = await add('resource', 'source', { kind: 'resource', role: 'source', engine: 'postgresql', resourceId: 'source-resource-1', projectId: tenant.projectId });
  const byTarget = new Map();
  for (const item of controlItems) {
    if (item.resourceType === 'attachment') continue;
    let entry;
    switch (item.resourceType) {
      case 'project': entry = project; break;
      case 'resource': entry = item.id === source.payload.resourceId ? source : await add('resource', `source-${item.id.toLowerCase()}`, { kind: 'resource', role: 'source', engine: 'postgresql', resourceId: item.id, projectId: tenant.projectId }); break;
      case 'restore-target': entry = await add('resource', `restore-${item.id.toLowerCase()}`, { kind: 'resource', role: 'restore-target', engine: 'postgresql', resourceId: item.id, projectId: tenant.projectId }); break;
      case 'backup': entry = await add('backup', `backup-${item.id.toLowerCase()}`, { kind: 'backup', engine: 'postgresql', backupId: item.id, sourceResourceId: source.payload.resourceId }); break;
      case 'preview': entry = await add('deployment', `preview-${item.id.toLowerCase()}`, { kind: 'deployment', role: 'preview', deploymentId: item.id, serviceId: service.payload.serviceId, tenantRevisionId: revision.payload.tenantRevisionId, tenantCommitSha: revision.payload.tenantCommitSha, repositoryId: revision.payload.repositoryId, repository: revision.payload.repository, branch: revision.payload.branch }); break;
      default: throw new Error(`unsupported fixture target ${item.resourceType}`);
    }
    byTarget.set(`${item.resourceType}:${item.id}`, entry);
  }
  const reference = (entry) => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 });
  const create = async (item, binding) => {
    const intentId = `create-${item.resourceType}-${digest(item.id).slice(0, 12)}`;
    const resourceName = deriveRunResourceName(run, intentId);
    const mutationKind = ({ preview: 'control-plane-create-deployment', resource: 'control-plane-create-resource', 'restore-target': 'control-plane-create-resource', backup: 'control-plane-create-backup', project: 'control-plane-create-project' })[item.resourceType];
    const bindingRefs = item.resourceType === 'project' ? [member] : item.resourceType === 'backup' ? [member, project, source] : item.resourceType === 'preview' ? [member, project, service] : [member, project];
    const selector = item.resourceType === 'project' ? { kind: 'Project', organizationId: tenant.organizationId, slug: resourceName, runIdentitySha256: digest(run) }
      : item.resourceType === 'backup' ? { kind: 'Backup', projectId: tenant.projectId, resourceId: source.payload.resourceId, engine: source.payload.engine, name: resourceName, runIdentitySha256: digest(run) }
        : item.resourceType === 'preview' ? { kind: 'Deployment', projectId: tenant.projectId, serviceId: service.payload.serviceId, name: resourceName, runIdentitySha256: digest(run) }
          : { kind: 'Resource', projectId: tenant.projectId, name: resourceName, runIdentitySha256: digest(run) };
    const [method, routeTemplate] = MUTATION_CONTRACT[mutationKind];
    const relativeRoute = item.resourceType === 'project' ? '/api/projects' : item.resourceType === 'backup' ? `/api/resources/${source.payload.resourceId}/backups`
      : item.resourceType === 'preview' ? `/api/projects/${tenant.projectId}/services/${service.payload.serviceId}/deployments` : `/api/projects/${tenant.projectId}/resources`;
    await authority.appendCleanupIntent({ intentId, mutationKind, bindingRefs: bindingRefs.map(reference), resourceName, method, routeTemplate, relativeRoute, recoverySelector: selector, approvedRuntimeSelector: null, createdAt: next(), deadlineAt: cleanupDeadlineAt });
    await authority.appendOutcome({ intentId, actualId: item.id, actualUid: null, responseSha256: digest({ created: item.id }), resolvedAt: next(), approvedRuntimeSelector: null });
  };
  for (const item of controlItems) if (item.resourceType !== 'attachment') await create(item, byTarget.get(`${item.resourceType}:${item.id}`));
  return authority;
}

function deletingBackup(id) {
  return { id, organizationId: tenant.organizationId, projectId: tenant.projectId, resourceId: 'source-resource-1', engine: 'postgresql',
    status: 'DELETING', createdAt: cleanupStartedAt, readyAt: cleanupStartedAt, errorCode: null, size: '1', expiresAt: cleanupDeadlineAt, recoverable: false };
}

async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'raibit-production-evidence-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}


function fixedClock() { let value = Date.now(); return { now: () => new Date(value += 1) }; }

test('Given a restore outcome and its later target association, When cleanup executes, Then only the recorded target resource is deleted', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  await mkdir(path.join(runDirectory, 'work'), { recursive: true });
  const run = identity(path.basename(runDirectory));
  const authority = await physicalCleanupJournal(t, runDirectory, run, []);
  const at = Date.now() - 1_000;
  await authority.appendBinding({ role: 'backup', bindingId: 'restore-source-backup', payload: { kind: 'backup', engine: 'postgresql', backupId: 'source-backup', sourceResourceId: 'source-resource-1' }, createdAt: new Date(at).toISOString() });
  const entries = await authority.loadBindings();
  const refs = entries.filter(({ payload }) => ['organization-membership', 'project', 'resource', 'backup'].includes(payload.kind));
  const intentId = 'create-restore-target';
  const resourceName = deriveRunResourceName(run, intentId);
  await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-create-restore',
    bindingRefs: refs.map(({ role, bindingId, entrySha256 }) => ({ role, bindingId, entrySha256 })), resourceName,
    method: 'POST', routeTemplate: '/api/backups/:backupId/restores', relativeRoute: '/api/backups/source-backup/restores',
    recoverySelector: { kind: 'Restore', projectId: tenant.projectId, backupId: 'source-backup', engine: 'postgresql', name: resourceName, runIdentitySha256: digest(run) },
    approvedRuntimeSelector: null, createdAt: new Date(at + 1).toISOString(), deadlineAt: cleanupDeadlineAt });
  await authority.appendBinding({ role: 'resource', bindingId: 'restore-target', payload: { kind: 'resource', role: 'restore-target', engine: 'postgresql', resourceId: 'target-resource', projectId: tenant.projectId }, createdAt: new Date(at + 2).toISOString() });
  await authority.appendBinding({ role: 'restore', bindingId: 'restore-operation', payload: { kind: 'restore', engine: 'postgresql', restoreId: 'restore-operation', backupId: 'source-backup', targetResourceId: 'target-resource' }, createdAt: new Date(at + 3).toISOString() });
  await authority.appendOutcome({ intentId, actualId: 'restore-operation', actualUid: null, responseSha256: digest({ id: 'restore-operation', targetResourceId: 'target-resource' }), approvedRuntimeSelector: null, resolvedAt: new Date(at + 4).toISOString() });
  const calls = [];
  const result = await cleanup({ schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'control-plane', resourceType: 'restore-target', id: 'target-resource', organizationId: tenant.organizationId, projectId: tenant.projectId }] } }, {
    now: fixedClock().now, journalAuthority: authority, async waitForCleanup() { return true; },
    async controlPlaneJson(operation) { calls.push([operation.method, operation.path]); return operation.method === 'DELETE'
      ? { statusCode: 200, body: { deleted: true, resourceId: 'target-resource' } } : { statusCode: 404, body: null }; },
    async writeArtifact(_component, _name, value) { return { path: 'cleanup/cleanup-observation.json', sha256: digest(value), redacted: true }; },
  });
  assert.equal(result.status, 'PASS', result.reason);
  assert.deepEqual(calls, [['DELETE', '/api/resources/target-resource'], ['GET', '/api/resources/target-resource']]);
});

test('Given a backup binding recorded after its creation intent, When the resolved outcome proves its ID, Then cleanup accepts real mutation ordering', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  await mkdir(path.join(runDirectory, 'work'), { recursive: true });
  const run = identity(path.basename(runDirectory));
  const authority = await physicalCleanupJournal(t, runDirectory, run, []);
  const entries = await authority.loadBindings();
  const refs = entries.filter(({ payload }) => ['organization-membership', 'project', 'resource'].includes(payload.kind));
  const intentId = 'create-backup-late';
  const resourceName = deriveRunResourceName(run, intentId);
  const at = Date.now() - 1_000;
  await authority.appendCleanupIntent({ intentId, mutationKind: 'control-plane-create-backup',
    bindingRefs: refs.map(({ role, bindingId, entrySha256 }) => ({ role, bindingId, entrySha256 })), resourceName,
    method: 'POST', routeTemplate: '/api/resources/:resourceId/backups', relativeRoute: '/api/resources/source-resource-1/backups',
    recoverySelector: { kind: 'Backup', projectId: tenant.projectId, resourceId: 'source-resource-1', engine: 'postgresql', name: resourceName, runIdentitySha256: digest(run) },
    approvedRuntimeSelector: null, createdAt: new Date(at).toISOString(), deadlineAt: cleanupDeadlineAt });
  await authority.appendBinding({ role: 'backup', bindingId: 'backup-late', payload: { kind: 'backup', engine: 'postgresql', backupId: 'backup-late', sourceResourceId: 'source-resource-1' }, createdAt: new Date(at + 1).toISOString() });
  await authority.appendOutcome({ intentId, actualId: 'backup-late', actualUid: null, responseSha256: digest({ id: 'backup-late' }), approvedRuntimeSelector: null, resolvedAt: new Date(at + 2).toISOString() });
  const calls = [];
  const result = await cleanup({ schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'control-plane', resourceType: 'backup', id: 'backup-late', organizationId: tenant.organizationId, projectId: tenant.projectId }] } }, {
    now: fixedClock().now, journalAuthority: authority, async waitForCleanup() { return true; },
    async controlPlaneJson(operation) { calls.push(operation.method); return operation.method === 'DELETE'
      ? { statusCode: 200, body: deletingBackup('backup-late') } : { statusCode: 200, body: { backups: [], nextCursor: null } }; },
    async writeArtifact(_component, _name, value) { return { path: 'cleanup/cleanup-observation.json', sha256: digest(value), redacted: true }; },
  });
  assert.equal(result.status, 'PASS', result.reason);
  assert.deepEqual(calls, ['DELETE', 'GET']);
});

test('Given stale or missing authenticated Pod inventory, When cleanup reaches the terminal NetworkPolicy, Then the policy is preserved', async (t) => {
  const directory = await sandbox(t);
  for (const includePod of [true, false]) {
    const runDirectory = path.join(directory, randomUUID());
    await mkdir(path.join(runDirectory, 'work'), { recursive: true });
    const run = identity(path.basename(runDirectory));
    const descriptor = { schema: 'raibitserver.production-evidence-client/v1', namespace: 'runtime', podName: 'client', podUid: 'pod-uid', podResourceVersion: '42',
      networkPolicyUid: 'policy-uid', networkPolicyResourceVersion: '42', apiServiceName: 'api', apiServiceUid: 'api-uid', port: 3000, expiresAt: cleanupDeadlineAt };
    const pod = { type: 'kubernetes', apiVersion: 'v1', kind: 'Pod', namespace: 'runtime', name: 'client', uid: 'pod-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } };
    const policy = { ...pod, apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: 'client-egress', uid: 'policy-uid' };
    const calls = [];
    const result = await cleanup({ schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
      startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
      state: { cleanupNamespace: 'runtime', authenticatedClient: descriptor, cleanupInventory: includePod ? [policy, pod] : [policy] } }, {
      now: fixedClock().now,
      async executeFile(_file, args) { calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ metadata: { uid: 'pod-uid', resourceVersion: '43', namespace: 'runtime', labels: pod.labels } }), stderr: '' }; },
      async writeArtifact(_component, _name, value) { return { path: 'cleanup/cleanup-observation.json', sha256: digest(value), redacted: true }; },
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, 'cleanup_identity_mismatch');
    assert.equal(calls.some((args) => args.includes('client-egress') || args[0] === 'delete'), false);
  }
});

test('Given a work file whose invocation ownership is unproven, When cleanup executes, Then it preserves the file and records refusal', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  const work = path.join(runDirectory, 'work');
  const temporary = path.join(work, 'credential-request.json');
  await mkdir(work, { recursive: true });
  await writeFile(temporary, '{"reference":"fixture"}\n');
  const run = identity(path.basename(runDirectory));
  const written = [];
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory,
    selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'file', path: temporary }] },
  }, {
    now: fixedClock().now,
    async executeFile() { throw new Error('file-only cleanup must not spawn a command'); },
    async controlPlaneJson() { throw new Error('file-only cleanup must not call the control plane'); },
    async writeArtifact(component, name, value) {
      const target = path.join(runDirectory, component, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(value)}\n`, { flag: 'wx' });
      written.push(target);
      return { path: `${component}/${name}`, sha256: digest(`${JSON.stringify(value)}\n`), redacted: true };
    },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_file_ownership_missing');
  assert.equal(existsSync(temporary), true);
  assert.deepEqual(result.assertions.map(({ id }) => id), ['component_cleanup', 'run_cleanup']);
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(await readFile(written[0], 'utf8')).identity.runId, run.runId);
});

test('Given a Kubernetes object with a substituted UID, When cleanup executes, Then it fails closed before deletion and still writes its identity-bound receipt', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  await mkdir(path.join(runDirectory, 'work'), { recursive: true });
  const trailingFile = path.join(runDirectory, 'work', 'request.json');
  await writeFile(trailingFile, '{"fixture":true}\n');
  const run = identity(path.basename(runDirectory));
  let receipt;
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory,
    selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: {
      cleanupNamespace: 'fixture-system',
      cleanupInventory: [
        { type: 'kubernetes', apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'fixture-system', name: 'fixture-worker', uid: 'expected-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } },
        { type: 'file', path: trailingFile },
      ],
    },
  }, {
    now: fixedClock().now,
    async executeFile() { return { exitCode: 0, stdout: JSON.stringify({ metadata: { uid: 'substituted-uid', namespace: 'fixture-system', labels: { 'raibitserver.io/run-id': run.runId } } }), stderr: '' }; },
    async controlPlaneJson() { throw new Error('unexpected request'); },
    async writeArtifact(_component, _name, value) {
      receipt = value;
      return { path: 'cleanup/cleanup-observation.json', sha256: digest(JSON.stringify(value)), redacted: true };
    },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_file_ownership_missing');
  assert.equal(receipt.cleanupResults.find(({ target }) => target.startsWith('kubernetes:')).reason, 'cleanup_identity_mismatch');
  assert.equal(existsSync(trailingFile), true);
  assert.equal(receipt.identity.runId, run.runId);
});

test('Given a Kubernetes object replaced after lookup, When cleanup issues its UID and resourceVersion preconditioned delete, Then the replacement race fails closed', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  await mkdir(path.join(runDirectory, 'work'), { recursive: true });
  const run = identity(path.basename(runDirectory));
  const deletes = [];
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory,
    selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'kubernetes', apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'fixture-system', name: 'fixture-worker', uid: 'original-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } }] },
  }, {
    now: fixedClock().now,
    async executeFile(_file, args, options) {
      if (args.includes('get')) return { exitCode: 0, stdout: JSON.stringify({ metadata: { uid: 'original-uid', resourceVersion: '42', namespace: 'fixture-system', labels: { 'raibitserver.io/run-id': run.runId } } }), stderr: '' };
      assert.deepEqual(args, ['delete', '--raw', '/apis/apps/v1/namespaces/fixture-system/deployments/fixture-worker', '-f', '-']);
      const body = JSON.parse(options.stdin);
      deletes.push({ body, stdin: options.stdin });
      return { exitCode: 1, stdout: '', stderr: 'Conflict: object has been replaced' };
    },
    async writeArtifact(component, name, value) { return { path: `${component}/${name}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_command_failure');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'original-uid', resourceVersion: '42' } });
  assert.equal(deletes[0].stdin.endsWith('\n'), true);
});

test('Given a legacy DeleteOptions pathname collision, When Kubernetes cleanup uses stdin, Then it preserves the foreign file and never opens it', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  const work = path.join(runDirectory, 'work');
  const optionPath = path.join(work, 'fixture-worker.deployment.delete-options.json');
  const foreignBytes = 'foreign-prior-run-options\n';
  await mkdir(work, { recursive: true });
  await writeFile(optionPath, foreignBytes, { flag: 'wx' });
  const run = identity(path.basename(runDirectory));
  let rawDeletes = 0;
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory,
    selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'kubernetes', apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'fixture-system', name: 'fixture-worker', uid: 'original-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } }] },
  }, {
    now: fixedClock().now,
    async executeFile(_file, args, options) {
      if (args.includes('get')) return { exitCode: 0, stdout: JSON.stringify({ metadata: { uid: 'original-uid', resourceVersion: '42', namespace: 'fixture-system', labels: { 'raibitserver.io/run-id': run.runId } } }), stderr: '' };
      if (args[0] === 'delete' && args[1] === '--raw') {
        rawDeletes += 1;
        assert.equal(args.includes(optionPath), false);
        assert.equal(typeof options.stdin, 'string');
        return { exitCode: 1, stdout: '', stderr: 'Conflict' };
      }
      throw new Error('409 must stop before wait');
    },
    async writeArtifact(component, name, value) { return { path: `${component}/${name}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(rawDeletes, 1);
  assert.equal(await readFile(optionPath, 'utf8'), foreignBytes);
});

test('Given a Kubernetes raw DeleteOptions request, When it sends the body through stdin, Then it creates no work files', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  const work = path.join(runDirectory, 'work');
  await mkdir(work, { recursive: true });
  const run = identity(path.basename(runDirectory));
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory,
    selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'kubernetes', apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'fixture-system', name: 'fixture-worker', uid: 'original-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } }] },
  }, {
    now: fixedClock().now,
    async executeFile(_file, args, options) {
      if (args.includes('get')) return { exitCode: 0, stdout: JSON.stringify({ metadata: { uid: 'original-uid', resourceVersion: '42', namespace: 'fixture-system', labels: { 'raibitserver.io/run-id': run.runId } } }), stderr: '' };
      assert.deepEqual(args, ['delete', '--raw', '/apis/apps/v1/namespaces/fixture-system/deployments/fixture-worker', '-f', '-']);
      assert.equal(options.stdin, '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"original-uid","resourceVersion":"42"}}\n');
      return { exitCode: 1, stdout: '', stderr: 'Conflict' };
    },
    async writeArtifact(component, name, value) { return { path: `${component}/${name}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(await readdir(work), []);
});

test('Given mixed valid and malformed inventory entries, When cleanup executes, Then it preserves unproven files and records an aggregate failure', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  const temporary = path.join(runDirectory, 'work', 'request.json');
  await mkdir(path.dirname(temporary), { recursive: true });
  await writeFile(temporary, '{"fixture":true}\n');
  const run = identity(path.basename(runDirectory));
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [{ type: 'file', path: temporary }, { type: 'file', path: path.join(directory, 'outside-work.json') }] },
  }, {
    now: fixedClock().now,
    async executeFile() { throw new Error('file-only cleanup must not spawn a command'); },
    async controlPlaneJson() { throw new Error('file-only cleanup must not call the control plane'); },
    async writeArtifact(_component, _name, value) { return { path: 'cleanup/cleanup-observation.json', sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(existsSync(temporary), true);
  assert.equal(result.cleanupInventory.length, 1);
  assert.equal(result.assertions.every(({ status }) => status === 'FAIL'), true);
});

test('Given child resources, tenant targets, and an authenticated client pair, When cleanup runs, Then child cleanup precedes project and Pod then NetworkPolicy are terminal', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  const temporary = path.join(runDirectory, 'work', 'credential.json');
  await mkdir(path.dirname(temporary), { recursive: true });
  await writeFile(temporary, '{"fixture":true}\n');
  const run = identity(path.basename(runDirectory));
  const calls = [];
  let resourceAbsent = false;
  let projectDeleted = false;
  let tenantProcessObserved = false;
  const inventory = [
    { type: 'kubernetes', apiVersion: 'v1', kind: 'Pod', namespace: 'runtime-secret', name: 'evidence-client', uid: 'client-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } },
    { type: 'kubernetes', apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace: 'runtime-secret', name: 'evidence-client-egress', uid: 'client-policy-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } },
    { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'project', id: tenant.projectId },
    { type: 'process', pid: 4242, startedAt: cleanupStartedAt, commandSha256: 'c'.repeat(64) },
    { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'resource', id: 'resource-1' },
    { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'backup', id: 'backup-1' },
    { type: 'kubernetes', apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'tenant-run', name: 'tenant-worker', uid: 'tenant-uid', resourceVersion: '42', labels: { 'raibitserver.io/run-id': run.runId } },
    { type: 'file', path: temporary },
  ];
  const journalAuthority = await physicalCleanupJournal(t, runDirectory, run, inventory.filter((item) => item.type === 'control-plane'));
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: {
      cleanupNamespace: 'tenant-run', authenticatedClient: { schema: 'raibitserver.production-evidence-client/v1', namespace: 'runtime-secret', podName: 'evidence-client', podUid: 'client-uid', podResourceVersion: '42', networkPolicyUid: 'client-policy-uid', networkPolicyResourceVersion: '42', apiServiceName: 'api', apiServiceUid: 'api-uid', port: 3000, expiresAt: cleanupDeadlineAt },
      cleanupInventory: inventory,
    },
  }, {
    now: fixedClock().now,
    async executeFile(file, args) {
      if (file === 'raibit-evidence-process') {
        assert.equal(projectDeleted, true);
        tenantProcessObserved = true; calls.push('tenant-process');
      } else if (args.includes('tenant-worker')) {
        assert.equal(projectDeleted, true);
        assert.equal(existsSync(temporary), true);
        calls.push('tenant-kubernetes');
      } else if (args.includes('evidence-client-egress')) {
        assert.equal(tenantProcessObserved, true);
        assert.equal(calls.includes('authenticated-client-pod'), true);
        calls.push('authenticated-client-network-policy');
      } else {
        assert.equal(tenantProcessObserved, true);
        calls.push('authenticated-client-pod');
      }
      return { exitCode: 1, stdout: '', stderr: 'NotFound' };
    },
    async controlPlaneJson(request) {
      calls.push(`${request.method} ${request.path}`);
      if (request.path === '/api/resources/resource-1' && request.method === 'DELETE') return { statusCode: 200, body: { deleted: true, resourceId: 'resource-1' } };
      if (request.path === '/api/resources/resource-1' && request.method === 'GET') { resourceAbsent = true; return { statusCode: 404, body: null }; }
      if (request.path === '/api/backups/backup-1' && request.method === 'DELETE') {
        assert.equal(resourceAbsent, false); assert.deepEqual(request.body, { confirmed: true }); return { statusCode: 200, body: deletingBackup('backup-1') };
      }
      if (request.path === '/api/resources/source-resource-1/backups' && request.method === 'GET') return { statusCode: 200, body: { backups: [], nextCursor: null } };
      if (request.path === `/api/projects/${tenant.projectId}` && request.method === 'DELETE') {
        assert.equal(resourceAbsent, true); projectDeleted = true; return { statusCode: 202, body: { deletionRequested: true, projectId: tenant.projectId } };
      }
      if (request.path === `/api/projects/${tenant.projectId}` && request.method === 'GET') return { statusCode: 404, body: null };
      throw new Error(`unexpected authenticated operation ${request.method} ${request.path}`);
    },
    journalAuthority,
    async waitForCleanup() { return true; },
    async writeArtifact(_component, _name, value) { return { path: 'cleanup/cleanup-observation.json', sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_file_ownership_missing');
  assert.deepEqual(calls, [
    'DELETE /api/backups/backup-1', 'GET /api/resources/source-resource-1/backups', 'DELETE /api/resources/resource-1', 'GET /api/resources/resource-1', `DELETE /api/projects/${tenant.projectId}`,
    `GET /api/projects/${tenant.projectId}`, 'tenant-kubernetes', 'tenant-process', 'authenticated-client-pod', 'authenticated-client-network-policy',
  ]);
});

test('Given malformed asynchronous project deletion acknowledgements, When journal-bound cleanup deletes a project, Then empty, foreign, and wrong-status bodies fail closed', async (t) => {
  const directory = await sandbox(t);
  const cases = [
    ['empty', 202, {}],
    ['foreign-project', 202, { deletionRequested: true, projectId: 'other-project' }],
    ['wrong-status', 200, { deletionRequested: true, projectId: 'fixture-project' }],
  ];
  for (const [name, statusCode, body] of cases) {
    const runDirectory = path.join(directory, name, randomUUID());
    await mkdir(path.join(runDirectory, 'work'), { recursive: true });
    const run = identity(path.basename(runDirectory));
    const project = { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'project', id: tenant.projectId };
    const journalAuthority = await physicalCleanupJournal(t, runDirectory, run, [project]);
    const requests = [];
    const result = await cleanup({
      schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
      startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
      state: { cleanupNamespace: 'fixture-system', cleanupInventory: [project] },
    }, {
      now: fixedClock().now,
      async controlPlaneJson(request) { requests.push(request); return { statusCode, body }; },
      journalAuthority,
      async waitForCleanup() { return true; },
      async writeArtifact(component, artifact, value) { return { path: `${component}/${artifact}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
    });
    assert.equal(result.status, 'FAIL', name);
    assert.equal(result.reason, 'cleanup_command_failure', name);
    assert.deepEqual(requests.map(({ method, path: target }) => [method, target]), [['DELETE', `/api/projects/${tenant.projectId}`]], name);
  }
});

test('Given a same-project foreign-run inventory target, When cleanup compares it with the immutable current-run journal, Then it rejects the target before DELETE while preserving unproven local work', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  const workFile = path.join(runDirectory, 'work', 'current-run-request.json');
  await mkdir(path.dirname(workFile), { recursive: true });
  await writeFile(workFile, '{"fixture":true}\n');
  const run = identity(path.basename(runDirectory));
  const current = { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'resource', id: 'current-run-resource' };
  const foreign = { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'resource', id: 'foreign-run-resource' };
  const journalAuthority = await physicalCleanupJournal(t, runDirectory, run, [current]);
  const requests = [];
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [foreign, { type: 'file', path: workFile }] },
  }, {
    now: fixedClock().now,
    async controlPlaneJson(request) { requests.push(request); throw new Error('foreign target must be rejected before authenticated DELETE'); },
    journalAuthority,
    async waitForCleanup() { return true; },
    async writeArtifact(component, artifact, value) { return { path: `${component}/${artifact}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_binding_mismatch');
  assert.deepEqual(requests, []);
  assert.equal(existsSync(workFile), true);
});

test('Given a current-run binding without a successful creation outcome, When cleanup evaluates the target, Then it fails before DELETE', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  await mkdir(path.join(runDirectory, 'work'), { recursive: true });
  const run = identity(path.basename(runDirectory));
  const resource = { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'resource', id: 'resource-1' };
  const unrelated = { ...resource, id: 'other-current-run-resource' };
  const journalAuthority = await physicalCleanupJournal(t, runDirectory, run, [unrelated]);
  const requests = [];
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [resource] },
  }, {
    now: fixedClock().now,
    async controlPlaneJson(request) { requests.push(request); throw new Error('missing intent must reject before authenticated DELETE'); },
    journalAuthority,
    async waitForCleanup() { return true; },
    async writeArtifact(component, artifact, value) { return { path: `${component}/${artifact}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'cleanup_binding_mismatch');
  assert.deepEqual(requests, []);
});

test('Given a verified physical journal but no bounded wait capability, When cleanup sees asynchronous control-plane work, Then it is NOT_RUN before DELETE', async (t) => {
  const directory = await sandbox(t);
  const runDirectory = path.join(directory, randomUUID());
  await mkdir(path.join(runDirectory, 'work'), { recursive: true });
  const run = identity(path.basename(runDirectory));
  const resource = { type: 'control-plane', organizationId: tenant.organizationId, projectId: tenant.projectId, resourceType: 'resource', id: 'resource-1' };
  const journalAuthority = await physicalCleanupJournal(t, runDirectory, run, [resource]);
  const requests = [];
  const result = await cleanup({
    schema: 'raibitserver.production-evidence-step-request/v1', step: 'cleanup', identity: run,
    startedAt: cleanupStartedAt, deadlineAt: cleanupDeadlineAt, runDirectory, selectors: inputs().selectors, secretRefs: inputs().secretRefs,
    state: { cleanupNamespace: 'fixture-system', cleanupInventory: [resource] },
  }, {
    now: fixedClock().now,
    async controlPlaneJson(request) { requests.push(request); throw new Error('missing wait capability must prevent DELETE'); },
    journalAuthority,
    async writeArtifact(component, artifact, value) { return { path: `${component}/${artifact}`, sha256: digest(JSON.stringify(value)), redacted: true }; },
  });
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'cleanup_wait_capability_missing');
  assert.deepEqual(requests, []);
});

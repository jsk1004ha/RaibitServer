import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendBindingFixtureUnsafe, bindingJournalSnapshotFixtureUnsafe, isPrivateJournalMetadata, loadBindingsFixtureUnsafe, resolveBindingGraph } from '../scripts/production-evidence/lib/binding-journal.mjs';
import {
  appendCleanupIntentFixtureUnsafe, appendCleanupOutcomeFixtureUnsafe, deriveRunResourceName,
  loadCleanupJournalFixtureUnsafe, productionEvidenceJournalSnapshotFixtureUnsafe, resolveCleanupRecovery,
} from '../scripts/production-evidence/lib/cleanup-intent-journal.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { createSafeArtifactWriter, createUnsafeFixtureArtifactWriter, PRIVATE_WRITER_SESSION_PATH } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { assertJournalAuthority, createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { releaseBindings } from './fixtures/production-evidence/bindings-v1.mjs';

const identity = () => ({ runId: randomUUID() });
async function sandbox(t, runIdentity = identity(), testHooks = undefined) {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-journal-'));
  const runDirectory = path.join(parent, runIdentity.runId);
  await mkdir(runDirectory, { mode: 0o700 });
  await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: runIdentity, startedAt: '2026-09-04T00:00:00.000Z' }), { flag: 'wx', mode: 0o600 });
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory,
    allowedPaths: (relative) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(relative), testHooks });
  t.after(() => writer.close());
  return { runDirectory, identity: runIdentity, writer };
}
async function membership(ctx, organizationId = 'org-a') {
  return appendBindingFixtureUnsafe({ ...ctx, role: 'identity', bindingId: 'membership',
    payload: { kind: 'organization-membership', organizationId, membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' },
    createdAt: '2026-09-04T00:00:01.000Z' });
}
const ref = ({ entry }) => ({ role: entry.role, bindingId: entry.bindingId, entrySha256: entry.entrySha256 });
const runtimeSelector = Object.freeze({ context: 'approved/context', namespace: 'runtime' });
function projectIntent(ctx, member, overrides = {}) {
  const intentId = 'project-create';
  const resourceName = deriveRunResourceName(ctx.identity, intentId);
  return { ...ctx, intentId, mutationKind: 'control-plane-create-project', bindingRefs: [ref(member)], resourceName,
    method: 'POST', routeTemplate: '/api/projects', relativeRoute: '/api/projects',
    recoverySelector: { kind: 'Project', organizationId: member.entry.payload.organizationId,
      slug: resourceName, runIdentitySha256: digest(ctx.identity) }, approvedRuntimeSelector: null,
    createdAt: '2026-09-04T00:00:02.000Z', deadlineAt: '2026-09-04T00:01:00.000Z',
    ...overrides };
}

test('Given a parsed binding, When appended twice exactly, Then committed bytes are idempotent and snapshotted', async (t) => {
  const ctx = await sandbox(t);
  const input = { ...ctx, role: 'identity', bindingId: 'membership',
    payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' },
    createdAt: '2026-09-04T00:00:01.000Z' };
  const first = await appendBindingFixtureUnsafe(input);
  const second = await appendBindingFixtureUnsafe(input);
  assert.equal(second.sha256, first.sha256);
  assert.equal((await bindingJournalSnapshotFixtureUnsafe(ctx)).entryCount, 1);
  assert.equal((await readdir(path.dirname(first.path))).length, 3);
  await assert.rejects(loadBindingsFixtureUnsafe({ ...ctx, parsePayload: () => { throw new Error('must not run'); } }),
    { reason: 'invalid_journal' });
});

test('Given concurrent appends through one writer, When serialized, Then chronology remains immutable', async (t) => {
  const ctx = await sandbox(t);
  await Promise.all([
    appendBindingFixtureUnsafe({ ...ctx, role: 'identity', bindingId: 'membership',
      payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' },
      createdAt: '2026-09-04T00:00:01.000Z' }),
    appendBindingFixtureUnsafe({ ...ctx, role: 'project', bindingId: 'primary',
      payload: { kind: 'project', projectId: 'project-a', organizationId: 'org-a' }, createdAt: '2026-09-04T00:00:02.000Z' }),
  ]);
  assert.deepEqual((await loadBindingsFixtureUnsafe(ctx)).map(({ sequence }) => sequence), [1, 2]);
});

test('Given an append in progress, When a runtime load starts on the same writer, Then readback waits for the commit', async (t) => {
  let enteredWrite; let releaseWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  const release = new Promise((resolve) => { releaseWrite = resolve; });
  let delayed = false;
  const ctx = await sandbox(t, identity(), { write: async (handle, bytes) => {
    if (!delayed) { delayed = true; enteredWrite(); await release; }
    await handle.writeFile(bytes);
  } });
  const append = membership(ctx);
  await entered;
  const load = loadBindingsFixtureUnsafe(ctx);
  releaseWrite();
  await append;
  assert.equal((await load).length, 1);
});

test('Given a forged writer-shaped object, When a journal API is called, Then the capability brand rejects it', async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(loadBindingsFixtureUnsafe({ ...ctx, writer: { writeJson: async () => ({}) } }),
    { reason: 'invalid_artifact_writer' });
});

test('Given a genuine writer and physical run, When one authority is created, Then consumers receive frozen serialized views', async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(loadBindingsFixtureUnsafe(ctx), { reason: 'invalid_journal' });
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory: ctx.runDirectory, identity: ctx.identity, genuineSafeWriter: ctx.writer });
  assert.equal(assertJournalAuthority(authority), authority);
  assert.deepEqual(await authority.loadBindings(), []);
  assert.equal((await authority.bindingSnapshot()).entryCount, 0);
  await authority.appendBinding({ role: 'identity', bindingId: 'membership',
    payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' },
    createdAt: '2026-09-04T00:00:01.000Z' });
  const entries = await authority.loadBindings();
  assert.equal(Object.isFrozen(entries), true);
  assert.equal(Object.isFrozen(entries[0].payload), true);
  assert.throws(() => assertJournalAuthority({}), { reason: 'invalid_journal_authority' });
  await assert.rejects(createJournalAuthorityFixtureUnsafe({ runDirectory: ctx.runDirectory, identity: ctx.identity,
    genuineSafeWriter: { writeJson: async () => ({}) } }), { reason: 'invalid_artifact_writer' });
  const foreign = await sandbox(t);
  await assert.rejects(createJournalAuthorityFixtureUnsafe({ runDirectory: ctx.runDirectory, identity: ctx.identity,
    genuineSafeWriter: foreign.writer }), { reason: 'invalid_artifact_writer' });
});

test('Given initialized journals with one directory missing, When authority reads, Then corruption is not treated as fresh', async (t) => {
  const ctx = await sandbox(t);
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory: ctx.runDirectory, identity: ctx.identity, genuineSafeWriter: ctx.writer });
  await rm(path.join(ctx.runDirectory, 'cleanup-intents'), { recursive: true });
  await assert.rejects(authority.loadCleanup({ approvedRuntimeSelector: null }), { reason: 'invalid_journal' });
});

test('Given an unknown binding shape, When appended, Then the internal strict schema rejects it', async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(appendBindingFixtureUnsafe({ ...ctx, role: 'identity', bindingId: 'membership', payload: {}, createdAt: '2026-09-04T00:00:01.000Z' }), { reason: 'invalid_journal' });
});

test('Given canonical binding kinds, When journaled, Then exact provenance round-trips and malformed contracts fail', async (t) => {
  const ctx = await sandbox(t); const appended = [];
  for (const [index, payload] of releaseBindings.entries()) {
    appended.push(await appendBindingFixtureUnsafe({ ...ctx, role: payload.kind, bindingId: `entry-${index}`, payload,
      createdAt: `2026-09-04T00:00:${String(index + 1).padStart(2, '0')}.000Z` }));
  }
  assert.deepEqual((await loadBindingsFixtureUnsafe(ctx)).map(({ payload }) => payload), releaseBindings);
  const deleteIntentId = 'full-ledger-project-delete';
  const deleteName = deriveRunResourceName(ctx.identity, deleteIntentId);
  await appendCleanupIntentFixtureUnsafe({ ...ctx, intentId: deleteIntentId, mutationKind: 'control-plane-delete-project',
    bindingRefs: [ref(appended[0]), ref(appended[4])], resourceName: deleteName, method: 'DELETE',
    routeTemplate: '/api/projects/:projectId', relativeRoute: '/api/projects/project-1', approvedRuntimeSelector: null,
    recoverySelector: { kind: 'Project', organizationId: 'org-1', projectId: 'project-1', name: deleteName,
      runIdentitySha256: digest(ctx.identity) }, createdAt: '2026-09-04T00:00:40.000Z', deadlineAt: '2026-09-04T00:01:00.000Z' });
  for (const payload of [
    { ...releaseBindings[1], repository: 'missing-slash' },
    { ...releaseBindings[2], tenantCommitSha: 'x' },
    { ...releaseBindings[6], unexpected: 'field' },
  ]) {
    await assert.rejects(appendBindingFixtureUnsafe({ ...ctx, role: 'malformed', bindingId: randomUUID(), payload,
      createdAt: '2026-09-04T00:00:59.000Z' }), { reason: 'invalid_journal' });
  }
  const entries = await loadBindingsFixtureUnsafe(ctx);
  const malformedProject = { ...entries[4], payload: { ...entries[4].payload, unexpected: 'rejected' } };
  malformedProject.payloadSha256 = digest(malformedProject.payload);
  const { entrySha256: oldProjectSha, ...projectUnsigned } = malformedProject;
  malformedProject.entrySha256 = digest(projectUnsigned);
  assert.throws(() => resolveBindingGraph([...entries.slice(0, 4), malformedProject],
    [...entries.slice(0, 4), malformedProject].map(({ role, bindingId, entrySha256 }) => ({ role, bindingId, entrySha256 }))),
  { reason: 'invalid_journal' });
  let payloadReads = 0;
  const mutableMembership = { ...entries[0] };
  Object.defineProperty(mutableMembership, 'payload', { enumerable: true,
    get: () => (++payloadReads <= 4 ? entries[0].payload : { ...entries[0].payload, organizationId: 'org-b' }) });
  const crossTenantProject = { ...entries[4], payload: { ...entries[4].payload, organizationId: 'org-b' } };
  crossTenantProject.payloadSha256 = digest(crossTenantProject.payload);
  const { entrySha256: oldCrossTenantSha, ...crossTenantUnsigned } = crossTenantProject;
  crossTenantProject.entrySha256 = digest(crossTenantUnsigned);
  const hostileEntries = [mutableMembership, ...entries.slice(1, 4), crossTenantProject];
  assert.throws(() => resolveBindingGraph(hostileEntries,
    hostileEntries.map(({ role, bindingId, entrySha256 }) => ({ role, bindingId, entrySha256 }))), { reason: 'invalid_journal' });
  const badDeployment = { ...entries[6], payload: { ...entries[6].payload, tenantCommitSha: '3'.repeat(40) } };
  badDeployment.payloadSha256 = digest(badDeployment.payload);
  const { entrySha256: ignored, ...unsigned } = badDeployment;
  badDeployment.entrySha256 = digest(unsigned);
  assert.throws(() => resolveBindingGraph([...entries.slice(0, 6), badDeployment],
    [...entries.slice(0, 6), badDeployment].map(({ role, bindingId, entrySha256 }) => ({ role, bindingId, entrySha256 }))),
  { reason: 'invalid_binding_graph' });
});

test('Given conflicting, spliced, or noncanonical binding state, When loaded, Then validation fails closed', async (t) => {
  const source = await sandbox(t);
  await membership(source);
  await assert.rejects(membership(source, 'org-b'), { reason: 'binding_conflict' });

  const destination = await sandbox(t);
  const destinationBindings = path.join(destination.runDirectory, 'bindings');
  await mkdir(destinationBindings);
  for (const name of await readdir(path.join(source.runDirectory, 'bindings'))) {
    await copyFile(path.join(source.runDirectory, 'bindings', name), path.join(destinationBindings, name));
  }
  await assert.rejects(loadBindingsFixtureUnsafe(destination), { reason: 'invalid_journal' });

  const noncanonical = `${source.runDirectory}${path.sep}..${path.sep}${source.identity.runId}`;
  await assert.rejects(loadBindingsFixtureUnsafe({ ...source, runDirectory: noncanonical }), { reason: 'invalid_journal' });
});

test('Given a cross-tenant project binding, When an intent resolves its graph, Then the foreign edge is rejected', async (t) => {
  const ctx = await sandbox(t);
  const member = await membership(ctx);
  const project = await appendBindingFixtureUnsafe({ ...ctx, role: 'project', bindingId: 'primary',
    payload: { kind: 'project', projectId: 'foreign-project', organizationId: 'org-b' }, createdAt: '2026-09-04T00:00:02.000Z' });
  const intentId = 'project-delete';
  const resourceName = deriveRunResourceName(ctx.identity, intentId);
  await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...projectIntent(ctx, member), intentId, mutationKind: 'control-plane-delete-project',
    bindingRefs: [ref(member), ref(project)], resourceName, method: 'DELETE', routeTemplate: '/api/projects/:projectId',
    relativeRoute: '/api/projects/foreign-project', createdAt: '2026-09-04T00:00:03.000Z',
    recoverySelector: { kind: 'Project', organizationId: 'org-b', projectId: 'foreign-project', name: resourceName, runIdentitySha256: digest(ctx.identity) } }),
  { reason: 'invalid_binding_graph' });
});

test('Given a foreign production Pod selector, When its name is not run-derived, Then intent persistence is rejected', async (t) => {
  const ctx = await sandbox(t);
  const member = await membership(ctx);
  const name = `raibit-evidence-client-${ctx.identity.runId}`;
  await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...projectIntent(ctx, member), intentId: 'client-pod', mutationKind: 'kubernetes-apply-pod',
    resourceName: name, method: 'APPLY', routeTemplate: '/api/v1/namespaces/:namespace/pods',
    relativeRoute: '/api/v1/namespaces/runtime/pods', approvedRuntimeSelector: runtimeSelector,
    recoverySelector: { kind: 'Pod', namespace: 'runtime', name: 'production-api', runLabel: ctx.identity.runId,
      runIdentitySha256: digest(ctx.identity), runtimeSelectorSha256: digest(runtimeSelector) } }), { reason: 'invalid_recovery_selector' });
});

test('Given a client Pod and NetworkPolicy, When intents are stored, Then exact run and runtime scope is bound', async (t) => {
  const ctx = await sandbox(t);
  const member = await membership(ctx);
  for (const [intentId, mutationKind, kind, suffix, relativeRoute] of [
    ['client-pod', 'kubernetes-apply-pod', 'Pod', '', '/api/v1/namespaces/runtime/pods'],
    ['client-policy', 'kubernetes-apply-network-policy', 'NetworkPolicy', '-egress', '/apis/networking.k8s.io/v1/namespaces/runtime/networkpolicies'],
  ]) {
    const name = `raibit-evidence-client-${ctx.identity.runId}${suffix}`;
    await appendCleanupIntentFixtureUnsafe({ ...projectIntent(ctx, member), intentId, mutationKind, resourceName: name, relativeRoute,
      method: 'APPLY', routeTemplate: kind === 'Pod' ? '/api/v1/namespaces/:namespace/pods' : '/apis/networking.k8s.io/v1/namespaces/:namespace/networkpolicies',
      approvedRuntimeSelector: runtimeSelector, createdAt: intentId === 'client-pod' ? '2026-09-04T00:00:02.000Z' : '2026-09-04T00:00:03.000Z',
      recoverySelector: { kind, namespace: runtimeSelector.namespace, name, runLabel: ctx.identity.runId,
        runIdentitySha256: digest(ctx.identity), runtimeSelectorSha256: digest(runtimeSelector) } });
  }
  assert.equal((await loadCleanupJournalFixtureUnsafe({ ...ctx, approvedRuntimeSelector: runtimeSelector })).pending.length, 2);
});

test('Given an interrupted write, When exact append is retried, Then the poisoned path is neither reused nor deleted', async (t) => {
  const ctx = await sandbox(t, identity(), { write: async () => { throw new Error('injected'); } });
  const input = { ...ctx, role: 'identity', bindingId: 'membership',
    payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' },
    createdAt: '2026-09-04T00:00:01.000Z' };
  await assert.rejects(appendBindingFixtureUnsafe(input), { reason: 'journal_write_poisoned' });
  const namesBefore = await readdir(path.join(ctx.runDirectory, 'bindings'));
  await assert.rejects(appendBindingFixtureUnsafe(input), { reason: 'journal_write_poisoned' });
  assert.deepEqual(await readdir(path.join(ctx.runDirectory, 'bindings')), namesBefore);
});

test('Given a lost mutation response, When recovery sees exactly the bound selector, Then only it is eligible', async (t) => {
  const ctx = await sandbox(t);
  const member = await membership(ctx);
  const input = projectIntent(ctx, member);
  const intent = await appendCleanupIntentFixtureUnsafe(input);
  const bindingEntries = await loadBindingsFixtureUnsafe(ctx);
  const recovery = { intent, bindingEntries, identity: ctx.identity, approvedRuntimeSelector: null,
    candidates: [{ id: 'created-project', uid: 'project-uid', selector: intent.recoverySelector }] };
  assert.equal(resolveCleanupRecovery(recovery).candidate.id, 'created-project');
  assert.deepEqual(resolveCleanupRecovery({ ...recovery, candidates: [] }), { status: 'absent' });
  assert.throws(() => resolveCleanupRecovery({ ...recovery, candidates: [...recovery.candidates, ...recovery.candidates] }), { reason: 'ambiguous_recovery' });
  assert.throws(() => resolveCleanupRecovery({ ...recovery,
    candidates: [{ ...recovery.candidates[0], selector: { ...intent.recoverySelector, slug: 'foreign-project' } }] }), { reason: 'recovery_mismatch' });
});

test('Given a resolved mutation, When snapshotted, Then graph and response digest remain immutable', async (t) => {
  const ctx = await sandbox(t);
  const member = await membership(ctx);
  const input = projectIntent(ctx, member);
  const intent = await appendCleanupIntentFixtureUnsafe(input);
  const outcomeInput = { ...ctx, intentId: intent.intentId, actualId: 'project-id', actualUid: null, responseSha256: 'a'.repeat(64),
    resolvedAt: '2026-09-04T00:00:03.000Z', approvedRuntimeSelector: null };
  await appendCleanupOutcomeFixtureUnsafe(outcomeInput);
  const snapshot = await productionEvidenceJournalSnapshotFixtureUnsafe({ ...ctx, approvedRuntimeSelector: null });
  assert.match(snapshot.journalSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(appendCleanupOutcomeFixtureUnsafe({ ...outcomeInput, actualId: 'foreign' }), { reason: 'outcome_conflict' });
});

test('Given backup and restore bindings, When mutation intents are parsed, Then every exact method and route is graph-bound', async (t) => {
  const ctx = await sandbox(t); const member = await membership(ctx);
  const records = [];
  for (const [role, bindingId, payload, createdAt] of [
    ['project', 'primary', { kind: 'project', projectId: 'project-a', organizationId: 'org-a' }, '2026-09-04T00:00:02.000Z'],
    ['resource', 'source', { kind: 'resource', role: 'source', engine: 'postgresql', resourceId: 'resource-source', projectId: 'project-a' }, '2026-09-04T00:00:03.000Z'],
    ['backup', 'source', { kind: 'backup', engine: 'postgresql', backupId: 'backup-a', sourceResourceId: 'resource-source' }, '2026-09-04T00:00:04.000Z'],
    ['resource', 'target', { kind: 'resource', role: 'restore-target', engine: 'postgresql', resourceId: 'resource-target', projectId: 'project-a' }, '2026-09-04T00:00:05.000Z'],
  ]) records.push(await appendBindingFixtureUnsafe({ ...ctx, role, bindingId, payload, createdAt }));
  const [project, source, backup, target] = records; const common = [ref(member), ref(project)];
  const cases = [
    ['backup-create', 'control-plane-create-backup', [ref(source)], 'POST', '/api/resources/:resourceId/backups', '/api/resources/resource-source/backups',
      { kind: 'Backup', projectId: 'project-a', resourceId: 'resource-source', engine: 'postgresql' }],
    ['restore-create', 'control-plane-create-restore', [ref(source), ref(backup)], 'POST', '/api/backups/:backupId/restores', '/api/backups/backup-a/restores',
      { kind: 'Restore', projectId: 'project-a', backupId: 'backup-a', engine: 'postgresql' }],
    ['backup-delete', 'control-plane-delete-backup', [ref(source), ref(backup)], 'DELETE', '/api/backups/:backupId', '/api/backups/backup-a',
      { kind: 'Backup', projectId: 'project-a', resourceId: 'resource-source', backupId: 'backup-a', engine: 'postgresql' }],
    ['target-delete', 'control-plane-delete-restore-target', [ref(target)], 'DELETE', '/api/resources/:resourceId', '/api/resources/resource-target',
      { kind: 'Resource', projectId: 'project-a', resourceId: 'resource-target', role: 'restore-target', engine: 'postgresql' }],
  ];
  for (const [index, [intentId, mutationKind, refs, method, routeTemplate, relativeRoute, selector]] of cases.entries()) {
    const resourceName = deriveRunResourceName(ctx.identity, intentId);
    const input = { ...ctx, intentId, mutationKind, bindingRefs: [...common, ...refs], resourceName, method, routeTemplate, relativeRoute,
      recoverySelector: { ...selector, name: resourceName, runIdentitySha256: digest(ctx.identity) }, approvedRuntimeSelector: null,
      createdAt: `2026-09-04T00:00:${String(index + 6).padStart(2, '0')}.000Z`, deadlineAt: '2026-09-04T00:01:00.000Z' };
    if (index === 0) await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...input, method: 'DELETE' }), { reason: 'invalid_mutation_contract' });
    if (mutationKind === 'control-plane-create-restore') {
      await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...input,
        routeTemplate: '/api/backups/:backupId/restore', relativeRoute: '/api/backups/backup-a/restore' }), { reason: 'invalid_mutation_contract' });
      await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...input, bindingRefs: [...input.bindingRefs, ref(target)],
        recoverySelector: { ...input.recoverySelector, targetResourceId: 'resource-target' } }), { reason: 'invalid_recovery_selector' });
    }
    await appendCleanupIntentFixtureUnsafe(input);
  }
});

test('Given no restore target yet, When restore is requested, Then intent precedes server-created target bindings and outcome', async (t) => {
  const ctx = await sandbox(t); const member = await membership(ctx);
  const project = await appendBindingFixtureUnsafe({ ...ctx, role: 'project', bindingId: 'primary',
    payload: { kind: 'project', projectId: 'project-a', organizationId: 'org-a' }, createdAt: '2026-09-04T00:00:02.000Z' });
  const source = await appendBindingFixtureUnsafe({ ...ctx, role: 'resource', bindingId: 'source',
    payload: { kind: 'resource', role: 'source', engine: 'postgresql', resourceId: 'resource-source', projectId: 'project-a' },
    createdAt: '2026-09-04T00:00:03.000Z' });
  const backup = await appendBindingFixtureUnsafe({ ...ctx, role: 'backup', bindingId: 'source',
    payload: { kind: 'backup', engine: 'postgresql', backupId: 'backup-a', sourceResourceId: 'resource-source' },
    createdAt: '2026-09-04T00:00:04.000Z' });
  const intentId = 'restore-before-target'; const resourceName = deriveRunResourceName(ctx.identity, intentId);
  const input = { ...ctx, intentId, mutationKind: 'control-plane-create-restore',
    bindingRefs: [ref(member), ref(project), ref(source), ref(backup)], resourceName, method: 'POST',
    routeTemplate: '/api/backups/:backupId/restores', relativeRoute: '/api/backups/backup-a/restores', approvedRuntimeSelector: null,
    recoverySelector: { kind: 'Restore', projectId: 'project-a', backupId: 'backup-a', engine: 'postgresql', name: resourceName,
      runIdentitySha256: digest(ctx.identity) }, createdAt: '2026-09-04T00:00:05.000Z', deadlineAt: '2026-09-04T00:01:00.000Z' };
  await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...input,
    recoverySelector: { ...input.recoverySelector, targetResourceId: 'caller-forged' } }), { reason: 'invalid_recovery_selector' });
  const intent = await appendCleanupIntentFixtureUnsafe(input);
  await appendBindingFixtureUnsafe({ ...ctx, role: 'resource', bindingId: 'restore-target',
    payload: { kind: 'resource', role: 'restore-target', engine: 'postgresql', resourceId: 'resource-target', projectId: 'project-a' },
    createdAt: '2026-09-04T00:00:06.000Z' });
  await appendBindingFixtureUnsafe({ ...ctx, role: 'restore', bindingId: 'restore-a',
    payload: { kind: 'restore', engine: 'postgresql', restoreId: 'restore-a', backupId: 'backup-a', targetResourceId: 'resource-target' },
    createdAt: '2026-09-04T00:00:07.000Z' });
  await assert.rejects(appendCleanupOutcomeFixtureUnsafe({ ...ctx, intentId: intent.intentId, actualId: 'foreign-restore', actualUid: null,
    responseSha256: 'b'.repeat(64), resolvedAt: '2026-09-04T00:00:08.000Z', approvedRuntimeSelector: null }), { reason: 'outcome_conflict' });
  await appendCleanupOutcomeFixtureUnsafe({ ...ctx, intentId: intent.intentId, actualId: 'restore-a', actualUid: null,
    responseSha256: 'b'.repeat(64), resolvedAt: '2026-09-04T00:00:08.000Z', approvedRuntimeSelector: null });
  assert.equal((await loadCleanupJournalFixtureUnsafe({ ...ctx, approvedRuntimeSelector: null })).resolved.length, 1);
});

test('Given secret content or a junction escape, When persistence is attempted, Then durable commit fails', async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(appendBindingFixtureUnsafe({ ...ctx, role: 'repository', bindingId: 'primary',
    payload: { kind: 'github-repository', installationId: 'installation-a', repositoryId: 'repo-a',
      repository: 'github_pat_abcdefghijklmnop/repo', branch: 'main' },
    createdAt: '2026-09-04T00:00:01.000Z' }), { reason: 'redaction' });
  const outside = await mkdtemp(path.join(tmpdir(), 'raibit-journal-outside-'));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(ctx.runDirectory, 'bindings'), 'junction');
  await assert.rejects(loadBindingsFixtureUnsafe(ctx), { reason: 'invalid_journal' });
});

test('Given writer and transaction markers, When verifier classification is imported through the journal, Then only metadata is private', () => {
  assert.equal(isPrivateJournalMetadata(PRIVATE_WRITER_SESSION_PATH), true);
  assert.equal(isPrivateJournalMetadata('bindings/000001--0123456789abcdef.json.pending'), true);
  assert.equal(isPrivateJournalMetadata('cleanup-intents/000001--intent--0123456789ab.json.commit'), true);
  assert.equal(isPrivateJournalMetadata('bindings/000001--0123456789abcdef.json'), false);
});

test('Given Windows release mode, When the sole run writer starts, Then it fails closed', { skip: process.platform !== 'win32' }, async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(createSafeArtifactWriter({ runDirectory: ctx.runDirectory, allowedPaths: ['bindings/record.json'] }),
    { reason: 'artifact_platform_not_release_safe' });
});

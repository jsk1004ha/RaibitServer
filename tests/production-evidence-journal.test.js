import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendBindingFixtureUnsafe, bindingJournalSnapshotFixtureUnsafe, isPrivateJournalMetadata, loadBindingsFixtureUnsafe } from '../scripts/production-evidence/lib/binding-journal.mjs';
import {
  appendCleanupIntentFixtureUnsafe, appendCleanupOutcomeFixtureUnsafe, deriveRunResourceName,
  loadCleanupJournalFixtureUnsafe, productionEvidenceJournalSnapshotFixtureUnsafe, resolveCleanupRecovery,
} from '../scripts/production-evidence/lib/cleanup-intent-journal.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { createSafeArtifactWriter, createUnsafeFixtureArtifactWriter, PRIVATE_WRITER_SESSION_PATH } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';

const pass = (value) => value;
const parseBinding = (value) => value && ['organization-membership', 'project', 'service', 'resource', 'backup', 'restore'].includes(value.kind) ? value : undefined;
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
  return appendBindingFixtureUnsafe({ ...ctx, role: 'identity', bindingId: 'membership', parsePayload: parseBinding,
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
    parseBinding, parseIntent: pass, parseOutcome: pass, ...overrides };
}

test('Given a parsed binding, When appended twice exactly, Then committed bytes are idempotent and snapshotted', async (t) => {
  const ctx = await sandbox(t);
  const input = { ...ctx, role: 'identity', bindingId: 'membership', parsePayload: parseBinding,
    payload: { kind: 'organization-membership', organizationId: 'org-a', membershipId: 'membership-a', userId: 'user-a', role: 'OWNER' },
    createdAt: '2026-09-04T00:00:01.000Z' };
  const first = await appendBindingFixtureUnsafe(input);
  const second = await appendBindingFixtureUnsafe(input);
  assert.equal(second.sha256, first.sha256);
  assert.equal((await bindingJournalSnapshotFixtureUnsafe({ ...ctx, parsePayload: parseBinding })).entryCount, 1);
  assert.equal((await readdir(path.dirname(first.path))).length, 3);
});

test('Given no schema parser, When journal APIs are called, Then permissive payload acceptance is forbidden', async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(appendBindingFixtureUnsafe({ ...ctx, role: 'identity', bindingId: 'membership', payload: {}, createdAt: '2026-09-04T00:00:01.000Z' }), { reason: 'invalid_journal' });
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
  await assert.rejects(loadBindingsFixtureUnsafe({ ...destination, parsePayload: parseBinding }), { reason: 'invalid_journal' });

  const noncanonical = `${source.runDirectory}${path.sep}..${path.sep}${source.identity.runId}`;
  await assert.rejects(loadBindingsFixtureUnsafe({ ...source, runDirectory: noncanonical, parsePayload: parseBinding }), { reason: 'invalid_journal' });
});

test('Given a cross-tenant project binding, When an intent resolves its graph, Then the foreign edge is rejected', async (t) => {
  const ctx = await sandbox(t);
  const member = await membership(ctx);
  const project = await appendBindingFixtureUnsafe({ ...ctx, role: 'project', bindingId: 'primary', parsePayload: parseBinding,
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
  assert.equal((await loadCleanupJournalFixtureUnsafe({ ...ctx, parseBinding, parseIntent: pass, parseOutcome: pass, approvedRuntimeSelector: runtimeSelector })).pending.length, 2);
});

test('Given an interrupted write, When exact append is retried, Then the poisoned path is neither reused nor deleted', async (t) => {
  const ctx = await sandbox(t, identity(), { write: async () => { throw new Error('injected'); } });
  const input = { ...ctx, role: 'identity', bindingId: 'membership', parsePayload: parseBinding,
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
  const bindingEntries = await loadBindingsFixtureUnsafe({ ...ctx, parsePayload: parseBinding });
  const recovery = { intent, bindingEntries, identity: ctx.identity, approvedRuntimeSelector: null, parseBinding,
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
    resolvedAt: '2026-09-04T00:00:03.000Z', parseBinding, parseIntent: pass, parseOutcome: pass, approvedRuntimeSelector: null };
  await appendCleanupOutcomeFixtureUnsafe(outcomeInput);
  const snapshot = await productionEvidenceJournalSnapshotFixtureUnsafe({ ...ctx, parseBinding, parseIntent: pass, parseOutcome: pass, approvedRuntimeSelector: null });
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
  ]) records.push(await appendBindingFixtureUnsafe({ ...ctx, role, bindingId, payload, createdAt, parsePayload: parseBinding }));
  const [project, source, backup, target] = records; const common = [ref(member), ref(project)];
  const cases = [
    ['backup-create', 'control-plane-create-backup', [ref(source)], 'POST', '/api/resources/:resourceId/backups', '/api/resources/resource-source/backups',
      { kind: 'Backup', projectId: 'project-a', resourceId: 'resource-source', engine: 'postgresql' }],
    ['restore-create', 'control-plane-create-restore', [ref(source), ref(backup), ref(target)], 'POST', '/api/backups/:backupId/restore', '/api/backups/backup-a/restore',
      { kind: 'Restore', projectId: 'project-a', backupId: 'backup-a', targetResourceId: 'resource-target', engine: 'postgresql' }],
    ['backup-delete', 'control-plane-delete-backup', [ref(source), ref(backup)], 'DELETE', '/api/backups/:backupId', '/api/backups/backup-a',
      { kind: 'Backup', projectId: 'project-a', resourceId: 'resource-source', backupId: 'backup-a', engine: 'postgresql' }],
    ['target-delete', 'control-plane-delete-restore-target', [ref(target)], 'DELETE', '/api/resources/:resourceId', '/api/resources/resource-target',
      { kind: 'Resource', projectId: 'project-a', resourceId: 'resource-target', role: 'restore-target', engine: 'postgresql' }],
  ];
  for (const [index, [intentId, mutationKind, refs, method, routeTemplate, relativeRoute, selector]] of cases.entries()) {
    const resourceName = deriveRunResourceName(ctx.identity, intentId);
    const input = { ...ctx, intentId, mutationKind, bindingRefs: [...common, ...refs], resourceName, method, routeTemplate, relativeRoute,
      recoverySelector: { ...selector, name: resourceName, runIdentitySha256: digest(ctx.identity) }, approvedRuntimeSelector: null,
      createdAt: `2026-09-04T00:00:${String(index + 6).padStart(2, '0')}.000Z`, deadlineAt: '2026-09-04T00:01:00.000Z', parseBinding, parseIntent: pass, parseOutcome: pass };
    if (index === 0) await assert.rejects(appendCleanupIntentFixtureUnsafe({ ...input, method: 'DELETE' }), { reason: 'invalid_mutation_contract' });
    await appendCleanupIntentFixtureUnsafe(input);
  }
});

test('Given secret content or a junction escape, When persistence is attempted, Then durable commit fails', async (t) => {
  const ctx = await sandbox(t);
  await assert.rejects(appendBindingFixtureUnsafe({ ...ctx, role: 'identity', bindingId: 'membership', parsePayload: pass,
    payload: { token: 'github_pat_abcdefghijklmnop' }, createdAt: '2026-09-04T00:00:01.000Z' }), { reason: 'redaction' });
  const outside = await mkdtemp(path.join(tmpdir(), 'raibit-journal-outside-'));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(ctx.runDirectory, 'bindings'), 'junction');
  await assert.rejects(loadBindingsFixtureUnsafe({ ...ctx, parsePayload: parseBinding }), { reason: 'invalid_journal' });
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

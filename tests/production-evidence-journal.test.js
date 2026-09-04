import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendBinding,
  bindingJournalSnapshot,
  loadBindings,
  reduceBindings,
} from '../scripts/production-evidence/lib/binding-journal.mjs';
import {
  appendCleanupIntent,
  appendCleanupOutcome,
  cleanupJournalSnapshot,
  loadCleanupJournal,
  productionEvidenceJournalSnapshot,
  resolveCleanupRecovery,
} from '../scripts/production-evidence/lib/cleanup-intent-journal.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';

const identity = () => ({ runId: randomUUID(), organizationId: 'org-a', projectId: 'project-a' });
async function sandbox(t, runIdentity = identity()) {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-journal-'));
  const runDirectory = path.join(parent, runIdentity.runId);
  await mkdir(runDirectory, { mode: 0o700 });
  await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: runIdentity, startedAt: '2026-09-04T00:00:00.000Z' }), { flag: 'wx', mode: 0o600 });
  t.after(async () => rm(parent, { recursive: true, force: true }));
  return { runDirectory, runIdentity };
}

test('Given a run-bound binding, When appended twice exactly, Then physical append-once bytes are idempotent', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  const input = { runDirectory, identity: runIdentity, role: 'project', bindingId: 'primary', payload: { id: 'project-123' }, createdAt: '2026-09-04T00:00:01.000Z' };
  const first = await appendBinding(input);
  const bytes = await readFile(first.path);
  const second = await appendBinding(input);
  assert.equal(second.sha256, digest(bytes));
  const parsed = await loadBindings({ runDirectory, identity: runIdentity, parsePayload: (value) => value.id === 'project-123' ? value : undefined });
  assert.deepEqual(reduceBindings(parsed), { 'project:primary': { id: 'project-123' } });
  assert.equal((await bindingJournalSnapshot({ runDirectory, identity: runIdentity })).entryCount, 1);
});

test('Given an existing logical binding, When reassigned or journal order is spliced, Then loading fails closed', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  await appendBinding({ runDirectory, identity: runIdentity, role: 'project', bindingId: 'primary', payload: { id: 'one' }, createdAt: '2026-09-04T00:00:01.000Z' });
  await assert.rejects(appendBinding({ runDirectory, identity: runIdentity, role: 'project', bindingId: 'primary', payload: { id: 'two' }, createdAt: '2026-09-04T00:00:02.000Z' }), { reason: 'binding_conflict' });
  const bindings = path.join(runDirectory, 'bindings');
  const [name] = await (await import('node:fs/promises')).readdir(bindings);
  const value = JSON.parse(await readFile(path.join(bindings, name), 'utf8'));
  await writeFile(path.join(bindings, name.replace('000001', '000002')), `${JSON.stringify({ ...value, sequence: 2 })}\n`);
  await assert.rejects(loadBindings({ runDirectory, identity: runIdentity }), { reason: 'journal_digest_mismatch' });
});

test('Given valid bytes from another run, When copied into this run journal, Then run identity binding rejects the splice', async (t) => {
  const first = await sandbox(t);
  const second = await sandbox(t);
  const descriptor = await appendBinding({ runDirectory: first.runDirectory, identity: first.runIdentity, role: 'project', bindingId: 'primary', payload: { id: 'one' }, createdAt: '2026-09-04T00:00:01.000Z' });
  const target = path.join(second.runDirectory, 'bindings');
  await mkdir(target);
  await writeFile(path.join(target, path.basename(descriptor.path)), await readFile(descriptor.path));
  await assert.rejects(loadBindings({ runDirectory: second.runDirectory, identity: second.runIdentity }), { reason: 'invalid_journal' });
});

test('Given a journal path or symlink escape, When accessed, Then it is rejected before reading or writing', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  await assert.rejects(appendBinding({ runDirectory: path.join(runDirectory, '..', runIdentity.runId, 'missing'), identity: runIdentity, role: 'project', bindingId: 'primary', payload: { id: 'one' }, createdAt: '2026-09-04T00:00:01.000Z' }), { reason: 'invalid_journal' });
  const outside = await mkdtemp(path.join(tmpdir(), 'raibit-journal-outside-'));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(runDirectory, 'bindings'), 'junction');
  await assert.rejects(loadBindings({ runDirectory, identity: runIdentity }), { reason: 'invalid_journal' });
});

test('Given a lost create response, When exact-selector recovery finds one object, Then only that object is eligible', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  const intent = await appendCleanupIntent({ runDirectory, identity: runIdentity, intentId: 'client-pod', mutationKind: 'kubernetes-apply-pod',
    organizationId: 'org-a', projectId: 'project-a', resourceName: `evidence-${runIdentity.runId}`,
    relativeRoute: '/api/v1/namespaces/runtime/pods', recoverySelector: { namespace: 'runtime', name: `evidence-${runIdentity.runId}`, runId: runIdentity.runId },
    createdAt: '2026-09-04T00:00:01.000Z', deadlineAt: '2026-09-04T00:01:00.000Z' });
  const journal = await loadCleanupJournal({ runDirectory, identity: runIdentity });
  assert.equal(journal.pending.length, 1);
  await assert.rejects(loadCleanupJournal({ runDirectory, identity: runIdentity, parseIntent: () => undefined }), { reason: 'invalid_journal' });
  assert.deepEqual(resolveCleanupRecovery(intent, [{ id: 'pod-id', uid: 'pod-uid', selector: intent.recoverySelector }]), { status: 'exact', candidate: { id: 'pod-id', uid: 'pod-uid', selector: intent.recoverySelector } });
  assert.deepEqual(resolveCleanupRecovery(intent, []), { status: 'absent' });
});

test('Given ambiguous or mismatched recovery results, When evaluated, Then broad deletion is forbidden', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  const intent = await appendCleanupIntent({ runDirectory, identity: runIdentity, intentId: 'client-policy', mutationKind: 'kubernetes-apply-network-policy',
    organizationId: 'org-a', projectId: 'project-a', resourceName: `evidence-${runIdentity.runId}-egress`, relativeRoute: '/apis/networking.k8s.io/v1/namespaces/runtime/networkpolicies',
    recoverySelector: { namespace: 'runtime', name: `evidence-${runIdentity.runId}-egress`, runId: runIdentity.runId }, createdAt: '2026-09-04T00:00:01.000Z', deadlineAt: '2026-09-04T00:01:00.000Z' });
  assert.throws(() => resolveCleanupRecovery(intent, [{ id: 'a', uid: '1', selector: intent.recoverySelector }, { id: 'b', uid: '2', selector: intent.recoverySelector }]), { reason: 'ambiguous_recovery' });
  assert.throws(() => resolveCleanupRecovery(intent, [{ id: 'a', uid: '1', selector: { ...intent.recoverySelector, name: 'foreign' } }]), { reason: 'recovery_mismatch' });
});

test('Given a resolved mutation, When its outcome is appended, Then actual identity and response digest remain immutable', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  const intent = await appendCleanupIntent({ runDirectory, identity: runIdentity, intentId: 'project-create', mutationKind: 'control-plane-create-project',
    organizationId: 'org-a', projectId: 'project-a', resourceName: `evidence-${runIdentity.runId}`, relativeRoute: '/api/projects',
    recoverySelector: { organizationId: 'org-a', slug: `evidence-${runIdentity.runId}` }, createdAt: '2026-09-04T00:00:01.000Z', deadlineAt: '2026-09-04T00:01:00.000Z' });
  await appendCleanupOutcome({ runDirectory, identity: runIdentity, intentId: intent.intentId, actualId: 'project-id', actualUid: null,
    responseSha256: 'a'.repeat(64), resolvedAt: '2026-09-04T00:00:02.000Z' });
  const journal = await loadCleanupJournal({ runDirectory, identity: runIdentity });
  assert.equal(journal.pending.length, 0);
  assert.equal(journal.resolved[0].outcome.actualId, 'project-id');
  assert.equal((await cleanupJournalSnapshot({ runDirectory, identity: runIdentity })).entryCount, 2);
  await appendBinding({ runDirectory, identity: runIdentity, role: 'project', bindingId: 'primary', payload: { id: 'project-id' }, createdAt: '2026-09-04T00:00:03.000Z' });
  assert.match((await productionEvidenceJournalSnapshot({ runDirectory, identity: runIdentity })).journalSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(appendCleanupOutcome({ runDirectory, identity: runIdentity, intentId: intent.intentId, actualId: 'other', actualUid: null,
    responseSha256: 'b'.repeat(64), resolvedAt: '2026-09-04T00:00:03.000Z' }), { reason: 'outcome_conflict' });
});

test('Given secret-shaped journal payload, When append is attempted, Then no file is persisted', async (t) => {
  const { runDirectory, runIdentity } = await sandbox(t);
  await assert.rejects(appendBinding({ runDirectory, identity: runIdentity, role: 'project', bindingId: 'primary', payload: { token: 'github_pat_abcdefghijklmnop' }, createdAt: '2026-09-04T00:00:01.000Z' }), { reason: 'redaction' });
  await assert.rejects(loadBindings({ runDirectory, identity: runIdentity }), { reason: 'invalid_journal' });
});

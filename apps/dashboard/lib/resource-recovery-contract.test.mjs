import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Given a failed backup request, when it is retried, then it keeps its idempotency key and a completed request gets a new one', async () => {
  const { resolveRecoveryIntent } = await import('./recovery-idempotency.ts');
  const backupKeys = ['backup-next'].values();
  const createKey = () => {
    const next = backupKeys.next();
    if (next.done) throw new Error('fixture_key_exhausted');
    return next.value;
  };
  const failedBackup = { key: 'backup-first', payload: 'backup-v1' };
  const retry = resolveRecoveryIntent(failedBackup, 'backup-v1', 'backup', createKey);
  const nextBackup = resolveRecoveryIntent({ key: 'backup-completed', payload: '' }, 'backup-v1', 'backup', createKey);

  assert.equal(retry.key, 'backup-first');
  assert.equal(nextBackup.key, 'backup-next');
});

test('Given a failed restore request, when the same name is retried or a different name is submitted, then only the new name gets a new key', async () => {
  const { resolveRecoveryIntent } = await import('./recovery-idempotency.ts');
  const restoreKeys = ['restore-next-name'].values();
  const createKey = () => {
    const next = restoreKeys.next();
    if (next.done) throw new Error('fixture_key_exhausted');
    return next.value;
  };
  const failedRestore = { key: 'restore-first', payload: 'restored-primary' };
  const retryRestore = resolveRecoveryIntent(failedRestore, 'restored-primary', 'restore', createKey);
  const renamedRestore = resolveRecoveryIntent(failedRestore, 'restored-secondary', 'restore', createKey);

  assert.equal(retryRestore.key, 'restore-first');
  assert.equal(renamedRestore.key, 'restore-next-name');
});

test('Given a READY backup with malformed expiry, when recovery eligibility is evaluated, then restore is disabled', async () => {
  const { isRecoverableAt } = await import('./recovery-idempotency.ts');

  assert.equal(isRecoverableAt('READY', true, 'not-a-date', Date.UTC(2026, 0, 1)), false);
  assert.equal(isRecoverableAt('READY', true, '2025-12-31T23:59:59.000Z', Date.UTC(2026, 0, 1)), false);
  assert.equal(isRecoverableAt('READY', true, '2026-01-01T00:00:01.000Z', Date.UTC(2026, 0, 1)), true);
});

test('Given the resource console backup view, when recovery controls are inspected, then only the five public recovery routes and fields are exposed', async () => {
  const [page, api, actions] = await Promise.all([
    read('../app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../lib/api.ts'),
    read('../components/resource-backup-actions.tsx'),
  ]);

  assert.match(api, /loadResourceConsole/);
  assert.match(page, /<ResourceBackupActions/);
  assert.match(actions, /ResourceBackupViewSchema/);
  assert.match(actions, /ResourceRestoreViewSchema/);
  assert.match(actions, /name="requestIdempotencyKey"/);
  assert.match(actions, /name="formatVersion"/);
  assert.match(actions, /name="name"/);
  assert.match(actions, /name="_method" type="hidden" value="DELETE"/);
  assert.match(actions, /name="confirmed" type="hidden" value="true"/);
  assert.match(actions, /<DialogTitle>/);
  assert.match(actions, /<Progress/);
  assert.match(actions, /aria-live="polite"/);
  assert.match(actions, /data-testid="backup-history"/);
  for (const forbidden of ['artifactKey', 'checksum', 'provenance', 'sourceSpec', 'encryption', 'upload', 'cleanup', 'presigned', 'job']) {
    assert.doesNotMatch(actions, new RegExp(forbidden, 'i'));
  }
});

test('Given deterministic dashboard fixtures, when backup recovery routes are requested, then public rows, state gates, and mutation payloads stay bounded', async () => {
  const { FIXTURE_IDS, TOKENS, responseFor } = await import('../tests/e2e/fixture/data.mjs');
  const request = (method, pathname, body = {}) => responseFor({
    token: TOKENS.user,
    method,
    pathname,
    searchParams: new URLSearchParams(),
    body,
  });
  const base = `/resources/${FIXTURE_IDS.resource}/backups`;
  const listed = request('GET', base);

  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.backups));
  assert.ok(listed.body.backups.every((backup) => Object.keys(backup).every((key) => !/artifact|checksum|provenance|sourceSpec|encryption|upload|cleanup|credential|presigned|job/i.test(key))));
  assert.equal(request('POST', base, { requestIdempotencyKey: 'backup_fixture_001', formatVersion: 1 }).status, 202);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Given the resource console backup view, when recovery controls are inspected, then only the five public recovery routes and fields are exposed', async () => {
  const [page, api, actions] = await Promise.all([
    read('../app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
    read('../lib/api.ts'),
    read('../components/resource-backup-actions.tsx'),
  ]);

  assert.match(api, /getJson\(`\/resources\/\$\{encodeURIComponent\(resourceId\)\}\/backups`/);
  assert.match(page, /<ResourceBackupActions/);
  assert.match(page, /apiAction\(`\/resources\/\$\{resourceId\}\/backups`, state\.context\)/);
  assert.match(actions, /backups\/\$\{encodeURIComponent\(backup\.id\)\}\/restores/);
  assert.match(actions, /backups\/\$\{encodeURIComponent\(backup\.id\)\}/);
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

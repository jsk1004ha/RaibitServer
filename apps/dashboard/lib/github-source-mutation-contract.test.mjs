import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mutationPayload } from './github-source-mutation-contract.mjs';

test('GitHub source mutation accepts its actual rendered control fields and selects the current repository default branch', () => {
  const fields = [
    ['_returnTo', '/github?step=attach'],
    ['integrationId', 'ghi_fixture'],
    ['repositoryId', 'repo_changed'],
    ['expectedCatalogGeneration', '12'],
    ['expectedDefaultBranch', 'main'],
    ['branch', 'main'],
    ['serviceSlug', ''],
  ];
  const formData = new FormData();
  for (const [name, value] of fields) formData.append(name, value);
  assert.deepEqual(mutationPayload(formData, { repo_changed: 'trunk' }), {
    integrationId: 'ghi_fixture', repositoryId: 'repo_changed', expectedCatalogGeneration: 12,
    expectedDefaultBranch: 'trunk', branch: 'main',
  });
});

test('GitHub page keeps client component props serializable and gives every recovery scope an editable branch field', async () => {
  const [page, recovery] = await Promise.all([
    readFile(new URL('../app/github/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/github-conflict-recovery.tsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(page, /catalogHref=/);
  assert.match(page, /id="github-import-branch"/);
  assert.match(page, /id="github-attach-branch"/);
  assert.match(page, /id="github-sync-branch"/);
  assert.match(recovery, /REATTACH_INSTALLATION'\) return <a data-github-recovery-action="reattach-installation" href="\/github\/install"/);
  assert.doesNotMatch(recovery, /SELECT_BRANCH'\) return recovery\.repositoryId/);
});

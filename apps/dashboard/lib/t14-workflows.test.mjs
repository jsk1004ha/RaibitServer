import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const githubPageUrl = new URL('../app/github/page.tsx', import.meta.url);
const adminPageUrl = new URL('../app/admin/page.tsx', import.meta.url);
const e2eSpecUrl = new URL('../tests/e2e/specs/t14-github-admin.spec.ts', import.meta.url);

test('Given the GitHub workflow page, when its forms are inspected, then every step preserves its native mutation contract', async () => {
  const source = await readFile(githubPageUrl, 'utf8');

  for (const contract of [
    ['import', '/github/repositories/import', ['_returnTo', 'integrationId', 'repositoryId', 'projectId', 'serviceName']],
    ['attach', '/services/${firstService.id}/github', ['_returnTo', 'integrationId', 'repositoryId', 'branch']],
    ['sync', '/github/repositories/${encodeURIComponent(selectedRepository.fullName)}/sync', ['_returnTo']],
  ]) {
    const [label, endpoint, fields] = contract;
    assert.ok(source.includes(endpoint), `${label} endpoint is missing`);
    for (const field of fields) assert.match(source, new RegExp(`name=["']${field}["']`), `${label}.${field} is missing`);
  }

  assert.match(source, /const selectedInstallation = state\.installations\.find[\s\S]*\|\| state\.installations\[0\]/);
  assert.match(source, /const selectedRepository = selectedRepositories\[0\]/);
  assert.doesNotMatch(source, /name=["'](?:token|installationId|repoUrl)["']/);
});

test('Given the GitHub workflow page, when its visual structure is inspected, then it uses the shared RAIBIT primitives without legacy surfaces', async () => {
  const source = await readFile(githubPageUrl, 'utf8');

  for (const primitive of ['Card', 'Badge', 'Button', 'Empty', 'FieldGroup', 'Input']) {
    assert.match(source, new RegExp(`\\b${primitive}\\b`), `${primitive} primitive is missing`);
  }
  assert.match(source, /data-t14-github/);
  assert.match(source, /\[&_\.section-nav-item\.active_small\]:!text-foreground/);
  assert.doesNotMatch(source, /\b(?:page-focus|form-surface|activity-card|github-connect-card|workflow-actions|btn-primary|btn-ghost)\b/);
});

test('Given the admin workflow page, when its forms are inspected, then authorization and target-specific mutation fields remain exact', async () => {
  const source = await readFile(adminPageUrl, 'utf8');

  assert.match(source, /if \(!state\.authorized\) redirect\('\/console'\)/);
  for (const endpoint of ['/approve', '/reject', '/ban', '/unban']) assert.ok(source.includes(endpoint), `${endpoint} endpoint is missing`);
  for (const accountType of ['CLUB_MEMBER', 'NON_CLUB']) assert.match(source, new RegExp(`name=["']accountType["'] value=["']${accountType}["']`));
  assert.match(source, /name=["']confirmed["'] value=["']true["'] required/);
  assert.match(source, /name=["']reason["'] required maxLength=\{500\}/);
  assert.match(source, /name=["']expiresAt["'] type=["']datetime-local["']/);
});

test('Given the admin workflow page, when its visual structure is inspected, then tables, empty states, and danger actions use shared primitives', async () => {
  const source = await readFile(adminPageUrl, 'utf8');

  for (const primitive of ['Card', 'Badge', 'Button', 'Empty', 'FieldGroup', 'Input', 'Table']) {
    assert.match(source, new RegExp(`\\b${primitive}\\b`), `${primitive} primitive is missing`);
  }
  assert.match(source, /data-t14-admin/);
  assert.match(source, /<Badge[^>]*bg-primary-soft text-primary[^>]*data-status=\{user\.approvalStatus\}[^>]*>승인 대기<\/Badge>/);
  assert.match(source, /const destructiveActionClassName = 'w-full bg-destructive text-destructive-foreground hover:bg-destructive\/90'/);
  assert.equal((source.match(/className=\{destructiveActionClassName\} variant="destructive"/g) || []).length, 2);
  assert.doesNotMatch(source, /<StatusBadge status=\{user\.approvalStatus\}/);
  assert.doesNotMatch(source, /style=\{\{/);
  assert.doesNotMatch(source, /\b(?:console-surface|admin-approval-card|table-actions|btn-danger|danger-zone)\b/);
});

test('Given the T14 browser scenarios, when success and adversarial paths are inspected, then flash URLs and safe-origin checks remain explicit', async () => {
  const source = await readFile(e2eSpecUrl, 'utf8');

  for (const url of [
    'step=attach&notice=saved',
    'step=sync&notice=saved',
    'step=sync&installation=9001&notice=saved',
  ]) assert.ok(source.includes(url), `${url} success URL is missing`);
  for (const contract of ['installUrl.origin', 'github_callback_failed', 'fixture_route_not_found', 'eventLog.join']) {
    assert.ok(source.includes(contract), `${contract} route-safety contract is missing`);
  }
  assert.ok(source.includes("emptyPage.locator('[data-t14-github] form')).toHaveCount(0)"));
  assert.ok(source.includes('main#main-content [data-slot="alert"]'));
  assert.ok(source.includes("page.locator('next-route-announcer')).not.toContainText"));

  const emptyCheck = source.indexOf("locator('[data-t14-github] form')");
  const syncRequest = source.indexOf('const syncRequestPromise');
  assert.ok(emptyCheck >= 0 && syncRequest > emptyCheck, 'sync must still execute after the scoped empty-state assertion');
});

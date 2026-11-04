import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, installSession, nativeFormData } from '../helpers/contracts';

const project = '/org/raibit/projects/prj_fixture_001';

test('project source choice offers only relevant inputs without mandatory setup steps', async ({ userPage: page }, info) => {
  await page.goto('/org/org_fixture_001/projects/new');
  await expect(page.locator('input[name="name"]')).toBeVisible();
  expect(await page.locator('[data-project-create-form]').evaluate((form) => form instanceof HTMLFormElement && form.checkValidity())).toBe(false);
  await page.locator('input[name="name"]').fill('동아리 홈페이지');
  await page.locator('select[name="sourceType"]').selectOption('image');
  await expect(page.locator('input[name="image"]')).toBeVisible();
  await expect(page.locator('input[name="repoUrl"]')).toBeHidden();
  await page.locator('input[name="image"]').fill('ghcr.io/raibit/club:latest');
  const data = Object.fromEntries(await nativeFormData(page, '[data-project-create-form]'));
  expect(data).toMatchObject({ name: '동아리 홈페이지', sourceType: 'image', image: 'ghcr.io/raibit/club:latest' });
  expect(data.repoUrl).toBeUndefined();
  await expect(page.locator('[data-project-create-form] button[type="submit"]')).toBeVisible();
  expect(await page.locator('[data-project-create-form]').evaluate((form) => form instanceof HTMLFormElement && form.checkValidity())).toBe(true);
  await captureScreenshot(page, info, 'project-image-ready');
});

test('service source choice excludes unrelated image fields for GitHub', async ({ userPage: page }) => {
  await page.goto(`${project}?view=new-service`);
  await page.locator('select[name="sourceType"]').selectOption('github');
  await expect(page.locator('input[name="repoUrl"]')).toBeVisible();
  await expect(page.locator('input[name="imageUrl"]')).toBeHidden();
  await page.locator('select[name="sourceType"]').selectOption('image');
  await expect(page.locator('input[name="repoUrl"]')).toBeHidden();
  await expect(page.locator('input[name="imageUrl"]')).toBeVisible();
});

test('resend sends the edited email without requiring the verification code', async ({ userPage: page, request }) => {
  await page.goto('/login?mode=verify&email=old%40fixture.test&next=%2Faccount%2Fsettings');
  await page.getByLabel('이메일', { exact: true }).fill('changed-ux@fixture.test');
  const sent = page.waitForRequest((entry) => entry.method() === 'POST' && entry.url().includes('/auth/email/resend'));
  await page.getByRole('button', { name: '인증 코드 다시 보내기' }).click();
  const outgoing = await sent;
  expect(new URLSearchParams(outgoing.postData() ?? '').get('email')).toBe('changed-ux@fixture.test');
  await expect(page).toHaveURL(/email=changed-ux%40fixture.test/);
  const log = await request.get('http://127.0.0.1:3411/__fixture/requests');
  expect(await log.json()).toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ path: '/api/auth/email/resend', body: { email: 'changed-ux@fixture.test' } })]) });
  expect(new URL(page.url()).searchParams.get('next')).toBe('/account/settings');
});

test('GitHub connection preserves explicit second-project service and rejects mismatches', async ({ page }) => {
  await installSession(page.context(), 'fixture-ux-workspaces');
  await page.goto('/github?step=attach&projectId=prj_ux_beta&serviceId=svc_ux_beta');
  await expect(page.locator('form[action*="/projects/prj_ux_beta/services/svc_ux_beta/github"]')).toBeVisible();
  await expect(page.locator('form[action*="/projects/prj_ux_alpha/services/"]')).toHaveCount(0);
  await page.goto('/github?step=attach&projectId=prj_ux_beta&serviceId=svc_ux_alpha');
  await expect(page.locator('form[action*="/services/"][action$="/github"]')).toHaveCount(0);
});

test('workspace remains selected across account and guide, without project chrome on account', async ({ page }) => {
  await installSession(page.context(), 'fixture-ux-workspaces');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/org/org_ux_beta/projects');
  await expect(page.getByRole('button', { name: '베타 팀', exact: true })).toBeVisible();
  await page.goto('/account/settings');
  await expect(page.getByRole('button', { name: '베타 팀', exact: true })).toBeVisible();
  await expect(page.getByText('현재 프로젝트', { exact: true })).toHaveCount(0);
  await page.goto('/guide');
  await expect(page.getByRole('button', { name: '베타 팀', exact: true })).toBeVisible();
  await expect(page.locator('aside').getByRole('link', { name: '프로젝트', exact: true })).toHaveAttribute('href', '/org/org_ux_beta/projects');
});

test('guide is readable before login on public and console hosts', async ({ page }) => {
  for (const origin of ['http://localhost:3410', 'http://console.localhost:3410']) {
    await page.goto(`${origin}/guide`);
    await expect(page).toHaveURL(`${origin}/guide`);
    await expect(page.getByRole('heading', { name: '사용 안내', exact: true })).toBeVisible();
  }
});

test('resource connection submits a selected project service instead of typed ID', async ({ userPage: page }) => {
  await page.goto(`${project}/resources/res_fixture_pg/console?view=connection`);
  const picker = page.locator('select[name="serviceId"]');
  await expect(picker).toBeVisible();
  await picker.selectOption('svc_fixture_worker');
  const form = page.locator('form').filter({ has: picker });
  expect(Object.fromEntries(await nativeFormData(page, 'form:has(select[name="serviceId"])'))).toMatchObject({ serviceId: 'svc_fixture_worker' });
  await expect(form.locator('input[name="serviceId"]')).toHaveCount(0);
});

test('filtered logs explain no matches and can restore the original rows', async ({ userPage: page }) => {
  await page.goto(`${project}?view=logs&serviceId=svc_fixture_worker`);
  await expect(page.getByText('worker-only-initial-log', { exact: false })).toBeVisible();
  await page.getByRole('textbox', { name: '로그 검색' }).fill('no-match-ux-20260921');
  await expect(page.getByText('worker-only-initial-log', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: /초기화/ }).click();
  await expect(page.getByRole('textbox', { name: '로그 검색' })).toHaveValue('');
  await expect(page.getByText('worker-only-initial-log', { exact: false })).toBeVisible();
});

test('deployment retry links to returned deployment and renders without hydration errors', async ({ adminPage: page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${project}/deployments/dep_fixture_failed?view=overview`);
  await page.getByRole('button', { name: '재시도', exact: true }).click();
  await page.getByRole('button', { name: '재시도 요청', exact: true }).click();
  await expect(page.locator('a[href$="/deployments/dep_fixture_retry_successor?view=overview"]')).toBeVisible();
  expect(errors).toEqual([]);
});

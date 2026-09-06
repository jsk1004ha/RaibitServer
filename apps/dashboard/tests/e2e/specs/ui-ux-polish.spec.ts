import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible } from '../helpers/contracts';
import { CONSOLE_ORIGIN, prepareTheme } from '../helpers/theme-contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const projectBase = '/org/raibit/projects/prj_fixture_001';
const resourceBase = `${projectBase}/resources/res_fixture_pg/console`;

async function expectCurrentItemInsideScroller(page: Page, label: string): Promise<void> {
  const navigation = page.getByRole('navigation', { name: label });
  const viewport = navigation.locator('[data-horizontal-scroll-viewport]');
  await expect(viewport).toBeVisible();
  await expect(navigation.locator('[data-horizontal-scroll-hint]')).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) => {
    const current = element.querySelector<HTMLElement>('[aria-current]');
    if (!current) return false;
    const viewportBox = element.getBoundingClientRect();
    const currentBox = current.getBoundingClientRect();
    return currentBox.left >= viewportBox.left - 1 && currentBox.right <= viewportBox.right + 1;
  })).toBe(true);
}

async function expectInsideViewport(locator: Locator, width: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('visible_element_geometry_missing');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

test.describe('@ui-ux-polish', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test('inverse log and schema surfaces keep accessible dark-mode contrast', async ({ userPage }, testInfo) => {
    await userPage.setViewportSize({ width: 1280, height: 800 });
    await prepareTheme(userPage, CONSOLE_ORIGIN, 'dark');
    await userPage.goto(`${projectBase}/deployments/dep_fixture_ready?view=logs`);
    await expect(userPage.getByRole('log', { name: '마스킹된 빌드 로그' })).toBeVisible();
    await expectAccessible(userPage);
    await captureScreenshot(userPage, testInfo, 'ulw-deployment-logs-dark-1280');

    await userPage.goto(`${resourceBase}?view=schema`);
    await expect(userPage.getByRole('heading', { name: '구조 데이터' })).toBeVisible();
    await expectAccessible(userPage);
    await captureScreenshot(userPage, testInfo, 'ulw-resource-schema-dark-1280');
  });

  test('mobile horizontal navigation exposes its affordance and keeps the active item visible', async ({ userPage }, testInfo) => {
    await userPage.setViewportSize({ width: 375, height: 812 });

    await userPage.goto(`${resourceBase}?view=provider`);
    await expectCurrentItemInsideScroller(userPage, '리소스 콘솔 화면');
    await captureScreenshot(userPage, testInfo, 'ulw-resource-navigation-mobile-375');

    await userPage.goto('/github?step=sync');
    await expectCurrentItemInsideScroller(userPage, '저장소 연결 단계');

    await userPage.goto('/guide?topic=administration');
    await expectCurrentItemInsideScroller(userPage, '사용 안내 주제');

    await userPage.goto('/org/raibit/projects/new');
    await userPage.getByLabel('프로젝트 이름').fill('모바일 탐색 점검');
    await userPage.locator('[data-wizard-next]').click();
    await userPage.locator('[data-wizard-next]').click();
    await userPage.locator('[data-wizard-next]').click();
    await expectCurrentItemInsideScroller(userPage, '프로젝트 만들기 단계');
  });

  test('admin actions reflow into the mobile viewport without splitting account labels', async ({ adminPage }, testInfo) => {
    const width = 375;
    await adminPage.setViewportSize({ width, height: 812 });
    await adminPage.goto('/admin');

    const approval = adminPage.getByRole('button', { name: '클럽 회원 승인' });
    await expectInsideViewport(approval, width);
    const tableContainer = approval.locator('xpath=ancestor::div[@data-slot="table-container"]');
    expect(await tableContainer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const accountType = adminPage.locator('[data-admin-account-type]').filter({ hasText: '일반 사용자' }).first();
    await expect(accountType).toBeVisible();
    expect(await accountType.evaluate((element) => element.getClientRects().length)).toBe(1);
    await captureScreenshot(adminPage, testInfo, 'ulw-admin-mobile-375');
  });

  test('secondary public pages retain the console path and use consistent Korean chrome', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('http://localhost:3410/');
    await expect(page.getByRole('heading', { name: '만들고, 올리고, 운영하세요.' })).toBeVisible();
    await captureScreenshot(page, testInfo, 'ulw-home-mobile-375');

    for (const route of ['/support', '/privacy', '/contributors'] as const) {
      await page.goto(`http://localhost:3410${route}`);
      await expect(page.locator('header').getByRole('link', { name: '콘솔', exact: true })).toBeVisible();
      const footer = page.getByRole('contentinfo');
      for (const label of ['지원', '운영 현황', '기여자', '개인정보 처리방침'] as const) {
        await expect(footer.getByRole('link', { name: label, exact: true })).toBeVisible();
      }
    }

    const list = page.locator('[aria-label="RAIBIT SERVER 기여자 목록"]');
    await expect(list.locator('img')).toHaveCount(0);
    await expect(list.locator('[data-user-avatar]')).toHaveCount(3);
    await captureScreenshot(page, testInfo, 'ulw-contributors-mobile-375');
  });

  test('environment file import reads valid text and keeps manual input on rejection', async ({ userPage }, testInfo) => {
    await userPage.goto(`${projectBase}?view=environment&serviceId=svc_fixture_web`);
    const content = userPage.getByLabel('.env 내용');
    const fileInput = userPage.getByLabel('.env 파일 선택');

    await expect(fileInput).toHaveCount(1);
    await content.fill('MANUAL_VALUE=keep-me');
    await fileInput.setInputFiles({
      name: '.env.oversized',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(256 * 1024 + 1, 'x'),
    });
    await expect(userPage.getByRole('alert').filter({ hasText: '256 KB' })).toBeVisible();
    await expect(content).toHaveValue('MANUAL_VALUE=keep-me');

    await fileInput.setInputFiles({
      name: '.env.production',
      mimeType: 'text/plain',
      buffer: Buffer.from('NODE_ENV=production\nAPI_TOKEN=fixture-secret', 'utf8'),
    });
    await expect(userPage.getByText('.env.production', { exact: true })).toBeVisible();
    await expect(content).toHaveValue('NODE_ENV=production\nAPI_TOKEN=fixture-secret');
    await captureScreenshot(userPage, testInfo, 'ulw-env-file-import-desktop-1280');
    await userPage.getByRole('button', { name: '.env 가져오기' }).click();
    await expect(userPage).toHaveURL(/view=environment.*notice=saved/);
  });

  test('resource query renders results and preserves the query when the API rejects it', async ({ userPage }, testInfo) => {
    await userPage.setViewportSize({ width: 768, height: 900 });
    await userPage.goto(`${resourceBase}?view=query`);
    const query = userPage.getByRole('textbox', { name: '쿼리', exact: true });
    await query.fill('SELECT 1');
    await userPage.getByRole('button', { name: '쿼리 실행' }).click();

    const result = userPage.getByRole('region', { name: '쿼리 결과' });
    await expect(result).toBeVisible();
    await expect(result.getByRole('columnheader', { name: 'status' })).toBeVisible();
    await expect(result.getByRole('cell', { name: 'READY' })).toBeVisible();
    await captureScreenshot(userPage, testInfo, 'ulw-resource-query-tablet-768');

    await userPage.route('**/api/control/resources/res_fixture_pg/console/query', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'query_rejected' }),
      });
    });
    await query.fill('INVALID QUERY');
    await userPage.getByRole('button', { name: '쿼리 실행' }).click();
    await expect(userPage.getByRole('alert').filter({ hasText: '쿼리를 실행하지 못했습니다' })).toBeVisible();
    await expect(query).toHaveValue('INVALID QUERY');
  });
});

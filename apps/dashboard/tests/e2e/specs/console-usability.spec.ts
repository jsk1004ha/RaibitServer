import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible } from '../helpers/contracts';

test.describe('console usability', () => {
  test.skip(process.env.RAIBITSERVER_E2E_FIXTURES !== '1', 'requires local fixtures');

  test('workspace uses its name and both project and team links load', async ({ userPage: page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/console');
    await page.getByRole('button', { name: '라이빗 개발팀' }).click();
    await expect(page.getByText('프로젝트와 팀원을 함께 관리하는 공간입니다.')).toBeVisible();
    await captureScreenshot(page, testInfo, 'workspace-menu');
    await page.getByRole('menuitem', { name: /라이빗 개발팀/ }).click();
    await expect(page).toHaveURL(/\/org\/org_fixture_001\/projects$/);
    await expect(page.getByRole('heading', { name: '프로젝트', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '라이빗 개발팀' }).click();
    await page.getByRole('menuitem', { name: '팀원 관리' }).click();
    await expect(page.getByRole('heading', { name: '팀원 관리', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /500|서버 오류/ })).toHaveCount(0);
  });

  test('profile opens real settings and theme controls work', async ({ userPage: page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/console');
    await page.getByRole('button', { name: '계정 메뉴 열기' }).click();
    await expect(page.getByRole('menuitem', { name: '계정 설정', exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, 'account-menu');
    await page.getByRole('menuitem', { name: '계정 설정', exact: true }).click();
    await expect(page.getByRole('heading', { name: '계정 설정', exact: true })).toBeVisible();
    const themeCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: '화면 테마' }) });
    await themeCard.getByRole('button', { name: /테마 설정/ }).click();
    await page.getByRole('menuitemradio', { name: '다크', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('link', { name: '계정 보안 열기' }).click();
    await expect(page.getByRole('heading', { name: '계정 보안', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '비밀번호 재설정 시작' })).toHaveAttribute('href', '/login?mode=forgot');
  });

  test('guide and settings stay readable at mobile tablet and desktop sizes', async ({ userPage: page }, testInfo) => {
    test.slow();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/guide', '/account/settings', '/account/security']) {
        await page.goto(route);
        await expectAccessible(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (route === '/guide') await expect(page.getByRole('heading', { name: '사용 안내', exact: true })).toBeVisible();
        await captureScreenshot(page, testInfo, `${route.replaceAll('/', '-')}-${width}`);
      }
    }
  });

  test('settings requires login', async ({ page }) => {
    await page.goto('/account/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fsettings/);
  });
});

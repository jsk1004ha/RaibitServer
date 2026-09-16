import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible } from '../helpers/contracts';
import { CONSOLE_ORIGIN, prepareTheme } from '../helpers/theme-contracts';

test('@github-oauth-avatar login offers a readable provider-photo path in dark mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await prepareTheme(page, CONSOLE_ORIGIN, 'dark');
  await page.goto(`${CONSOLE_ORIGIN}/login`);

  const githubLogin = page.getByRole('link', { name: 'GitHub로 로그인' });
  await expect(githubLogin).toBeVisible();
  await expect(githubLogin).toHaveAttribute('href', '/api/control/auth/github/login');
  await expect(page.getByText('프로필 사진도 함께 연결됩니다', { exact: false })).toBeVisible();
  await expectAccessible(page);
  await captureScreenshot(page, testInfo, 'github-oauth-login-dark-mobile-375');
});

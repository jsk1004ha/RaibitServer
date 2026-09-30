import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible } from '../helpers/contracts';
import { CONSOLE_ORIGIN, prepareTheme } from '../helpers/theme-contracts';

test('@github-oauth-avatar login offers a readable provider-photo path in dark mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await prepareTheme(page, CONSOLE_ORIGIN, 'dark');
  await page.goto(`${CONSOLE_ORIGIN}/login`);

  if (/^[a-f0-9]{64}$/.test(process.env.RAIBITSERVER_OAUTH_RELAY_SECRET ?? '')) {
    const githubLogin = page.getByRole('link', { name: 'GitHub로 로그인' });
    await expect(githubLogin).toBeVisible();
    await expect(githubLogin).toHaveAttribute('href', '/api/control/auth/github/login');
    await expect(page.getByText('프로필 사진도 함께 연결됩니다', { exact: false })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'GitHub로 로그인' })).toBeDisabled();
    await expect(page.getByText('GitHub 로그인은 관리자 설정을 기다리고 있습니다.', { exact: false })).toBeVisible();
  }
  await expectAccessible(page);
  await captureScreenshot(page, testInfo, 'github-oauth-login-dark-mobile-375');
});

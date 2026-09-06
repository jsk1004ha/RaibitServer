import type { Page } from '@playwright/test';
import { expect, test } from '../helpers/fixtures';
import { expectAccessible, expectRoute, observeBrowserErrors } from '../helpers/contracts';
import { IDENTITY_ORGANIZATION_ACCESSIBILITY, IDENTITY_ORGANIZATION_MATRIX, IDENTITY_ORGANIZATION_VIEWPORTS } from '../identity-organization-matrix';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const inviteToken = 'A'.repeat(43);

async function expectReflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe('@platform-expansion @identity-organization-matrix', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  test.setTimeout(60_000);

  test('identity-owner-membership trusted invite link completes with keyboard, announcement, redaction, motion, and reflow outcomes', async ({ userPage }) => {
    // Given: an authenticated exact-email recipient and the trusted acceptance-link surface.
    const assertNoErrors = observeBrowserErrors(userPage);
    let submittedToken = '';
    await userPage.route('**/api/control/organization-invites/accept', async (route) => {
      const body: unknown = route.request().postDataJSON();
      submittedToken = body !== null && typeof body === 'object' && 'token' in body && typeof body.token === 'string' ? body.token : '';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'accepted', membership: { organizationId: 'org_fixture_002', role: 'DEVELOPER' } }) });
    });
    await userPage.emulateMedia({ reducedMotion: 'reduce' });

    // When: the recipient opens the mail link and accepts it with the keyboard.
    await userPage.setViewportSize(IDENTITY_ORGANIZATION_VIEWPORTS[0]);
    await userPage.goto(`/organization-invites/accept?token=${inviteToken}`, { waitUntil: 'networkidle' });
    await expect.poll(() => new URL(userPage.url()).search).toBe('');
    const accept = userPage.getByRole('button', { name: '초대 수락' });
    await accept.focus();
    await expect(accept).toBeFocused();
    await userPage.keyboard.press('Enter');

    // Then: the completed outcome is announced, re-login is explicit, and the token is absent from rendered/browser state.
    await expect(userPage.getByRole('status')).toContainText('초대를 수락했습니다.');
    await expect(userPage.getByRole('link', { name: '다시 로그인하기' })).toBeVisible();
    expect(submittedToken).toBe(inviteToken);
    expect(await userPage.locator('body').innerText()).not.toContain(inviteToken);
    expect(userPage.url()).not.toContain(inviteToken);
    for (const viewport of IDENTITY_ORGANIZATION_VIEWPORTS) {
      await userPage.setViewportSize(viewport);
      await expectReflow(userPage);
    }
    await userPage.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expectReflow(userPage);
    await expectAccessible(userPage);
    assertNoErrors();
  });

  test('identity-pending-relogin account identity and logout remain synchronized across desktop and mobile shells', async ({ userPage }) => {
    // Given: the Task34 account surface and every required accessibility mode declared by the matrix.
    const assertNoErrors = observeBrowserErrors(userPage, [404]);
    expect(IDENTITY_ORGANIZATION_ACCESSIBILITY).toEqual(['keyboard', 'screen-reader-announcement', 'reduced-motion', 'zoom-200']);
    expect(IDENTITY_ORGANIZATION_MATRIX.some((row) => row.id === 'logout-replay')).toBe(true);
    await userPage.emulateMedia({ reducedMotion: 'reduce' });

    // When: both shell breakpoints expose the same authenticated identity and the user submits logout.
    for (const viewport of [IDENTITY_ORGANIZATION_VIEWPORTS[1], IDENTITY_ORGANIZATION_VIEWPORTS[4]]) {
      await userPage.setViewportSize(viewport);
      await userPage.goto('/account/security', { waitUntil: 'networkidle' });
      await expect(userPage.getByRole('heading', { level: 1, name: '계정 보안' })).toBeVisible();
      const accountMenu = userPage.getByRole('button', { name: '계정 메뉴 열기' }).filter({ visible: true });
      await accountMenu.focus();
      await userPage.keyboard.press('Enter');
      await expect(userPage.getByText('user@fixture.test', { exact: true }).filter({ visible: true }).first()).toBeVisible();
      await userPage.keyboard.press('Escape');
      await expectReflow(userPage);
    }
    await userPage.getByRole('button', { name: '계정 메뉴 열기' }).filter({ visible: true }).click();
    await userPage.getByRole('button', { name: '로그아웃' }).click();

    // Then: the session cookie is gone and the protected account route requires login without exposing claims.
    await expect.poll(async () => (await userPage.context().cookies()).some((cookie) => cookie.name === 'raibitserver_session')).toBe(false);
    await userPage.goto('/account/security');
    await expectRoute(userPage, '/login');
    expect(await userPage.locator('body').innerText()).not.toContain('sessionVersion');
    assertNoErrors();
  });
});

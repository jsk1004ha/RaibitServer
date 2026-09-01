import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible, expectRoute, installSession, nativeFormData } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const viewports = [{ width: 375, height: 812 }, { width: 1280, height: 800 }] as const;

test.describe('@t10-auth-flows', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test('server-rendered login, signup, and verification forms preserve navigation and FormData', async ({ page, request }, testInfo) => {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto('/login?next=%2Forg%2Fraibit%2Fprojects');
      await expect(page.getByRole('heading', { name: '콘솔에 로그인' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: '인증 메뉴' }).getByRole('link', { name: '가입 신청' })).toHaveAttribute('href', /mode=signup/);
      await expectAccessible(page);
      await captureScreenshot(page, testInfo, `t10-login-${viewport.width}`);
    }

    await page.goto('/login?next=%2Forg%2Fraibit%2Fprojects');
    await page.getByLabel('이메일').fill('user@fixture.test');
    await page.getByLabel('비밀번호').fill('fixture-user-pass');
    expect(await nativeFormData(page, 'form.auth-form')).toEqual([
      ['_returnTo', '/org/raibit/projects'],
      ['email', 'user@fixture.test'],
      ['password', 'fixture-user-pass'],
    ]);
    await page.getByLabel('비밀번호').press('Enter');
    await expectRoute(page, '/org/raibit/projects', { notice: 'saved' });

    await page.goto('/login?mode=signup&next=%2Fconsole&email=signup%40fixture.test');
    await page.getByLabel('이름').fill('라이빗 테스트');
    await page.getByLabel('학번').fill('2512');
    await page.getByLabel('비밀번호').fill('fixture-signup-pass');
    await page.locator('#club-member-yes').check();
    expect(await nativeFormData(page, 'form.auth-form')).toEqual([
      ['_returnTo', '/login?mode=verify'],
      ['name', '라이빗 테스트'],
      ['studentId', '2512'],
      ['email', 'signup@fixture.test'],
      ['password', 'fixture-signup-pass'],
      ['clubMemberClaim', '1'],
    ]);
    await page.getByLabel('비밀번호').press('Enter');
    await expectRoute(page, '/login', { mode: 'verify', email: 'signup@fixture.test', notice: 'saved' });
    expect(new URL(page.url()).search).toBe('?mode=verify&email=signup%40fixture.test&notice=saved');

    await page.goto('/login?mode=verify&email=verify%40fixture.test&next=%2Fconsole');
    await page.getByLabel('6자리 인증 코드').fill('123456');
    expect(await nativeFormData(page, 'form.auth-form')).toEqual([
      ['_returnTo', '/console'],
      ['email', 'verify@fixture.test'],
      ['code', '123456'],
    ]);
    await page.getByLabel('6자리 인증 코드').press('Enter');
    await expectRoute(page, '/console', { notice: 'saved' });
    const fixtureLog = await request.get('http://127.0.0.1:3411/__fixture/requests');
    const fixtureRequests = await fixtureLog.json();
    expect(fixtureRequests).toMatchObject({
      requests: expect.arrayContaining([expect.objectContaining({
        path: '/api/auth/email/verify',
        body: { email: 'verify@fixture.test', code: '[MASKED]' },
      })]),
    });
    expect(JSON.stringify(fixtureRequests.requests.filter((entry: { path: string }) => entry.path === '/api/auth/email/verify'))).not.toContain('123456');
  });

  test('resend executes independently after keyboard submission and records its FormData', async ({ page, request }) => {
    await installSession(page.context(), 'fixture-user-populated');
    await page.goto('/login?mode=verify&email=verify%40fixture.test&next=%2Fconsole');
    expect(await nativeFormData(page, 'form.auth-resend')).toEqual([
      ['_returnTo', '/login?mode=verify&email=verify%40fixture.test'],
      ['email', 'verify@fixture.test'],
    ]);
    await page.getByRole('button', { name: '인증 코드 다시 보내기' }).press('Enter');
    await expectRoute(page, '/login', { mode: 'verify', email: 'verify@fixture.test', notice: 'saved' });
    const resendLog = await request.get('http://127.0.0.1:3411/__fixture/requests');
    expect(await resendLog.json()).toMatchObject({
      requests: expect.arrayContaining([expect.objectContaining({
        path: '/api/auth/email/resend',
        body: { email: 'verify@fixture.test' },
      })]),
    });
  });

  test('auth errors remain generic, accessible, and safe at narrow and wide viewports', async ({ page }, testInfo) => {
    const longValue = encodeURIComponent('인증 상태를 확인하는 동안 긴 안내 문구가 화면을 넘치지 않고 자연스럽게 줄바꿈되어야 합니다. '.repeat(12));
    const states = [
      ['invalid_credentials', '이메일 또는 비밀번호를 확인해 주세요.'],
      ['email_not_verified', '먼저 이메일 인증을 완료해 주세요.'],
      ['invalid_or_expired_email_verification_code', '인증 코드가 올바르지 않거나 만료되었습니다.'],
      ['session_expired', '세션이 만료되었습니다. 다시 로그인해 주세요.'],
      ['account_not_approved', '요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.'],
      ['fixture_upstream_secret_must_not_escape', '요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.'],
    ] as const;

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const [error, message] of states) {
        await page.goto(`/login?mode=verify&error=${error}`);
        const alert = page.locator('#auth-message[role="alert"]');
        await expect(alert).toHaveText(/확인해 주세요/);
        await expect(alert).toContainText(message);
        await expect(alert).not.toContainText(error);
        await expect(page.locator('body')).not.toContainText('fixture_upstream_secret_must_not_escape');
        await expectAccessible(page);
      }
      await page.goto(`/login?mode=signup&notice=${longValue}`);
      await expect(page.locator('#auth-message[role="status"]')).toContainText('요청 결과를 확인해 주세요.');
      await expect(page.locator('body')).not.toContainText('인증 상태를 확인하는 동안 긴 안내 문구');
      await captureScreenshot(page, testInfo, `t10-sanitized-auth-${viewport.width}`);
    }
  });
});

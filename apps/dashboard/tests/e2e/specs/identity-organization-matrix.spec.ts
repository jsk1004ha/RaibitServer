import type { Page } from '@playwright/test';
import { expect, test } from '../helpers/fixtures';
import { expectAccessible, expectRoute, FIXTURE_ORIGIN, installSession, observeBrowserErrors } from '../helpers/contracts';
import { IDENTITY_ORGANIZATION_ACCESSIBILITY, IDENTITY_ORGANIZATION_MATRIX, IDENTITY_ORGANIZATION_VIEWPORTS } from '../identity-organization-matrix';
import { TASK49_ROLE_BROWSER_JOURNEYS } from '../feature-expansion-matrix';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const inviteToken = 'A'.repeat(43);

async function expectReflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
}

const dashboardOrigin = 'http://console.localhost:3410';
const organizationId = 'org_fixture_001';
const targetMemberId = 'mem_fixture_target';
const membersPath = `/api/control/organizations/${organizationId}/members`;
const targetMemberPath = `${membersPath}/${targetMemberId}`;
const invitesPath = `/api/control/organizations/${organizationId}/invites`;

type JsonRecord = Readonly<Record<string, unknown>>;
type JsonResponse = Readonly<{ json(): Promise<unknown> }>;
type UrlResponse = Readonly<{ url(): string }>;

function isPath(response: UrlResponse, path: string): boolean {
  return new URL(response.url()).pathname === path;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function json(response: JsonResponse): Promise<JsonRecord> {
  const body: unknown = await response.json();
  if (!isJsonRecord(body)) throw new TypeError('task49_json_object_required');
  return body;
}

async function targetMember(page: Page): Promise<JsonRecord> {
  const response = await page.request.get(`${dashboardOrigin}${membersPath}`);
  expect(response.status()).toBe(200);
  const body = await json(response);
  const members = body.members;
  if (!Array.isArray(members)) throw new TypeError('task49_members_array_required');
  const target = members.find((member) => isJsonRecord(member) && member.id === targetMemberId);
  if (!isJsonRecord(target)) throw new TypeError('task49_target_member_required');
  return target;
}

async function patchTargetMember(page: Page, data: Readonly<{ role: string; expectedVersion: number }>) {
  return page.request.patch(`${dashboardOrigin}${targetMemberPath}`, {
    data,
    headers: { origin: dashboardOrigin },
  });
}

function mediaTheme(theme: (typeof TASK49_ROLE_BROWSER_JOURNEYS)[number]['theme']): 'dark' | 'light' | 'no-preference' {
  return theme === 'system' ? 'no-preference' : theme;
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
      if (viewport.width < 768) {
        await userPage.getByRole('button', { name: '콘솔 메뉴 열기' }).click();
      }
      const accountMenu = userPage.getByRole('button', { name: '계정 메뉴 열기' }).filter({ visible: true });
      await expect(accountMenu).toContainText('user@fixture.test');
      await accountMenu.focus();
      await userPage.keyboard.press('Enter');
      await expect(accountMenu).toHaveAttribute('aria-expanded', 'true');
      await expect(userPage.getByRole('menuitem', { name: '계정 보안' })).toBeVisible();
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

  for (const journey of TASK49_ROLE_BROWSER_JOURNEYS) {
    test(journey.title, { tag: journey.kind === 'negative' ? '@platform-expansion-negative' : '@platform-expansion-role' }, async ({ browser }) => {
      const context = await browser.newContext();
      if (journey.token) await installSession(context, journey.token);
      const page = await context.newPage();
      const reset = await page.request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
      expect(reset.status()).toBe(200);
      const assertNoErrors = observeBrowserErrors(page, journey.intent === 'tenant-create' ? [403] : []);
      const mutationRequests: string[] = [];
      const inviteRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'PATCH' && url.pathname === targetMemberPath) mutationRequests.push(url.href);
        if (request.method() === 'POST' && url.pathname === invitesPath) inviteRequests.push(url.href);
      });

      try {
        await page.setViewportSize(journey.viewport);
        await page.emulateMedia({ colorScheme: mediaTheme(journey.theme), reducedMotion: 'reduce' });

        if (journey.intent === 'authentication-required') {
          const denied = await patchTargetMember(page, { role: 'ADMIN', expectedVersion: 1 });
          expect(denied.status()).toBe(401);
          expect(await json(denied)).toEqual(journey.role === 'pending' ? { error: 'account_not_approved' } : { error: 'authentication_required' });
          await page.goto(journey.route, { waitUntil: 'networkidle' });
          await expectRoute(page, '/login', journey.role === 'pending' ? {} : { error: 'session_expired' });
          if (journey.role === 'pending') expect(new URL(page.url()).search).toBe('');
          await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
          expect(mutationRequests).toEqual([]);
        } else if (journey.intent === 'member-mutation') {
          const nextRole = journey.nextRole;
          if (!nextRole) throw new TypeError('task49_next_role_required');
          await page.goto(journey.route, { waitUntil: 'networkidle' });
          await expect(page.getByLabel('이메일', { exact: true })).toBeEnabled();
          await expect(page.locator('#organization-invite-role')).toBeEnabled();
          await expect(page.getByRole('button', { name: '초대 보내기' })).toBeEnabled();
          const inviteOptions = await page.locator('#organization-invite-role option').evaluateAll((options) => options.map((option) => option.getAttribute('value')));
          if (journey.role === 'ADMIN') expect(inviteOptions).not.toContain('OWNER');
          else expect(inviteOptions).toContain('OWNER');
          const roleControl = page.getByLabel('target@fixture.test 역할');
          await expect(roleControl).toHaveValue('VIEWER');
          const mutation = page.waitForResponse((response) => response.request().method() === 'PATCH' && isPath(response, targetMemberPath));
          await roleControl.selectOption(nextRole);
          const response = await mutation;
          expect(response.status()).toBe(200);
          const body = await json(response);
          expect(body.membership).toMatchObject({ id: targetMemberId, role: nextRole, version: 2 });
          expect(mutationRequests).toEqual([`${dashboardOrigin}${targetMemberPath}`]);
          await expect(page.getByRole('status')).toContainText('구성원 역할을 변경했습니다.');
          await expect(roleControl).toHaveValue(nextRole);
          expect(await targetMember(page)).toMatchObject({ id: targetMemberId, role: nextRole, version: 2 });
        } else if (journey.intent === 'member-denied') {
          await page.goto(journey.route, { waitUntil: 'networkidle' });
          await expect(page.getByLabel('target@fixture.test 역할')).toHaveCount(0);
          await expect(page.getByRole('button', { name: '제거' })).toHaveCount(0);
          if (journey.role === 'VIEWER') {
            await expect(page.getByLabel('이메일', { exact: true })).toBeDisabled();
            await expect(page.locator('#organization-invite-role')).toBeDisabled();
            await expect(page.getByRole('button', { name: '초대 보내기' })).toBeDisabled();
            await expect(page.getByText('구성원 초대는 소유자 또는 관리자만 할 수 있습니다.')).toBeVisible();
          }
          const before = await targetMember(page);
          const expectedVersion = before.version;
          if (typeof expectedVersion !== 'number') throw new TypeError('task49_target_member_version_required');
          const denied = await patchTargetMember(page, { role: 'DEVELOPER', expectedVersion });
          expect(denied.status()).toBe(403);
          expect(await json(denied)).toEqual({ error: 'forbidden' });
          expect(await targetMember(page)).toEqual(before);
          expect(mutationRequests).toEqual([]);
          expect(inviteRequests).toEqual([]);
        } else {
          await page.goto(journey.route, { waitUntil: 'networkidle' });
          await page.getByLabel('조직 이름').fill('Role matrix organization');
          await page.getByLabel('조직 주소').fill('role-matrix-global-admin');
          const create = page.waitForResponse((response) => response.request().method() === 'POST' && isPath(response, '/api/control/organizations'));
          await page.getByRole('button', { name: '조직 만들기' }).click();
          const response = await create;
          expect(response.status()).toBe(201);
          const body = await json(response);
          expect(body.membership).toMatchObject({ organizationId: 'org_fixture_created_role-matrix-global-admin', role: 'OWNER', userId: 'usr_fixture_global_admin' });
          await expect(page.getByRole('status')).toContainText('새 조직을 만들었습니다.');
          await expect(page.getByRole('link', { name: '다시 로그인하기' })).toBeVisible();
          const denied = await patchTargetMember(page, { role: 'DEVELOPER', expectedVersion: 1 });
          expect(denied.status()).toBe(401);
          expect(await json(denied)).toEqual({ error: 'authentication_required' });
        }

        await expectAccessible(page);
        assertNoErrors();
      } finally {
        await context.close();
      }
    });
  }
});

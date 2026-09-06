import { expect, test } from '../helpers/fixtures';
import { FIXTURE_ORIGIN, expectAccessible, nativeFormData } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const path = '/org/raibit/projects/prj_fixture_001/resources/res_fixture_pg/console?view=backups';

test.describe('@t26-resource-recovery', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');

  test.beforeEach(async ({ request }) => {
    const reset = await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
    expect(reset.ok()).toBe(true);
  });

  test('backup history renders public mixed states as responsive labelled rows', async ({ userPage }) => {
    for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }] as const) {
      await userPage.setViewportSize(viewport);
      await userPage.goto(path);
      await expect(userPage.getByTestId('backup-history')).toBeVisible();
      await expect(userPage.getByTestId('backup-row-bak_fixture_ready')).toContainText('READY');
      await expect(userPage.getByTestId('backup-row-bak_fixture_verifying')).toContainText('VERIFYING');
      await expect(userPage.getByTestId('backup-row-bak_fixture_failed')).toContainText('RECOVERY_SOURCE_UNAVAILABLE');
      await expect(userPage.getByTestId('backup-row-bak_fixture_ready').getByRole('button', { name: '복구 준비' })).toBeEnabled();
      await expect(userPage.getByTestId('backup-row-bak_fixture_verifying').getByRole('button', { name: '복구 준비' })).toBeDisabled();
      expect(await userPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await expectAccessible(userPage);
    }
  });

  test('create, restore, and delete requests use the exact public payloads while native fallbacks retain return paths', async ({ userPage }) => {
    await userPage.goto(path);
    const createForm = userPage.locator('form[action*="/resources/res_fixture_pg/backups"]');
    expect(await nativeFormData(userPage, 'form[action*="/resources/res_fixture_pg/backups"]')).toEqual(expect.arrayContaining([
      ['_returnTo', '/org/raibit/projects/prj_fixture_001/resources/res_fixture_pg/console?view=backups'],
      ['formatVersion', '1'],
    ]));
    const createRequest = userPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/control/resources/res_fixture_pg/backups' && request.method() === 'POST');
    await createForm.getByRole('button', { name: '백업 만들기' }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ formatVersion: 1 });

    const readyRow = userPage.getByTestId('backup-row-bak_fixture_ready');
    await readyRow.getByRole('button', { name: '복구 준비' }).click();
    await userPage.getByLabel('새 리소스 이름').fill('restored-primary');
    const restoreRequest = userPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/control/backups/bak_fixture_ready/restores' && request.method() === 'POST');
    await userPage.getByRole('button', { name: '복구 요청', exact: true }).click();
    expect((await restoreRequest).postDataJSON()).toMatchObject({ formatVersion: 1, name: 'restored-primary' });

    await readyRow.getByRole('button', { name: '삭제 요청' }).click();
    expect(await nativeFormData(userPage, 'form[action*="/backups/bak_fixture_ready"]')).toEqual(expect.arrayContaining([
      ['_method', 'DELETE'],
      ['confirmed', 'true'],
    ]));
    const deleteRequest = userPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/control/backups/bak_fixture_ready' && request.method() === 'DELETE');
    await userPage.getByRole('button', { name: '삭제 요청 확인' }).click();
    expect((await deleteRequest).postDataJSON()).toEqual({ confirmed: true });
  });
});

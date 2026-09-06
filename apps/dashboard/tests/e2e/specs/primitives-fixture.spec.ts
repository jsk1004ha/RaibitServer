import { expect, test } from '../helpers/fixtures';
import { expectAccessible, nativeFormData, observeBrowserErrors } from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';

test('the primitive fixture is denied by default in a production server', async ({ userPage: page }) => {
  test.skip(fixtureEnabled, 'requires a server without RAIBITSERVER_E2E_FIXTURES=1');

  await page.goto('/primitives-fixture');

  await expect(page.getByRole('heading', { name: '요청한 화면을 찾을 수 없습니다' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '긴 한국어 서비스 이름도 자연스럽고 안정적으로 읽히는 운영 인터페이스' })).toHaveCount(0);
});

test('the primitive fixture exercises form and overlay primitives only when explicitly enabled for E2E', async ({ userPage: page }) => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  const assertNoErrors = observeBrowserErrors(page);

  await page.goto('/primitives-fixture');

  await expect(page.getByRole('heading', { name: '긴 한국어 서비스 이름도 자연스럽고 안정적으로 읽히는 운영 인터페이스' })).toBeVisible();
  expect(await nativeFormData(page, '#primitive-form')).toEqual([
    ['projectName', 'raibit-console'],
    ['description', '안전한 배포 환경'],
    ['region', 'icn'],
    ['invalidName', ''],
    ['notifications', 'enabled'],
  ]);

  const dialogTrigger = page.getByRole('button', { name: '대화상자 열기' });
  await dialogTrigger.click();
  const dialog = page.getByRole('dialog', { name: '배포 설정 확인' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(dialogTrigger).toBeFocused();

  const sheetTrigger = page.getByRole('button', { name: '시트 열기' });
  await sheetTrigger.click();
  const sheet = page.getByRole('dialog', { name: '프로젝트 세부 정보' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(sheet.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(sheetTrigger).toBeFocused();

  const commandTrigger = page.getByRole('button', { name: '명령 팔레트' });
  await commandTrigger.click();
  const command = page.getByRole('dialog', { name: '프로젝트 명령' });
  await expect(command).toBeVisible();
  await page.getByPlaceholder('명령 검색').fill('배포');
  await expect(command.getByText('배포 시작')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(command).toBeHidden();
  await expect(commandTrigger).toBeFocused();

  const menuTrigger = page.getByRole('button', { name: '작업 메뉴' });
  await menuTrigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '설정 열기' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  const tooltipTrigger = page.getByRole('button', { name: '도움말' });
  await tooltipTrigger.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toHaveText('최근 배포 상태를 새로 확인합니다.');
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  await expectAccessible(page);
  assertNoErrors();
});

test('the fixture keeps direct ThemeMenu selections synchronized and accessible @theme-core', async ({ userPage: page }) => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  const assertNoErrors = observeBrowserErrors(page);

  await page.goto('/primitives-fixture');

  const fixtureMenus = page.locator('[data-theme-menu-fixture]');
  const triggers = fixtureMenus.getByRole('button', { name: /테마 설정: 현재/ });
  await expect(triggers).toHaveCount(2);

  const expectSynchronizedPreference = async (preference: 'system' | 'light' | 'dark', label: string) => {
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(preference);
    await expect.poll(() => triggers.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
      `테마 설정: 현재 ${label}`,
      `테마 설정: 현재 ${label}`,
    ]);
  };

  for (const [preference, label] of [['light', '라이트'], ['dark', '다크'], ['system', '시스템']] as const) {
    await triggers.first().click();
    const choice = page.getByRole('menuitemradio', { name: label });
    await expect(choice).toHaveAttribute('aria-checked', 'false');
    await choice.click();
    await expect(choice).toBeHidden();
    await expectSynchronizedPreference(preference, label);
  }

  await triggers.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitemradio', { name: '시스템' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitemradio', { name: '라이트' })).toBeHidden();
  await expectSynchronizedPreference('light', '라이트');
  await expect(triggers.first()).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitemradio', { name: '라이트' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitemradio', { name: '라이트' })).toBeHidden();
  await expect(triggers.first()).toBeFocused();

  await triggers.first().click();
  await expect(page.getByRole('menuitemradio', { name: '라이트' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'raibit-theme', newValue: 'dark' }));
  });
  await expectSynchronizedPreference('dark', '다크');
  await expect.poll(() => page.evaluate(() => document.cookie.includes('raibit-theme=dark'))).toBe(true);

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('raibit-theme-change', { detail: 'light' }));
  });
  await expectSynchronizedPreference('light', '라이트');

  assertNoErrors();
});

test('the ThemeMenu normalizes invalid storage and keeps the cookie path available when storage is disabled @theme-core', async ({ userPage: page }) => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  const assertNoErrors = observeBrowserErrors(page);

  await page.addInitScript(() => {
    localStorage.setItem('raibit-theme', 'unexpected');
  });
  await page.goto('/primitives-fixture');
  const triggers = page.locator('[data-theme-menu-fixture]').getByRole('button', { name: /테마 설정: 현재/ });
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('system');
  await expect(triggers).toHaveCount(2);

  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'raibit-theme') throw new DOMException('storage disabled', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  await triggers.first().click();
  await page.getByRole('menuitemradio', { name: '다크' }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
  await expect.poll(() => page.evaluate(() => document.cookie.includes('raibit-theme=dark'))).toBe(true);
  assertNoErrors();
});

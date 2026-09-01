import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  captureScreenshot,
  expectAccessible,
  expectRoute,
  FIXTURE_ORIGIN,
  installSession,
  nativeFormData,
  observeBrowserErrors,
} from '../helpers/contracts';

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === '1';
const projectPath = '/org/raibit/projects/prj_fixture_001';
const readyDeploymentId = 'dep_fixture_ready';
const queuedDeploymentId = 'dep_fixture_queued';
const buildingDeploymentId = 'dep_fixture_building';
const imageReadyDeploymentId = 'dep_fixture_image_ready';
const longDeploymentId = `dep_fixture_${'x'.repeat(180)}`;
const hostileDeploymentId = 'dep_fixture_<img src=x onerror=fixture-hostile-id>';
const resourceId = 'res_fixture_pg';
const resourceBase = `${projectPath}/resources/${resourceId}/console`;

const deploymentViews = [
  ['overview', '이미지 정보'],
  ['logs', '빌드 로그'],
  ['events', '배포 이벤트'],
  ['rollback', '롤백 확인'],
  ['cancel', '배포 취소'],
] as const;

const resourceViews = [
  ['overview', '리소스 정보'],
  ['schema', '데이터 구조'],
  ['query', '쿼리'],
  ['connection', '서비스 연결'],
  ['backups', '백업'],
  ['provision', '프로비저닝'],
  ['provider', '공급자 명령'],
] as const;

function deploymentBase(deploymentId: string): string {
  return `${projectPath}/deployments/${encodeURIComponent(deploymentId)}`;
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test.describe('@t13-operations', () => {
  test.skip(!fixtureEnabled, 'requires RAIBITSERVER_E2E_FIXTURES=1');
  test.beforeEach(async ({ request }) => {
    const reset = await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
    expect(reset.ok()).toBe(true);
  });

  for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }] as const) {
    test(`all twelve operation views are addressable and accessible at ${viewport.width}px`, async ({ userPage }) => {
      test.slow();
      await userPage.setViewportSize(viewport);
      const assertNoErrors = observeBrowserErrors(userPage);
      for (const [view, heading] of deploymentViews) {
        const path = deploymentBase(readyDeploymentId);
        await userPage.goto(`${path}?view=${view}`);
        await expectRoute(userPage, path, { view });
        await expect(userPage.getByRole('heading', { name: heading }).first()).toBeVisible();
        if (view === 'logs' || view === 'events') {
          const stream = userPage.getByRole('log');
          await expect(stream).toHaveAttribute('tabindex', '0');
          await expect(stream).toHaveCSS('background-color', 'rgb(28, 28, 28)');
          await expect(stream).toHaveCSS('color', 'rgb(255, 255, 255)');
          await stream.focus();
          await expect(stream).toBeFocused();
        }
        await expectNoDocumentOverflow(userPage);
        await expectAccessible(userPage);
      }
      for (const [view, heading] of resourceViews) {
        await userPage.goto(`${resourceBase}?view=${view}`);
        await expectRoute(userPage, resourceBase, { view });
        await expect(userPage.getByRole('heading', { name: heading }).first()).toBeVisible();
        await expectNoDocumentOverflow(userPage);
        await expectAccessible(userPage);
      }
      await expect(userPage.locator('body')).not.toContainText('postgresql://provider-managed@fixture.invalid/primary');
      assertNoErrors();
    });
  }

  test('rollback and cancel preserve exact payloads, return paths, confirmation, and status gating', async ({ userPage }) => {
    const readyPath = deploymentBase(readyDeploymentId);
    await userPage.goto(`${readyPath}?view=rollback`);
    expect(await nativeFormData(userPage, '#rollback-deployment')).toEqual([
      ['_returnTo', `${readyPath}?view=overview`],
      ['imageUrl', ''],
    ]);
    await userPage.getByRole('button', { name: '롤백', exact: true }).click();
    await expectRoute(userPage, readyPath, { view: 'rollback' });
    expect(await userPage.locator('#rollback-deployment input[name="confirmed"]').evaluate((input) => input instanceof HTMLInputElement && input.validity.valueMissing)).toBe(true);
    await userPage.getByLabel('롤백 확인').check();
    expect(await nativeFormData(userPage, '#rollback-deployment')).toEqual([
      ['_returnTo', `${readyPath}?view=overview`],
      ['imageUrl', ''],
      ['confirmed', 'true'],
    ]);
    await userPage.getByRole('button', { name: '롤백', exact: true }).click();
    await expectRoute(userPage, readyPath, { view: 'overview', notice: 'saved' });

    for (const deploymentId of [queuedDeploymentId, buildingDeploymentId, imageReadyDeploymentId]) {
      const path = deploymentBase(deploymentId);
      await userPage.goto(`${path}?view=cancel`);
      await expect(userPage.locator(`form[action*="/deployments/${deploymentId}/cancel"]`)).toBeVisible();
    }
    const buildingPath = deploymentBase(buildingDeploymentId);
    await userPage.goto(`${buildingPath}?view=cancel`);
    await userPage.getByLabel('취소 사유').fill('중복 배포');
    expect(await nativeFormData(userPage, 'form[action*="/cancel"]')).toEqual([
      ['_returnTo', `${buildingPath}?view=overview`],
      ['reason', '중복 배포'],
    ]);
    await userPage.getByRole('button', { name: '배포 취소' }).click();
    await expectRoute(userPage, buildingPath, { view: 'overview', notice: 'saved' });

    await userPage.goto(`${readyPath}?view=cancel`);
    await expect(userPage.locator('form[action*="/cancel"]')).toHaveCount(0);
    await expect(userPage.getByText('현재 상태에서는 취소할 수 없습니다.')).toBeVisible();
    await expect(userPage.getByText(/QUEUED, BUILDING, IMAGE_READY 상태에서만/)).toBeVisible();
  });

  test('resource query, provider, provision, and attach forms preserve exact native payloads', async ({ userPage }) => {
    await userPage.goto(`${resourceBase}?view=query`);
    expect(await nativeFormData(userPage, 'form[action*="/console/query"]')).toEqual([
      ['_returnTo', `${resourceBase}?view=query`],
      ['query', 'SELECT 1'],
    ]);
    await userPage.getByRole('button', { name: '쿼리 실행' }).click();
    await expectRoute(userPage, resourceBase, { view: 'query', notice: 'saved' });
    await userPage.getByLabel('변경 쿼리 확인').check();
    expect(await nativeFormData(userPage, 'form[action*="/console/query"]')).toEqual([
      ['_returnTo', `${resourceBase}?view=query`],
      ['query', 'SELECT 1'],
      ['confirmed', 'true'],
    ]);

    await userPage.goto(`${resourceBase}?view=provider`);
    expect(await nativeFormData(userPage, '#provider-command')).toEqual([
      ['_returnTo', `${resourceBase}?view=provider`],
      ['command', 'SELECT 1'],
    ]);
    await userPage.getByRole('button', { name: '공급자 명령 실행' }).click();
    await expectRoute(userPage, resourceBase, { view: 'provider' });
    expect(await userPage.locator('#provider-command input[name="confirmed"]').evaluate((input) => input instanceof HTMLInputElement && input.validity.valueMissing)).toBe(true);
    await userPage.getByLabel('변경·삭제 확인').check();
    expect(await nativeFormData(userPage, '#provider-command')).toEqual([
      ['_returnTo', `${resourceBase}?view=provider`],
      ['command', 'SELECT 1'],
      ['confirmed', 'true'],
    ]);
    await userPage.getByRole('button', { name: '공급자 명령 실행' }).click();
    await expectRoute(userPage, resourceBase, { view: 'provider', notice: 'saved' });

    await userPage.goto(`${resourceBase}?view=provision`);
    expect(await nativeFormData(userPage, '#provisioning')).toEqual([
      ['_returnTo', `${resourceBase}?view=provision`],
      ['dryRun', 'true'],
    ]);
    await userPage.getByRole('button', { name: '계획 만들기' }).click();
    await expectRoute(userPage, resourceBase, { view: 'provision', notice: 'saved' });

    await userPage.goto(`${resourceBase}?view=connection`);
    await userPage.getByLabel('서비스 ID').fill('svc_fixture_web');
    await userPage.getByLabel('환경 변수 접두사').fill('DATABASE');
    expect(await nativeFormData(userPage, '#connection')).toEqual([
      ['_returnTo', `${resourceBase}?view=connection`],
      ['serviceId', 'svc_fixture_web'],
      ['envPrefix', 'DATABASE'],
    ]);
    await userPage.getByRole('button', { name: '서비스에 연결' }).click();
    await expectRoute(userPage, resourceBase, { view: 'connection', notice: 'saved' });
  });

  test('long and hostile deployment data remains literal, complete, and bounded on mobile', async ({ browser }, testInfo) => {
    const longContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await installSession(longContext, 'fixture-user-long');
    const longPage = await longContext.newPage();
    try {
      const longPath = deploymentBase(longDeploymentId);
      await longPage.goto(`${longPath}?view=logs`);
      const longLine = longPage.getByText(/^build-output-x{768}$/);
      await expect(longLine).toBeVisible();
      expect((await longLine.textContent())?.length).toBe('build-output-'.length + 768);
      await expectNoDocumentOverflow(longPage);
    } finally {
      await longContext.close();
    }

    const hostileContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await installSession(hostileContext, 'fixture-user-populated');
    const hostilePage = await hostileContext.newPage();
    const assertNoErrors = observeBrowserErrors(hostilePage);
    try {
      const hostilePath = deploymentBase(hostileDeploymentId);
      await hostilePage.goto(`${hostilePath}?view=logs`);
      await expect(hostilePage.getByText(`배포 ID · ${hostileDeploymentId}`, { exact: true })).toBeVisible();
      const hostileLog = hostilePage.getByRole('log', { name: '마스킹된 빌드 로그' });
      await expect(hostileLog).toContainText('<img src=x onerror="fixture-hostile-log">');
      expect(await hostileLog.textContent()).toContain('<img src=x onerror="fixture-hostile-log">');
      await expect(hostilePage.locator('img[src="x"]')).toHaveCount(0);
      await expect(hostilePage.locator('body')).not.toContainText('postgresql://provider-managed@fixture.invalid/primary');
      await expectNoDocumentOverflow(hostilePage);
      await expectAccessible(hostilePage);
      await captureScreenshot(hostilePage, testInfo, 't13-hostile-long-mobile');
      assertNoErrors();
    } finally {
      await hostileContext.close();
    }
  });

  test('empty and partial operation data render deterministic safe states', async ({ browser }, testInfo) => {
    const emptyContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await installSession(emptyContext, 'fixture-user-empty');
    const emptyPage = await emptyContext.newPage();
    try {
      await emptyPage.goto(`${deploymentBase(readyDeploymentId)}?view=logs`);
      await expect(emptyPage.getByText('표시할 빌드 로그가 없습니다.')).toBeVisible();
      await emptyPage.goto(`${resourceBase}?view=schema`);
      await expect(emptyPage.getByText('표시할 데이터 구조가 없습니다.')).toBeVisible();
      await expectNoDocumentOverflow(emptyPage);
      await expectAccessible(emptyPage);
    } finally {
      await emptyContext.close();
    }

    const partialContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await installSession(partialContext, 'fixture-user-partial');
    const partialPage = await partialContext.newPage();
    const assertNoErrors = observeBrowserErrors(partialPage, [500, 503]);
    try {
      await partialPage.goto(`${deploymentBase(readyDeploymentId)}?view=events`);
      await expect(partialPage.getByRole('alert').filter({ hasText: '일부 정보를 불러오지 못했습니다.' })).toContainText('일부 정보를 불러오지 못했습니다.');
      await expect(partialPage.locator('div.load-error-summary[role="alert"]')).toHaveCount(1);
      await expect(partialPage.locator('aside.load-error-summary')).toHaveCount(0);
      await expect(partialPage.locator('body')).not.toContainText(/fixture_operation_data_unavailable|secret|password|token/i);
      await partialPage.goto(`${resourceBase}?view=schema`);
      await expect(partialPage.getByRole('alert').filter({ hasText: '일부 정보를 불러오지 못했습니다.' })).toContainText('일부 정보를 불러오지 못했습니다.');
      await expect(partialPage.locator('body')).not.toContainText(/fixture_resource_data_unavailable|postgresql:\/\//i);
      await expectNoDocumentOverflow(partialPage);
      await expectAccessible(partialPage);
      await captureScreenshot(partialPage, testInfo, 't13-partial-resource-desktop');
      assertNoErrors();
    } finally {
      await partialContext.close();
    }
  });
});

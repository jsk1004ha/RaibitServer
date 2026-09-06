import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../helpers/fixtures';
import { captureScreenshot, expectAccessible, installSession } from '../helpers/contracts';
import { PLATFORM_EXPANSION_DELEGATED_TASK35_ROWS, PLATFORM_EXPANSION_DELEGATED_TASK41_ROWS, PLATFORM_EXPANSION_EXECUTABLE_ROWS, PLATFORM_EXPANSION_MATRIX, PLATFORM_EXPANSION_NEGATIVE_ROWS, type PlatformExpansionRow } from '../feature-expansion-matrix';
import { createOutcomeRecorder, validatePlatformExpansionMatrix, writePlatformExpansionReport } from '../platform-expansion-report.js';

const evidencePath = process.env.RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH;
const negativeIds = new Set(PLATFORM_EXPANSION_NEGATIVE_ROWS.map((row) => row.id));
const positives = PLATFORM_EXPANSION_EXECUTABLE_ROWS.filter((row) => !negativeIds.has(row.id));
const positiveRecorder = createOutcomeRecorder(positives, 'positive', [...PLATFORM_EXPANSION_DELEGATED_TASK35_ROWS, ...PLATFORM_EXPANSION_DELEGATED_TASK41_ROWS].map((row) => row.id));
const negativeRecorder = createOutcomeRecorder(PLATFORM_EXPANSION_NEGATIVE_ROWS, 'negative');

function colorScheme(theme: PlatformExpansionRow['theme']): 'light' | 'dark' | 'no-preference' {
  return theme === 'system' ? 'no-preference' : theme;
}

async function openRow(page: Page, row: PlatformExpansionRow): Promise<void> {
  await page.setViewportSize(row.viewport);
  await page.emulateMedia({ colorScheme: colorScheme(row.theme), reducedMotion: row.accessibility.includes('reduced-motion') ? 'reduce' : 'no-preference' });
  await page.goto(row.route);
  if (row.zoom === 200) await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(page.viewportSize()).toEqual(row.viewport);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function record(page: Page, row: PlatformExpansionRow, testInfo: TestInfo, api: Readonly<{ status: number; method: string; path: string }>, recorder: ReturnType<typeof createOutcomeRecorder>): Promise<void> {
  await expectAccessible(page);
  const screenshot = row.representativeVisual ? await captureScreenshot(page, testInfo, 'task49-' + row.id) : undefined;
  recorder.record(row.id, { status: 'passed', api, a11y: 'axe:zero-violations', representativeVisual: row.representativeVisual, screenshot });
}

async function runRow(row: PlatformExpansionRow, page: Page, testInfo: TestInfo, recorder: ReturnType<typeof createOutcomeRecorder>): Promise<void> {
  if (row.driver === 'auth-login') {
    await openRow(page, row);
    await page.getByLabel('이메일').fill('user@fixture.test');
    await page.getByLabel('비밀번호').fill('fixture-user-pass');
    await page.getByLabel('비밀번호').press('Enter');
    await expect(page).toHaveURL(/\/org\/raibit\/projects\?notice=saved$/);
    return record(page, row, testInfo, { status: 200, method: 'POST', path: '/api/auth/login' }, recorder);
  }
  if (row.driver === 'loading-boundary') {
    await openRow(page, row);
    await expect(page.locator('main#main-content')).toHaveAttribute('aria-busy', 'true');
    return record(page, row, testInfo, { status: 200, method: 'GET', path: '/errors/fixtures/loading' }, recorder);
  }
  if (row.driver === 'empty-projects') {
    await installSession(page.context(), 'fixture-user-empty');
    await openRow(page, row);
    await expect(page.getByRole('heading')).toBeVisible();
    return record(page, row, testInfo, { status: 200, method: 'GET', path: '/api/control/projects' }, recorder);
  }
  if (row.driver === 'github-disconnect' || row.driver === 'github-conflict' || row.driver === 'github-retryable') {
    const status = row.driver === 'github-conflict' ? 409 : row.driver === 'github-retryable' ? 503 : 200;
    if (status !== 200) await page.route('**/api/control/organizations/org_fixture_001/integrations/github/ghi_fixture/disconnect', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: status === 409 ? 'stale_version' : 'unavailable' }) }));
    await openRow(page, row);
    await page.getByRole('checkbox', { name: 'RAIBITSERVER 연결 해제의 영향을 확인했습니다.' }).check();
    const response = page.waitForResponse((candidate) => candidate.url().includes('/disconnect') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: 'RAIBITSERVER 연결 해제' }).click();
    expect((await response).status()).toBe(status);
    if (status === 200) await expect(page.getByRole('status')).toContainText('RAIBITSERVER 연결이 해제되었습니다.');
    else {
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('status')).not.toContainText('RAIBITSERVER 연결이 해제되었습니다.');
    }
    return record(page, row, testInfo, { status, method: 'POST', path: '/api/control/organizations/org_fixture_001/integrations/github/ghi_fixture/disconnect' }, recorder);
  }
  if (row.driver === 'project-save' || row.driver === 'project-stale') {
    await openRow(page, row);
    await page.getByLabel('프로젝트 이름').fill(row.driver === 'project-save' ? 'Task49 변경 프로젝트' : '내 로컬 변경');
    if (row.driver === 'project-stale') expect(await page.evaluate(async () => (await fetch('/api/control/projects/prj_fixture_001/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt: '2026-08-31T03:00:00.000Z', description: '동시 변경' }) })).status)).toBe(200);
    const response = page.waitForResponse((candidate) => candidate.url().includes('/projects/prj_fixture_001/settings') && candidate.request().method() === 'PATCH');
    await page.getByRole('button', { name: '변경 사항 저장' }).click();
    const status = row.driver === 'project-save' ? 200 : 409;
    expect((await response).status()).toBe(status);
    if (status === 200) await expect(page.getByText(/에 저장됨/)).toBeVisible();
    else {
      await expect(page.getByRole('button', { name: '최신 설정 불러오기' })).toBeVisible();
      await expect(page.getByLabel('프로젝트 이름')).toHaveValue('내 로컬 변경');
    }
    return record(page, row, testInfo, { status, method: 'PATCH', path: '/api/control/projects/prj_fixture_001/settings' }, recorder);
  }
  if (row.driver === 'project-delete-denied') {
    await openRow(page, row);
    await page.getByRole('button', { name: '삭제 요청' }).click();
    await page.getByLabel('영향과 복구 절차를 확인했습니다.').check();
    const response = page.waitForResponse((candidate) => candidate.url().includes('/settings/deletion') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: '삭제 요청 등록' }).click();
    expect((await response).status()).toBe(403);
    await expect(page.getByRole('alert')).toContainText('권한');
    await expect(page.getByText('삭제 요청이 대기열에 등록되었습니다.')).toHaveCount(0);
    return record(page, row, testInfo, { status: 403, method: 'POST', path: '/api/control/projects/prj_fixture_001/settings/deletion' }, recorder);
  }
  if (row.driver === 'service-preview') {
    await openRow(page, row);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await page.getByLabel('공통 상태 경로').fill('../health');
    await page.getByLabel('CPU 요청').fill('many');
    await expect(page.getByRole('button', { name: '빌드 계획 미리보기' })).toBeDisabled();
    expect(requests.some((path) => path.includes('/deployments'))).toBe(false);
    return record(page, row, testInfo, { status: 422, method: 'CLIENT', path: '/services/svc_fixture_web/settings' }, recorder);
  }
  if (row.driver === 'deployment-retry') {
    await openRow(page, row);
    await page.getByRole('button', { name: '재시도', exact: true }).click();
    const response = page.waitForResponse((candidate) => candidate.url().includes('/deployments/dep_fixture_failed/retry') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: '재시도 요청', exact: true }).click();
    expect((await response).status()).toBe(202);
    await expect(page.getByText('새 배포:')).toContainText('dep_fixture_retry_successor');
    return record(page, row, testInfo, { status: 202, method: 'POST', path: '/api/control/deployments/dep_fixture_failed/retry' }, recorder);
  }
  if (row.driver === 'stream-switch' || row.driver === 'stream-degraded') {
    if (row.driver === 'stream-degraded') await page.route('**/api/control/services/svc_fixture_worker/logs/stream', (route) => route.abort());
    await openRow(page, row);
    if (row.driver === 'stream-degraded') {
      await expect(page.locator('[data-runtime-log-status="fallback"]')).toBeVisible({ timeout: 20_000 });
      return record(page, row, testInfo, { status: 503, method: 'GET', path: '/api/control/services/svc_fixture_worker/logs/stream' }, recorder);
    }
    await page.getByLabel('로그 서비스').selectOption('svc_fixture_web');
    await expect(page.getByRole('log', { name: '런타임 로그' })).toContainText('web-only-initial-log');
    await expect.poll(async () => (await page.request.get('http://127.0.0.1:3411/__fixture/requests')).json()).toMatchObject({ requests: expect.arrayContaining([expect.objectContaining({ path: '/api/services/svc_fixture_worker/logs/stream', streamClosed: true })]) });
    return record(page, row, testInfo, { status: 200, method: 'GET', path: '/api/services/svc_fixture_worker/logs/stream' }, recorder);
  }
  if (row.driver === 'resource-restore') {
    await openRow(page, row);
    await page.getByTestId('backup-row-bak_fixture_ready').getByRole('button', { name: '복구 준비' }).click();
    await page.getByLabel('새 리소스 이름').fill('task49-restored');
    const response = page.waitForResponse((candidate) => candidate.url().includes('/backups/bak_fixture_ready/restores') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: '복구 요청', exact: true }).click();
    expect((await response).status()).toBe(202);
    return record(page, row, testInfo, { status: 202, method: 'POST', path: '/api/control/backups/bak_fixture_ready/restores' }, recorder);
  }
  if (row.driver === 'custom-domain-create') {
    await openRow(page, row);
    await expect(page.getByRole('link', { name: '생성된 서비스 URL 새 창에서 열기' })).toBeVisible();
    await page.getByRole('button', { name: '사용자 도메인 추가' }).click();
    await page.getByLabel('호스트 이름').fill('task49.fixture.example');
    const response = page.waitForResponse((candidate) => candidate.url().includes('/projects/prj_fixture_001/domains') && candidate.request().method() === 'POST');
    await page.getByRole('button', { name: 'TXT 검증 값 만들기' }).click();
    expect((await response).status()).toBe(201);
    await page.getByRole('button', { name: 'TXT 값을 확인했습니다' }).click();
    await expect(page.getByText('이번에만 표시하는 DNS TXT 값')).toHaveCount(0);
    return record(page, row, testInfo, { status: 201, method: 'POST', path: '/api/control/projects/prj_fixture_001/domains' }, recorder);
  }
  throw new TypeError('platform_expansion_unknown_driver:' + row.id);
}

function pageFor(row: PlatformExpansionRow, pages: Readonly<{ page: Page; userPage: Page; adminPage: Page }>): Page {
  if (row.actor === 'anonymous') return pages.page;
  if (row.actor === 'user') return pages.userPage;
  if (row.actor === 'admin') return pages.adminPage;
  throw new TypeError('platform_expansion_unknown_actor:' + row.id);
}

function register(rows: readonly PlatformExpansionRow[], recorder: ReturnType<typeof createOutcomeRecorder>): void {
  for (const row of rows) test('@platform-expansion ' + row.id, async ({ page, userPage, adminPage }, testInfo) => {
    await runRow(row, pageFor(row, { page, userPage, adminPage }), testInfo, recorder);
  });
}

test.describe('@platform-expansion', () => {
  test.beforeAll(() => { validatePlatformExpansionMatrix(PLATFORM_EXPANSION_MATRIX); });
  register(positives, positiveRecorder);
  test.afterAll(async () => {
    if (!evidencePath) throw new TypeError('RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH is required');
    await writePlatformExpansionReport(positiveRecorder.finish(), evidencePath);
  });
});
test.describe('@platform-expansion-negative', () => {
  register(PLATFORM_EXPANSION_NEGATIVE_ROWS, negativeRecorder);
  test.afterAll(async () => {
    if (!evidencePath) throw new TypeError('RAIBITSERVER_PLATFORM_EXPANSION_REPORT_PATH is required');
    await writePlatformExpansionReport(negativeRecorder.finish(), evidencePath);
  });
});

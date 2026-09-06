import { test, expect } from '../helpers/fixtures';
import { captureScreenshot, FIXTURE_ORIGIN, expectAccessible, observeBrowserErrors } from '../helpers/contracts';

const projectPath = '/org/raibit/projects/prj_fixture_001';

type FixtureRequest = Readonly<{ path: string; lastEventId: string | null; streamClosed?: boolean }>;

async function fixtureRequests(): Promise<readonly FixtureRequest[]> {
  const response = await fetch(`${FIXTURE_ORIGIN}/__fixture/requests`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.requests)) return [];
  return body.requests.filter((entry): entry is FixtureRequest => isRecord(entry)
    && typeof entry.path === 'string'
    && (entry.lastEventId === null || typeof entry.lastEventId === 'string')
    && (entry.streamClosed === undefined || typeof entry.streamClosed === 'boolean'));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

test('@t20 applies same-connection log deltas and cleans up the stream when the selected service changes', async ({ userPage }, testInfo) => {
  const before = await fixtureRequests();
  await userPage.goto(`${projectPath}?view=logs&serviceId=svc_fixture_worker&retained=1`);
  await expect(userPage.getByLabel('로그 서비스')).toHaveValue('svc_fixture_worker');
  const runtimeLog = userPage.getByRole('log', { name: '런타임 로그' });
  await expect(runtimeLog).toContainText('worker-only-initial-log');
  await expect(runtimeLog).toContainText('<img src=x onerror="fixture-hostile-log">');
  await expect(runtimeLog.locator('img')).toHaveCount(0);
  await expect(runtimeLog).not.toContainText('web-only-initial-log');
  await expect(userPage.locator('[data-runtime-log-status="live"]')).toBeVisible();
  await expect(runtimeLog).toContainText('worker-only-live-log');
  await expect(runtimeLog.getByText('worker-only-initial-log')).toHaveCount(1);
  await expect(runtimeLog.getByText('worker-only-live-log')).toHaveCount(1);
  await expect.poll(async () => (await fixtureRequests()).slice(before.length).filter((entry) => entry.path === '/api/services/svc_fixture_worker/logs/stream').length).toBe(1);
  await captureScreenshot(userPage, testInfo, 'task-20-runtime-log-delta');
  await userPage.getByLabel('로그 서비스').selectOption('svc_fixture_web');
  await expect.poll(() => new URL(userPage.url()).search).toBe('?view=logs&serviceId=svc_fixture_web&retained=1');
  await expect(userPage.getByRole('log', { name: '런타임 로그' })).toContainText('web-only-initial-log');
  await expect.poll(async () => (await fixtureRequests()).slice(before.length).some((entry) => entry.path === '/api/services/svc_fixture_worker/logs/stream' && entry.streamClosed === true)).toBe(true);
  await expectAccessible(userPage);
});

test('@t20 missing or invalid service selection deterministically falls back to the first service without loading every service log', async ({ userPage }) => {
  const before = await fixtureRequests();
  for (const query of ['?view=logs', '?view=logs&serviceId=missing-service']) {
    await userPage.goto(`${projectPath}${query}`);
    await expect(userPage.getByLabel('로그 서비스')).toHaveValue('svc_fixture_web');
    await expect(userPage.getByRole('log', { name: '런타임 로그' })).toContainText('web-only-initial-log');
  }
  const requests = (await fixtureRequests()).slice(before.length);
  expect(requests.some((entry) => entry.path === '/api/services/svc_fixture_worker/logs')).toBe(false);
  await userPage.getByRole('button', { name: '실시간 따라가기 중지' }).click();
  await expect(userPage.locator('[data-runtime-log-status="stopped"]')).toBeVisible();
  await userPage.getByRole('button', { name: '실시간 따라가기 재개' }).click();
  await expect(userPage.locator('[data-runtime-log-status="live"]')).toBeVisible();
});

test('@t20 filters and copies only the selected service rows', async ({ userPage }) => {
  await userPage.goto(`${projectPath}?view=logs&serviceId=svc_fixture_worker`);
  const runtimeLog = userPage.getByRole('log', { name: '런타임 로그' });
  await expect(runtimeLog).toContainText('worker-only-initial-log');
  await userPage.getByLabel('로그 검색').fill('live-log');
  await expect(runtimeLog).toContainText('worker-only-live-log');
  await expect(runtimeLog).not.toContainText('worker-only-initial-log');
  await userPage.getByRole('button', { name: '표시한 로그 복사' }).click();
  await expect(userPage.getByText('표시한 로그를 복사했습니다.')).toBeVisible();
});

test('@t20 switches to bounded polling after repeated SSE failures', async ({ userPage }) => {
  await userPage.route('**/api/control/services/svc_fixture_worker/logs/stream', (route) => route.abort());
  await userPage.goto(`${projectPath}?view=logs&serviceId=svc_fixture_worker`);
  await expect(userPage.locator('[data-runtime-log-status="fallback"]')).toBeVisible({ timeout: 20_000 });
  await expect(userPage.getByRole('log', { name: '런타임 로그' })).toContainText('worker-only-initial-log');
});

test('@t20 runtime logs remain responsive and console-clean at desktop and mobile', async ({ userPage }, testInfo) => {
  const assertNoErrors = observeBrowserErrors(userPage);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }] as const) {
    await userPage.setViewportSize(viewport);
    await userPage.goto(`${projectPath}?view=logs&serviceId=svc_fixture_worker`);
    const runtimeLog = userPage.getByRole('log', { name: '런타임 로그' });
    await expect(runtimeLog).toContainText('worker-only-initial-log');
    await expect(runtimeLog).toContainText('<img src=x onerror="fixture-hostile-log">');
    await expect(runtimeLog.locator('img')).toHaveCount(0);
    expect(await userPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await captureScreenshot(userPage, testInfo, `task-20-runtime-logs-${viewport.width}`);
  }
  assertNoErrors();
});

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures";
import {
  captureScreenshot,
  expectAccessible,
  FIXTURE_ORIGIN,
  observeBrowserErrors,
} from "../helpers/contracts";

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === "1";
const publicOrigin = "http://localhost:3410";
const routes = [
  "/",
  "/status",
  "/support",
  "/privacy",
  "/contributors",
] as const;
const viewports = [
  { width: 375, height: 812, label: "mobile" },
  { width: 1280, height: 800, label: "desktop" },
] as const;
const publicStates = ["populated", "empty", "partial", "long"] as const;

async function expectPublicDocument(page: Page): Promise<void> {
  await expect(page.locator("main#main-content")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function selectPublicState(
  request: APIRequestContext,
  publicSiteScenario: (typeof publicStates)[number],
): Promise<void> {
  const response = await request.post(`${FIXTURE_ORIGIN}/__fixture/state`, {
    data: { publicSiteScenario },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ publicSiteScenario });
}

async function resetPublicState(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ publicSiteScenario: "populated" });
}

test.describe("@t9-public-surfaces", () => {
  test.skip(!fixtureEnabled, "requires RAIBITSERVER_E2E_FIXTURES=1");

  for (const viewport of viewports) {
    test(`public routes remain accessible without overflow at ${viewport.width}px`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const assertNoBrowserErrors = observeBrowserErrors(page);
      try {
        for (const route of routes) {
          await page.goto(`${publicOrigin}${route}`, {
            waitUntil: "networkidle",
          });
          await expectPublicDocument(page);
          await expectAccessible(page);
        }
        await page.goto(publicOrigin, { waitUntil: "networkidle" });
        await expect(
          page.getByRole("heading", { name: "운영 중인 사이트" }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: /결정적 운영 프로젝트/ }),
        ).toHaveAttribute("rel", "noreferrer");
        await captureScreenshot(
          page,
          testInfo,
          `t9-public-home-${viewport.label}`,
        );
        assertNoBrowserErrors();
      } finally {
        await context.close();
      }
    });

    test(`public site populated, empty, partial, and long states remain deterministic at ${viewport.width}px`, async ({
      browser,
      request,
    }, testInfo) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        for (const state of publicStates) {
          await selectPublicState(request, state);
          await page.goto(publicOrigin, { waitUntil: "networkidle" });
          await expectPublicDocument(page);
          await expectAccessible(page);
          if (state === "populated") {
            await expect(
              page.getByRole("link", { name: /결정적 운영 프로젝트/ }),
            ).toHaveAttribute("rel", "noreferrer");
          } else if (state === "long") {
            await expect(page.locator("body")).toContainText(
              "배포 로그가 길어져도",
            );
          } else {
            await expect(page.getByText("운영 사이트 준비 중")).toBeVisible();
          }
          await captureScreenshot(
            page,
            testInfo,
            `t9-public-${state}-${viewport.label}`,
          );
        }
      } finally {
        await resetPublicState(request);
        await context.close();
      }
    });
  }

  for (const viewport of viewports) {
    test(`status refresh failure retains the last snapshot and announces stale data at ${viewport.width}px`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        await page.route("**/api/status", (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"offline"}',
          }),
        );
        await page.goto(`${publicOrigin}/status`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "상태 새로고침" }).click();
        await expect(page.getByText("자동 갱신 지연")).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "모든 시스템 정상" }),
        ).toBeVisible();
        await expect(page.locator('[aria-live="polite"]')).toBeVisible();
        await captureScreenshot(
          page,
          testInfo,
          `t9-status-stale-${viewport.label}`,
        );
      } finally {
        await context.close();
      }
    });
  }
});

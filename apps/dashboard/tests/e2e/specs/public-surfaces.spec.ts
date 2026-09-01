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

  test("public chrome keeps its deliberate two-row mobile and one-row desktop contract @t5-public-chrome", async ({
    browser,
  }, testInfo) => {
    for (const theme of ["light", "dark"] as const) {
      for (const viewport of [
        { width: 375, height: 812, label: "mobile" },
        { width: 768, height: 900, label: "tablet" },
        { width: 1280, height: 800, label: "desktop" },
      ] as const) {
        const context = await browser.newContext({ viewport });
        await context.addCookies([
          { domain: "localhost", name: "raibit-theme", path: "/", value: theme },
        ]);
        const page = await context.newPage();
        const assertNoBrowserErrors = observeBrowserErrors(page);
        try {
          await page.goto(publicOrigin, { waitUntil: "networkidle" });
          const header = page.locator("header");
          const brand = header.getByRole("link", { name: "RAIBIT SERVER" });
          const themeMenu = header.getByRole("button", { name: /테마 설정: 현재/ });
          const navigation = header.getByRole("navigation", { name: "공개 화면 탐색" });
          const login = header.getByRole("link", { name: "로그인" });
          const consoleLink = header.getByRole("link", { name: "콘솔 들어가기" });
          const chrome = [brand, themeMenu, navigation, login, consoleLink];

          for (const item of chrome) await expect(item).toBeVisible();
          await expect(page.getByRole("link", { name: "운영 현황" })).toHaveAttribute("href", "/status");
          await expect(page.getByRole("link", { name: "지원", exact: true })).toHaveAttribute("href", "/support");
          await expectAccessible(page);
          await expectPublicDocument(page);

          const [brandBox, themeBox, navigationBox, loginBox, consoleBox] = await Promise.all(
            [brand, themeMenu, navigation, login, consoleLink].map((item) => item.boundingBox()),
          );
          for (const box of [brandBox, themeBox, navigationBox, loginBox, consoleBox]) expect(box).not.toBeNull();
          if (!brandBox || !themeBox || !navigationBox || !loginBox || !consoleBox) throw new Error("public chrome bounding box missing");

          if (viewport.width < 640) {
            expect(Math.abs((brandBox.y + brandBox.height / 2) - (themeBox.y + themeBox.height / 2))).toBeLessThanOrEqual(2);
            expect(navigationBox.y).toBeGreaterThan(themeBox.y);
            expect(loginBox.y).toBeGreaterThan(themeBox.y);
            expect(consoleBox.y).toBeGreaterThan(themeBox.y);
          } else {
            for (const box of [themeBox, navigationBox, loginBox, consoleBox]) {
              expect(Math.abs((brandBox.y + brandBox.height / 2) - (box.y + box.height / 2))).toBeLessThanOrEqual(2);
            }
          }

          const skipLink = page.getByRole("link", { name: "본문으로 건너뛰기" });
          await skipLink.focus();
          await expect(skipLink).toBeFocused();
          for (const item of [brand, themeMenu, page.getByRole("link", { name: "운영 현황" }), page.getByRole("link", { name: "지원", exact: true }), login, consoleLink]) {
            await page.keyboard.press("Tab");
            await expect(item).toBeFocused();
          }

          const lineBoxes = await page.getByRole("heading", { name: "만들고, 올리고, 운영하세요." }).evaluate((heading) => {
            const phrase = "올리고";
            const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
            let textNode = walker.nextNode();
            while (textNode && !textNode.textContent?.includes(phrase)) textNode = walker.nextNode();
            if (!textNode?.textContent) return [];
            const start = textNode.textContent.indexOf(phrase);
            const range = document.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, start + phrase.length);
            return Array.from(range.getClientRects()).map(({ height, width, x, y }) => ({ height, width, x, y }));
          });
          expect(lineBoxes).toHaveLength(1);
          expect(lineBoxes[0]?.width).toBeGreaterThan(0);
          await captureScreenshot(page, testInfo, `t5-public-home-${theme}-${viewport.label}`);
          assertNoBrowserErrors();
        } finally {
          await context.close();
        }
      }
    }
  });

  test("public chrome keeps the longest home action set visible at 320px @t5-public-chrome", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(publicOrigin, { waitUntil: "networkidle" });
      await expectPublicDocument(page);
      for (const item of [
        page.locator("header").getByRole("link", { name: "RAIBIT SERVER" }),
        page.getByRole("button", { name: /테마 설정: 현재/ }),
        page.getByRole("link", { name: "운영 현황" }),
        page.getByRole("link", { name: "지원", exact: true }),
        page.getByRole("link", { name: "로그인" }),
        page.getByRole("link", { name: "콘솔 들어가기" }),
      ]) {
        await expect(item).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });

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
        const staleAnnouncer = page.locator('footer[aria-live="polite"]').filter({ hasText: '자동 갱신 지연' });
        await expect(staleAnnouncer).toHaveCount(1);
        await expect(staleAnnouncer).toBeVisible();
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

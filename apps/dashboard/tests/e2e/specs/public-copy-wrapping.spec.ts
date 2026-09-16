import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures";
import {
  captureScreenshot,
  expectAccessible,
  FIXTURE_ORIGIN,
  observeBrowserErrors,
} from "../helpers/contracts";

const fixtureEnabled = process.env.RAIBITSERVER_E2E_FIXTURES === "1";
const publicOrigin = "http://localhost:3410";

const shortCopyRoutes = [
  {
    path: "/status",
    names: ["RAIBIT SERVER 상태", "서비스와 데이터 계층의 실시간 운영 현황을 확인합니다."],
  },
  {
    path: "/support",
    names: ["도움이 필요하신가요?", "계정 · 승인 · 배포 문의를 운영진에게 보내 주세요."],
  },
  {
    path: "/contributors",
    names: ["기여자", "RAIBIT SERVER를 만들고 운영하는 사람들입니다."],
  },
  {
    path: "/privacy",
    names: ["RAIBIT SERVER는 서비스 운영에 필요한 최소한의 개인정보를 처리하고 안전하게 보호합니다."],
  },
] as const;

async function expectKoreanWordsStayIntact(locator: Locator): Promise<void> {
  const splitWords = await locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Text && node.data.trim()) nodes.push(node);
    }

    const containerWidth = Math.min(element.getBoundingClientRect().width, document.documentElement.clientWidth);
    const split: string[] = [];
    for (const node of nodes) {
      const matcher = /[가-힣]+/gu;
      for (const match of node.data.matchAll(matcher)) {
        if (match.index === undefined) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (range.getClientRects().length < 2) continue;

        const probe = document.createElement("span");
        probe.textContent = match[0];
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none";
        document.body.append(probe);
        const exceedsAvailableWidth = probe.getBoundingClientRect().width > containerWidth;
        probe.remove();
        if (!exceedsAvailableWidth) split.push(match[0]);
      }
    }
    return split;
  });

  expect(splitWords).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test.describe("@t8-public-copy-wrapping", () => {
  test.skip(!fixtureEnabled, "requires RAIBITSERVER_E2E_FIXTURES=1");

  test("short Korean public copy keeps words intact in dark narrow views and the 375px light regression", async ({ browser }, testInfo) => {
    test.slow();
    for (const scenario of [
      { theme: "dark", viewport: { width: 320, height: 812 } },
      { theme: "dark", viewport: { width: 375, height: 812 } },
      { theme: "light", viewport: { width: 375, height: 812 } },
    ] as const) {
      const context = await browser.newContext({ viewport: scenario.viewport });
      await context.addCookies([{ name: "raibit-theme", value: scenario.theme, domain: "localhost", path: "/" }]);
      const page = await context.newPage();
      const assertNoBrowserErrors = observeBrowserErrors(page);
      try {
        for (const route of shortCopyRoutes) {
          await page.goto(`${publicOrigin}${route.path}`, { waitUntil: "networkidle" });
          await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.theme);
          for (const name of route.names) await expectKoreanWordsStayIntact(page.locator("main").getByText(name, { exact: true }));
          await expectAccessible(page);
          await expectNoHorizontalOverflow(page);
          await captureScreenshot(page, testInfo, `t8-${route.path.slice(1)}-${scenario.theme}-${scenario.viewport.width}`);
        }
        assertNoBrowserErrors();
      } finally {
        await context.close();
      }
    }
  });

  test("long fixture content and an injected email token remain visible without horizontal overflow", async ({ browser, request }) => {
    test.slow();
    const fixture = await request.post(`${FIXTURE_ORIGIN}/__fixture/state`, { data: { publicSiteScenario: "long" } });
    expect(fixture.ok()).toBe(true);
    const context = await browser.newContext({ viewport: { width: 320, height: 812 } });
    await context.addCookies([{ name: "raibit-theme", value: "dark", domain: "localhost", path: "/" }]);
    const page = await context.newPage();
    const assertNoBrowserErrors = observeBrowserErrors(page);
    const injectedEmail = `fixture-${"x".repeat(512)}@example.test`;
    try {
      await page.goto(publicOrigin, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toContainText("배포 로그가 길어져도");
      await expectNoHorizontalOverflow(page);

      await page.goto(`${publicOrigin}/support`, { waitUntil: "networkidle" });
      const email = page.locator("h2.break-all");
      await email.evaluate((element, value) => { element.textContent = value; }, injectedEmail);
      await expect(email).toHaveText(injectedEmail);
      await expectNoHorizontalOverflow(page);
      assertNoBrowserErrors();
    } finally {
      await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
      await context.close();
    }
  });
});

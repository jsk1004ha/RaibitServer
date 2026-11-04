import { expect, test } from '@playwright/test';
import { captureScreenshot, installSession } from '../helpers/contracts';

const project = '/org/raibit/projects/prj_fixture_001';
const routes = [
  '/org/org_fixture_001/projects/new', `${project}?view=new-service`,
  '/login?mode=verify&email=ux%40fixture.test',
  '/github?step=attach&projectId=prj_fixture_001&serviceId=svc_fixture_web',
  '/org/org_fixture_001/projects', '/org/org_fixture_001/members', '/organizations/new',
  '/account/settings', '/account/security', '/guide',
  `${project}/resources/res_fixture_pg/console?view=connection`,
  `${project}/deployments/dep_fixture_ready?view=overview`,
  `${project}/deployments/dep_fixture_building?view=logs`, `${project}?view=logs&serviceId=svc_fixture_worker`,
] as const;

for (const width of [375, 768, 1280]) for (const theme of ['light', 'dark'] as const) {
  test(`updated screens ${width} ${theme}`, async ({ browser }, info) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await installSession(context, 'fixture-admin-populated');
      await context.addCookies([{ name: 'raibit-theme', value: theme, domain: 'console.localhost', path: '/', sameSite: 'Lax' }]);
      for (const [index, route] of routes.entries()) {
        if (process.env.RAIBITSERVER_UX_VISUAL_ROUTES && !process.env.RAIBITSERVER_UX_VISUAL_ROUTES.split(',').includes(String(index))) continue;
        await page.goto(route);
        await page.waitForFunction(() => document.querySelector('main') !== null && !document.querySelector('main[aria-busy="true"]'), undefined, { timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.querySelectorAll<HTMLElement>('main, [data-slot="scroll-area-viewport"]').forEach((element) => { element.scrollTop = 0; });
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const projectNavigation = page.locator('[data-project-nav-viewport]');
        const navigationHint = projectNavigation.locator('[data-horizontal-scroll-hint]:visible');
        if (await navigationHint.count()) {
          const viewport = await projectNavigation.boundingBox();
          const hint = await navigationHint.boundingBox();
          expect(viewport).not.toBeNull();
          expect(hint).not.toBeNull();
          expect(hint!.x).toBeGreaterThanOrEqual(viewport!.x - 1);
          expect(hint!.x + hint!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
        }
        await captureScreenshot(page, info, `${index}-${width}-${theme}`);
      }
      expect(errors).toEqual([]);
      await info.attach('routes', { body: JSON.stringify(routes), contentType: 'application/json' });
    } finally {
      await context.close();
    }
  });
}

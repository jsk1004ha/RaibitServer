import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { consoleOrganizationLinks, resolveOrganizationRouteValue } from '../apps/dashboard/lib/console-navigation.ts';

test('console navigation keeps display labels separate from the verified organization route', async () => {
  const subject = { organizationId: 'org_123', organizationIds: ['org_123'] };
  const routeValue = resolveOrganizationRouteValue({ subject, memberships: [{ organizationId: 'org_123' }] });
  assert.equal(routeValue, 'org_123');

  for (const displayLabel of ['관리자', 'GitHub 연동', 'RAIBITSERVER']) {
    const links = consoleOrganizationLinks(routeValue);
    assert.deepEqual(links, {
      projects: '/org/org_123/projects',
      createProject: '/org/org_123/projects/new',
    });
    assert.doesNotMatch(JSON.stringify(links), new RegExp(encodeURIComponent(displayLabel)));
  }

  const [admin, github, guide, shell] = await Promise.all([
    readFile(new URL('../apps/dashboard/app/admin/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/app/github/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/app/guide/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/dashboard/components/console-ui.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(admin, /orgValue="관리자"/);
  assert.match(github, /orgValue="GitHub 연동"/);
  assert.match(guide, /<ConsoleShell active="guide"\s+orgValue=\{orgSlug\}\s+orgRouteValue=\{orgSlug\}>/);
  assert.match(shell, /resolveOrganizationRouteValue[\s\S]*?memberships: me\.body\?\.memberships/);
  assert.doesNotMatch(`${admin}\n${github}`, /orgRouteValue="(?:관리자|GitHub 연동|RAIBITSERVER)"/);
  assert.doesNotMatch(guide, /orgRouteValue="(?:관리자|GitHub 연동|RAIBITSERVER)"/);
});

test('route-scoped project screens can preserve an explicit organization identifier', () => {
  const routeValue = resolveOrganizationRouteValue({
    requested: 'club/alpha',
    subject: { organizationId: 'org_123' },
  });
  assert.equal(routeValue, 'club/alpha');
  assert.deepEqual(consoleOrganizationLinks(routeValue), {
    projects: '/org/club%2Falpha/projects',
    createProject: '/org/club%2Falpha/projects/new',
  });
});

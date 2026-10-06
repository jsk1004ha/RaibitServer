import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleOrganizationLinks, resolveOrganizationRouteValue } from '../apps/dashboard/lib/console-navigation.ts';

test('console navigation keeps display labels separate from the verified organization route', () => {
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

  for (const requested of ['관리자', 'GitHub 연동', 'RAIBITSERVER']) {
    assert.equal(resolveOrganizationRouteValue({ requested, subject, memberships: [{ organizationId: 'org_123' }] }), 'org_123');
  }
});

test('route-scoped project screens can preserve an explicit organization identifier', () => {
  const routeValue = resolveOrganizationRouteValue({
    requested: 'club/alpha',
    subject: { organizationId: 'org_123' },
    memberships: [{ organizationId: 'club/alpha' }, { organizationId: 'org_123' }],
  });
  assert.equal(routeValue, 'club/alpha');
  assert.deepEqual(consoleOrganizationLinks(routeValue), {
    projects: '/org/club%2Falpha/projects',
    createProject: '/org/club%2Falpha/projects/new',
  });
});

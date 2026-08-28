import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMainLink } from './project-main-link.ts';

test('project main link prefers the web service and follows the generated tenant route', () => {
  assert.deepEqual(projectMainLink({
    organizationSlug: 'gdg-hongik',
    project: { slug: 'festival-2026' },
    services: [{ name: 'api', type: 'web' }, { name: 'web', type: 'web' }, { name: 'worker', type: 'worker' }],
    baseDomain: 'example.test',
  }), {
    href: 'https://apps--gdg-hongik--festival-2026.example.test',
    label: 'apps--gdg-hongik--festival-2026.example.test',
  });
});

test('project main link omits projects without an available web service', () => {
  assert.equal(projectMainLink({
    organizationSlug: 'team',
    project: { slug: 'jobs' },
    services: [{ name: 'worker', type: 'worker' }, { name: 'old-web', type: 'web', status: 'DELETING' }],
  }), null);
});

test('project main link rejects an unsafe configured base domain', () => {
  const link = projectMainLink({
    organizationSlug: 'team',
    project: { slug: 'site' },
    services: [{ name: 'web', type: 'web' }],
    baseDomain: 'https://attacker.invalid/path',
  });
  assert.equal(link?.href, 'https://apps--team--site.raibitserver.app');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as navigation from './console-navigation.ts';

const memberships = [{ organizationId: 'org_a', organizationSlug: 'alpha' }, { organizationId: 'org_b', organizationSlug: 'beta' }];
test('keeps the preferred workspace when no route workspace was supplied', () => {
  assert.equal(navigation.resolveOrganizationRouteValue({ preferred: 'org_b', memberships }), 'org_b');
});
test('explicit authorized workspace takes precedence over preference', () => {
  assert.equal(navigation.resolveOrganizationRouteValue({ requested: 'alpha', preferred: 'org_b', memberships }), 'org_a');
});
test('untrusted preference cannot supply membership or authorization', () => {
  assert.equal(navigation.resolveOrganizationRouteValue({ preferred: 'org_outside', memberships }), 'org_a');
  assert.equal(navigation.resolveOrganizationRouteValue({ preferred: 'org_outside', memberships: [] }), '');
});

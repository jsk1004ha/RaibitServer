import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

test('membership display includes organization name and slug without changing its identity or scope', () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: '라이빗 개발팀', slug: 'raibit-team' });
  const foreign = store.createOrganization({ name: '다른 팀', slug: 'other-team' });
  const user = store.createUser({ email: 'display@example.test' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'VIEWER' });
  const memberships = store.listMembershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].organizationId, organization.id);
  assert.equal(memberships[0].organizationName, '라이빗 개발팀');
  assert.equal(memberships[0].organizationSlug, 'raibit-team');
  assert.equal(memberships.some((membership) => membership.organizationId === foreign.id), false);
});

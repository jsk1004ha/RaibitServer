import assert from 'node:assert/strict';
import test from 'node:test';
import * as target from './github-attach-target.ts';

const services = [
  { id: 's1', projectId: 'p1', name: 'First', projectName: 'One' },
  { id: 's2', projectId: 'p2', name: 'Second', projectName: 'Two' },
  { id: 's3', projectId: 'p2', name: 'Worker', projectName: 'Two' },
];
const authorizedProjectIds = ['p1', 'p2'];

for (const [name, query, expected] of [
  ['explicit second service', { projectId: 'p2', serviceId: 's2' }, 's2'],
  ['no automatic first service', {}, undefined],
  ['project without service requires a choice', { projectId: 'p2' }, undefined],
]) test(`resolves ${name}`, () => {
  // Given the API-authorized project and service catalog.
  assert.equal(typeof target.resolveGitHubAttachTarget, 'function');
  // When parsing and resolving the supplied URL context.
  const result = target.resolveGitHubAttachTarget({ query, services, authorizedProjectIds });
  // Then selection reflects only an explicit service choice.
  assert.equal(result.error, null);
  assert.equal(result.selectedService?.id, expected);
  assert.deepEqual(result.services.map((service) => service.id), query.projectId ? ['s2', 's3'] : ['s1', 's2', 's3']);
});

for (const query of [
  { projectId: ['p1', 'p2'] }, { projectId: '' }, { serviceId: ['s2'] },
  { projectId: 'missing' }, { serviceId: 'missing' },
  { projectId: 'p1', serviceId: 's2' }, { projectId: '../p1' },
]) test(`rejects invalid or mismatched context ${JSON.stringify(query)}`, () => {
  // Given an invalid, inaccessible or mismatched URL target.
  assert.equal(typeof target.resolveGitHubAttachTarget, 'function');
  // When resolving the target.
  const result = target.resolveGitHubAttachTarget({ query, services, authorizedProjectIds });
  // Then no mutation target or fallback options are offered.
  assert.ok(result.error);
  assert.equal(result.selectedService, null);
  assert.deepEqual(result.services, []);
});

test('excludes services outside the authorized project set', () => {
  // Given a service catalog containing another workspace.
  assert.equal(typeof target.resolveGitHubAttachTarget, 'function');
  // When the integration permits only p2.
  const result = target.resolveGitHubAttachTarget({ query: {}, services, authorizedProjectIds: ['p2'] });
  // Then the other workspace is not selectable.
  assert.deepEqual(result.services.map((service) => service.id), ['s2', 's3']);
});

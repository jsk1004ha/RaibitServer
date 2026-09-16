import test from 'node:test';
import assert from 'node:assert/strict';
import { findProductionFixtureRepository } from '../scripts/production-evidence/lib/production-bootstrap.mjs';

const page = (repositories, nextCursor) => ({ statusCode: 200, body: {
  installationId: '700', generation: 4, refreshStatus: 'IDLE', lastSuccessfulSyncAt: '2026-09-06T00:00:00.000Z',
  staleAt: null, repositories, nextCursor,
} });
const repository = (id, fullName) => ({ id: `record-${id}`, installationId: '700', githubRepoId: String(id), fullName,
  repoUrl: `https://github.com/${fullName}`, defaultBranch: 'main', private: true, owner: fullName.split('/')[0],
  name: fullName.split('/')[1], normalizedIdentity: fullName.toLowerCase(), accessState: 'ACCESSIBLE', generation: 4 });

test('production bootstrap follows an opaque repository cursor to an exact page-two fixture', async () => {
  const paths = [];
  const responses = [page([repository(1, 'club/other')], 'opaque +/?'), page([repository(2, 'club/private-app')], null)];
  const result = await findProductionFixtureRepository({ installationId: '700', fixtureRepository: 'club/private-app',
    controlPlaneJson: async ({ path }) => { paths.push(path); return responses.shift(); } });
  assert.equal(result.githubRepoId, '2');
  assert.deepEqual(paths, ['/api/github/installations/700/repositories',
    '/api/github/installations/700/repositories?cursor=opaque%20%2B%2F%3F']);
});

test('production bootstrap rejects stale, cross-generation, repeated-cursor, inaccessible, and duplicate repository pages', async () => {
  const first = page([repository(1, 'club/other')], 'next');
  const failures = [
    [{ ...first, body: { ...first.body, refreshStatus: 'STALE', staleAt: '2026-09-06T00:01:00.000Z' } }],
    [first, { ...page([repository(2, 'club/private-app')], null), body: { ...page([], null).body, generation: 5, repositories: [repository(2, 'club/private-app')] } }],
    [first, page([], 'next')],
    [page([{ ...repository(2, 'club/private-app'), accessState: 'REVOKED' }], null)],
    [page([repository(2, 'club/private-app')], 'next'), page([repository(2, 'club/private-app')], null)],
  ];
  for (const responses of failures) {
    await assert.rejects(findProductionFixtureRepository({ installationId: '700', fixtureRepository: 'club/private-app',
      controlPlaneJson: async () => responses.shift() }), { reason: 'private_repository_access_unverified' });
  }
});

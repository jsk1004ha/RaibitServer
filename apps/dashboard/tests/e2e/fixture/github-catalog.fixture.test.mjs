import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKENS, responseFor } from './data.mjs';

const pathname = '/github/installations/9001/repositories';

function list(search = '') {
  return responseFor({ token: TOKENS.admin, method: 'GET', pathname, searchParams: new URLSearchParams(search) });
}

test('GitHub catalog fixture pages 125 repositories as 50, 50, and 25 rows', () => {
  const first = list();
  const second = list(`cursor=${encodeURIComponent(first.body.nextCursor)}`);
  const third = list(`cursor=${encodeURIComponent(second.body.nextCursor)}`);

  assert.equal(first.status, 200);
  assert.equal(first.body.repositories.length, 50);
  assert.equal(second.body.repositories.length, 50);
  assert.equal(third.body.repositories.length, 25);
  assert.equal(first.body.repositories[0].id, 'repo_fixture');
  assert.equal(third.body.repositories[0].id, 'repo_fixture_101');
  assert.equal(third.body.nextCursor, null);
  assert.equal(first.body.repositories[0].accessState, 'ACCESSIBLE');
  assert.equal(third.body.repositories.at(-1).accessState, 'REVOKED');
});

test('GitHub catalog fixture binds opaque cursors to the normalized filter', () => {
  const filtered = list('q=%20RAIBIT%2FFIXTURE-REPOSITORY-101%20');
  const invalidCursor = list('cursor=not-an-upstream-cursor');

  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.repositories.map((repository) => repository.id), ['repo_fixture_101']);
  assert.equal(filtered.body.nextCursor, null);
  assert.equal(invalidCursor.status, 400);
});

test('GitHub catalog refresh fixture requires an admin and matching versions', () => {
  const allowed = responseFor({ token: TOKENS.admin, method: 'POST', pathname: `${pathname}/refresh`, searchParams: new URLSearchParams(), body: { expectedIntegrationVersion: 7, expectedGeneration: 12 } });
  const stale = responseFor({ token: TOKENS.admin, method: 'POST', pathname: `${pathname}/refresh`, searchParams: new URLSearchParams(), body: { expectedIntegrationVersion: 7, expectedGeneration: 11 } });
  const denied = responseFor({ token: TOKENS.user, method: 'POST', pathname: `${pathname}/refresh`, searchParams: new URLSearchParams(), body: { expectedIntegrationVersion: 7, expectedGeneration: 12 } });

  assert.deepEqual(allowed, { status: 200, body: { refreshed: true, repositoryCount: 125, generation: 12, refreshStatus: 'IDLE', lastSuccessfulSyncAt: '2026-08-31T03:00:00.000Z', staleAt: null } });
  assert.equal(stale.status, 409);
  assert.equal(denied.status, 403);
});

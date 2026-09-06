import assert from 'node:assert/strict';
import test from 'node:test';
import { githubConflictRecovery } from '../../../lib/control-plane-errors.js';
import { TOKENS, resetGitHubMutationFixture, responseFor } from './data.mjs';

const importPath = '/github/repositories/import';
const attachPath = '/projects/prj_fixture_001/services/svc_fixture_web/github';
const syncPath = '/github/repositories/raibit%2Ffixture-app/sync';

function mutation(pathname, body) {
  return responseFor({ token: TOKENS.admin, method: 'POST', pathname, searchParams: new URLSearchParams(), body });
}

test('GitHub conflict fixture returns every prescribed typed 409 recovery action', () => {
  resetGitHubMutationFixture();
  const rows = [
    [importPath, { repositoryId: 'repo_fixture_duplicate' }, 'GITHUB_DUPLICATE_IMPORT', 'OPEN_EXISTING_PROJECT'],
    [importPath, { serviceSlug: 'taken' }, 'GITHUB_PROJECT_SLUG_COLLISION', 'CHOOSE_NEW_SLUG'],
    [attachPath, { repositoryId: 'repo_fixture_bound' }, 'GITHUB_SERVICE_ALREADY_BOUND', 'OPEN_EXISTING_SERVICE'],
    [attachPath, { integrationId: 'ghi_fixture_mismatch' }, 'GITHUB_INSTALLATION_MISMATCH', 'REATTACH_INSTALLATION'],
    [attachPath, { branch: 'missing' }, 'GITHUB_DEFAULT_BRANCH_MISSING', 'SELECT_BRANCH'],
    [attachPath, { branch: 'changed' }, 'GITHUB_DEFAULT_BRANCH_CHANGED', 'SELECT_BRANCH'],
    [syncPath, { idempotencyKey: 'fixture-revoked' }, 'GITHUB_SOURCE_ACCESS_REVOKED', 'REFRESH_CATALOG'],
    [importPath, { expectedCatalogGeneration: 11 }, 'GITHUB_CATALOG_STALE', 'REFRESH_CATALOG'],
    [syncPath, { idempotencyKey: 'fixture-disconnected' }, 'GITHUB_SOURCE_DISCONNECTED', 'REATTACH_INSTALLATION'],
  ];
  for (const [pathname, body, code, action] of rows) {
    const response = mutation(pathname, body);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      statusCode: 409, message: code, error: code, code, retryable: false, terminal: true, permission: false,
      recovery: response.body.recovery,
    });
    assert.equal(githubConflictRecovery(response.body, response.status)?.code, code);
    assert.equal(githubConflictRecovery(response.body, response.status)?.recovery.action, action);
  }
});

test('GitHub mutation fixture reuses one idempotency result and rejects changed intent', () => {
  resetGitHubMutationFixture();
  const first = mutation(importPath, { repositoryId: 'repo_fixture', integrationId: 'ghi_fixture', idempotencyKey: 'fixture-key' });
  const retry = mutation(importPath, { repositoryId: 'repo_fixture', integrationId: 'ghi_fixture', idempotencyKey: 'fixture-key' });
  const changed = mutation(importPath, { repositoryId: 'repo_fixture_002', integrationId: 'ghi_fixture', idempotencyKey: 'fixture-key' });

  assert.deepEqual(retry, first);
  assert.equal(changed.status, 409);
  assert.deepEqual(githubConflictRecovery(changed.body, changed.status), { statusCode: 409, message: 'GITHUB_IDEMPOTENCY_CONFLICT', error: 'GITHUB_IDEMPOTENCY_CONFLICT', code: 'GITHUB_IDEMPOTENCY_CONFLICT', retryable: false, terminal: true, permission: false, recovery: { action: 'CANCEL' } });
});

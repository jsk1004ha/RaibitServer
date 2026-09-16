import assert from 'node:assert/strict';
import test from 'node:test';
import { githubConflictRecovery } from './control-plane-errors.js';

test('GitHub conflicts retain only a known code and its action-scoped recovery fields', () => {
  assert.deepEqual(githubConflictRecovery({
    statusCode: 409,
    code: 'GITHUB_SERVICE_ALREADY_BOUND',
    message: 'GITHUB_SERVICE_ALREADY_BOUND',
    recovery: { action: 'OPEN_EXISTING_SERVICE', projectId: 'prj_fixture_001', serviceId: 'svc_fixture_web', installationId: '9001' },
  }, 409), { statusCode: 409, message: 'GITHUB_SERVICE_ALREADY_BOUND', error: 'GITHUB_SERVICE_ALREADY_BOUND', code: 'GITHUB_SERVICE_ALREADY_BOUND', retryable: false, terminal: true, permission: false, recovery: { action: 'OPEN_EXISTING_SERVICE', projectId: 'prj_fixture_001', serviceId: 'svc_fixture_web' } });
});

test('GitHub conflict cancellation is opaque and unsupported recovery data is rejected', () => {
  assert.deepEqual(githubConflictRecovery({
    statusCode: 409,
    code: 'GITHUB_DUPLICATE_IMPORT',
    recovery: { action: 'CANCEL', projectId: 'foreign_project' },
  }, 409), { statusCode: 409, message: 'GITHUB_DUPLICATE_IMPORT', error: 'GITHUB_DUPLICATE_IMPORT', code: 'GITHUB_DUPLICATE_IMPORT', retryable: false, terminal: true, permission: false, recovery: { action: 'CANCEL' } });
  assert.equal(githubConflictRecovery({ code: 'GITHUB_UNKNOWN', recovery: { action: 'CANCEL' } }, 409), null);
});

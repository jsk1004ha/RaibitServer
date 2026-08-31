import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneErrorCode } from './control-plane-errors.js';

test('control-plane errors preserve a specific NestJS message before the generic label', () => {
  assert.equal(controlPlaneErrorCode({
    message: 'github_install_state_expired',
    error: 'Bad Request',
    statusCode: 400,
  }, 400), 'github_install_state_expired');
});

test('control-plane errors accept explicit codes and reject unsafe messages', () => {
  assert.equal(controlPlaneErrorCode({ code: 'github_installation_not_accessible' }, 403), 'github_installation_not_accessible');
  assert.equal(controlPlaneErrorCode({ message: '<script>alert(1)</script>' }, 400), 'request_failed_400');
  assert.equal(controlPlaneErrorCode({ error: 'github_request_failed' }, 502), 'github_request_failed');
});

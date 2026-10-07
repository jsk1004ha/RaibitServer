import test from 'node:test';
import assert from 'node:assert/strict';
import { loginFailurePath, loginReturnState, withFlashMessage } from './request-security.js';
import { loginServerErrorMessage } from './login-errors.js';

const origin = 'https://console.raibit.kr';

test('login failures show the error on login and retain a clean retry destination', () => {
  const path = loginFailurePath(origin, '/console?error=request_failed_500');
  const result = new URL(withFlashMessage(origin, path, 'error', 'request_failed_500'), origin);
  assert.equal(result.pathname, '/login');
  assert.equal(result.searchParams.get('error'), 'request_failed_500');
  assert.equal(result.searchParams.get('next'), '/console');
});

test('legacy nested login errors remain visible and are removed from the success destination', () => {
  assert.deepEqual(loginReturnState(origin, '/console?tab=projects&error=request_failed_500&notice=saved#services'), {
    next: '/console?tab=projects#services',
    error: 'request_failed_500',
  });
});

test('login return state rejects external, proxy and recursive login destinations', () => {
  for (const path of ['//evil.example', '/\\evil.example', 'https://evil.example', '/api/control/auth/login', '/login?next=/console']) {
    assert.equal(loginReturnState(origin, path).next, '/console', path);
  }
});

test('server failures ask the user to retry instead of changing credentials', () => {
  for (const code of ['request_failed_500', 'request_failed_502', 'request_failed_503', 'request_failed_504', 'control_plane_unavailable', 'control_plane_timeout', 'control_plane_response_timeout']) {
    assert.match(loginServerErrorMessage(code), /서버/);
    assert.doesNotMatch(loginServerErrorMessage(code), /입력/);
  }
  assert.equal(loginServerErrorMessage('invalid_credentials'), null);
  assert.equal(loginServerErrorMessage('request_failed_400'), null);
});

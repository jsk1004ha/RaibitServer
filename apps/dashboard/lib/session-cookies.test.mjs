import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readSessionToken, setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from './session-cookies.js';

const { NextResponse } = createRequire(import.meta.url)('next/server');

test('only one well-formed host-prefixed session is accepted, never a legacy fallback', () => {
  for (const header of [null, 'raibitserver_session=attacker', `${SESSION_COOKIE_NAME}=`,
    `${SESSION_COOKIE_NAME}=one; ${SESSION_COOKIE_NAME}=two`, `${SESSION_COOKIE_NAME}=same; ${SESSION_COOKIE_NAME}=same`,
    `${SESSION_COOKIE_NAME}=%0d%0aBearer`, `${SESSION_COOKIE_NAME}=${'a'.repeat(4097)}`]) {
    assert.equal(readSessionToken(header), undefined);
  }
  assert.equal(readSessionToken(`raibitserver_session=attacker; ${SESSION_COOKIE_NAME}=victim.token-123`), 'victim.token-123');
  assert.equal(readSessionToken(`${SESSION_COOKIE_NAME}=victim; raibitserver_session=attacker`), 'victim');
});

test('session issuance expires the old host cookie and sets mandatory host-prefix attributes', () => {
  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, 'fixture-session');
  const current = response.cookies.get(SESSION_COOKIE_NAME);
  assert.equal(current.value, 'fixture-session');
  assert.equal(current.secure, true);
  assert.equal(current.httpOnly, true);
  assert.equal(current.path, '/');
  assert.equal(current.sameSite, 'lax');
  assert.equal(current.domain, undefined);
  assert.ok(current.maxAge > 0);
  assert.equal(response.cookies.get('raibitserver_session').maxAge, 0);
});

test('logout and revoked-session cleanup expire both names without weakening host isolation', () => {
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  for (const name of [SESSION_COOKIE_NAME, 'raibitserver_session']) {
    const cookie = response.cookies.get(name);
    assert.equal(cookie.value, '');
    assert.equal(cookie.maxAge, 0);
    assert.equal(cookie.path, '/');
    assert.equal(cookie.secure, true);
    assert.equal(cookie.domain, undefined);
  }
});

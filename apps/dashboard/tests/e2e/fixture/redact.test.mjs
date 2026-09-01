import assert from 'node:assert/strict';
import test from 'node:test';
import { redactFixtureRequestBody } from './redact.mjs';

test('Given a fixture request ledger body, when it contains safe fields and nested credentials, then safe structure is preserved while every sensitive value is masked', () => {
  const body = {
    email: 'user@fixture.test',
    code: '123456',
    password: 'password-must-not-escape',
    profile: {
      name: 'Fixture User',
      token: 'token-must-not-escape',
      preferences: [{ channel: 'email' }, { apiSecret: 'secret-must-not-escape', enabled: true }],
    },
    actions: [{ type: 'verify', code: '654321' }, { refreshToken: 'refresh-must-not-escape' }],
  };

  const redacted = redactFixtureRequestBody(body);

  assert.deepEqual(redacted, {
    email: 'user@fixture.test',
    code: '123456',
    password: '[MASKED]',
    profile: {
      name: 'Fixture User',
      token: '[MASKED]',
      preferences: [{ channel: 'email' }, { apiSecret: '[MASKED]', enabled: true }],
    },
    actions: [{ type: 'verify', code: '654321' }, { refreshToken: '[MASKED]' }],
  });
  assert.doesNotMatch(JSON.stringify(redacted), /password-must-not-escape|token-must-not-escape|secret-must-not-escape|refresh-must-not-escape/);
});

test('Given a fixture request ledger body, when it has scalar and array roots, then the redaction boundary remains deterministic', () => {
  assert.equal(redactFixtureRequestBody('safe-value'), 'safe-value');
  assert.equal(redactFixtureRequestBody(null), null);
  assert.deepEqual(redactFixtureRequestBody([{ email: 'user@fixture.test', password: 'hidden' }]), [{ email: 'user@fixture.test', password: '[MASKED]' }]);
});

test('Given an email-verification fixture request, when an OTP code reaches the request ledger, then the OTP is masked without hiding an unrelated safe code field', () => {
  const body = { email: 'verify@fixture.test', code: '123456', nested: { code: '654321' } };
  const verification = redactFixtureRequestBody(body, '/api/auth/email/verify');
  const unrelated = redactFixtureRequestBody(body, '/api/resources/res_fixture_pg/console/query');

  assert.deepEqual(verification, { email: 'verify@fixture.test', code: '[MASKED]', nested: { code: '[MASKED]' } });
  assert.doesNotMatch(JSON.stringify(verification), /123456|654321/);
  assert.deepEqual(unrelated, body);
});

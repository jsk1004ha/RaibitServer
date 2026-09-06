import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApiHandler } from '../packages/core/src/api.ts';
import { assertCurrentSession } from '../packages/core/src/auth.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { createSessionToken, hashPassword, verifyPassword } from '../packages/core/src/identity.ts';
import {
  completePasswordRecovery,
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_TTL_SECONDS,
  requestPasswordRecovery,
} from '../packages/core/src/password-recovery.ts';
import { InMemoryControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { enforceAuthAbuseLimits } from '../packages/core/src/security.ts';

const jwtSecret = 'password-recovery-test-secret';
const verificationEnv = Object.freeze({
  NODE_ENV: 'test',
  RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <password-reset@example.test>',
  RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '246810',
});

function createEligibleUser(repository, email, overrides = {}) {
  return repository.store.createUser({
    email,
    name: 'Reset User',
    passwordHash: hashPassword('old-password'),
    approvalStatus: 'APPROVED',
    emailVerifiedAt: new Date().toISOString(),
    ...overrides,
  });
}

function recoveryOptions(overrides = {}) {
  return { jwtSecret, env: verificationEnv, ...overrides };
}

test('password recovery happy path replaces the password, revokes old JWTs, and has one concurrent winner', async (t) => {
  const repository = new InMemoryControlPlaneRepository();
  const email = 'happy-reset@example.test';
  const user = createEligibleUser(repository, email);
  const deliveries = [];
  await requestPasswordRecovery(repository, { email }, recoveryOptions({ scheduleDelivery: (task) => deliveries.push(task) }));

  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => completePasswordRecovery(repository, {
    email,
    code: '246810',
    newPassword: 'new-password',
  }, recoveryOptions())));

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 19);
  const updated = repository.store.findUserByEmail(email);
  assert.equal(verifyPassword('new-password', updated.passwordHash), true);
  assert.equal(verifyPassword('old-password', updated.passwordHash), false);
  assert.equal(updated.sessionVersion, user.sessionVersion + 1);
  assert.equal(repository.store.emailVerificationCodes.every((row) => row.purpose !== 'password-reset' || row.consumedAt), true);
  assert.throws(() => assertCurrentSession({ id: user.id, authMode: 'jwt', claims: { sessionVersion: user.sessionVersion } }, updated), /session has been revoked/);
  assert.equal(deliveries.length, 1);
  const audit = repository.store.auditLogs.find((row) => row.action === 'user.password:reset');
  assert.deepEqual(audit.metadata, {});
  assert.equal(JSON.stringify(audit).includes('246810'), false);
  assert.equal(JSON.stringify(audit).includes('new-password'), false);
  t.diagnostic(JSON.stringify({ consumers: 20, winners: 1, sessionVersionIncrement: 1, activeChallenges: 0, auditSecretMatches: 0 }));
});

test('password recovery adversarial matrix enforces parity, TTL, attempt cap, cooldown, weak passwords, replay, and delivery cleanup', async (t) => {
  const classes = [
    ['eligible', { passwordHash: hashPassword('old-password'), approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString() }],
    ['oauth-only', { passwordHash: null, approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString() }],
    ['banned', { passwordHash: hashPassword('old-password'), approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString(), bannedAt: new Date().toISOString() }],
    ['unapproved', { passwordHash: hashPassword('old-password'), approvalStatus: 'PENDING', emailVerifiedAt: new Date().toISOString() }],
    ['unverified', { passwordHash: hashPassword('old-password'), approvalStatus: 'APPROVED', emailVerifiedAt: null }],
    ['unknown', null],
  ];
  const publicResults = [];

  for (const [name, userInput] of classes) {
    const repository = new InMemoryControlPlaneRepository();
    const email = `${name}@example.test`;
    if (userInput) repository.store.createUser({ email, name, ...userInput });
    const scheduled = [];
    publicResults.push(await requestPasswordRecovery(repository, { email }, recoveryOptions({
      now: 10_000,
      scheduleDelivery: (task) => scheduled.push(task),
    })));
    const challenge = repository.store.emailVerificationCodes[0];
    assert.equal(Date.parse(challenge.expiresAt) - Date.parse(challenge.sentAt), PASSWORD_RESET_TTL_SECONDS * 1_000, name);
    assert.equal(challenge.purpose, 'password-reset', name);
    assert.equal(scheduled.length, 1, name);
    assert.equal(challenge.payload.kind, name === 'eligible' ? 'password-reset' : 'request-padding', name);
  }
  assert.deepEqual(publicResults, classes.map(() => ({ accepted: true })));

  const cooldownRepository = new InMemoryControlPlaneRepository();
  const rateEnv = {
    RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '100',
  };
  await enforceAuthAbuseLimits(cooldownRepository, { action: 'password-reset', email: 'cooldown@example.test', source: '192.0.2.1', env: rateEnv, now: 1_000 });
  await assert.rejects(() => enforceAuthAbuseLimits(cooldownRepository, { action: 'password-reset', email: 'cooldown@example.test', source: '192.0.2.2', env: rateEnv, now: 60_999 }), /rate_limit_exceeded/);
  await enforceAuthAbuseLimits(cooldownRepository, { action: 'password-reset', email: 'cooldown@example.test', source: '192.0.2.3', env: rateEnv, now: 61_000 });

  const attemptsRepository = new InMemoryControlPlaneRepository();
  createEligibleUser(attemptsRepository, 'attempts@example.test');
  await requestPasswordRecovery(attemptsRepository, { email: 'attempts@example.test' }, recoveryOptions({ scheduleDelivery: () => {} }));
  for (let attempt = 0; attempt < PASSWORD_RESET_MAX_ATTEMPTS + 2; attempt += 1) {
    await assert.rejects(() => completePasswordRecovery(attemptsRepository, {
      email: 'attempts@example.test', code: '000000', newPassword: 'new-password',
    }, recoveryOptions()), /invalid_or_expired_password_reset_code/);
  }
  assert.equal(attemptsRepository.store.emailVerificationCodes[0].attempts, PASSWORD_RESET_MAX_ATTEMPTS);
  await assert.rejects(() => completePasswordRecovery(attemptsRepository, {
    email: 'attempts@example.test', code: '246810', newPassword: 'new-password',
  }, recoveryOptions()), /invalid_or_expired_password_reset_code/);

  const expiryRepository = new InMemoryControlPlaneRepository();
  createEligibleUser(expiryRepository, 'expired@example.test');
  const issuedAt = Date.now();
  await requestPasswordRecovery(expiryRepository, { email: 'expired@example.test' }, recoveryOptions({ now: issuedAt, scheduleDelivery: () => {} }));
  await assert.rejects(() => completePasswordRecovery(expiryRepository, {
    email: 'expired@example.test', code: '246810', newPassword: 'new-password',
  }, recoveryOptions({ now: issuedAt + PASSWORD_RESET_TTL_SECONDS * 1_000 })), /invalid_or_expired_password_reset_code/);

  const replayRepository = new InMemoryControlPlaneRepository();
  createEligibleUser(replayRepository, 'replay@example.test');
  await requestPasswordRecovery(replayRepository, { email: 'replay@example.test' }, recoveryOptions({ scheduleDelivery: () => {} }));
  await assert.rejects(() => completePasswordRecovery(replayRepository, {
    email: 'replay@example.test', code: '246810', newPassword: 'short',
  }, recoveryOptions()), /password must be at least 8 characters/);
  assert.equal(replayRepository.store.emailVerificationCodes[0].consumedAt, null);
  await completePasswordRecovery(replayRepository, {
    email: 'replay@example.test', code: '246810', newPassword: 'new-password',
  }, recoveryOptions());
  await assert.rejects(() => completePasswordRecovery(replayRepository, {
    email: 'replay@example.test', code: '246810', newPassword: 'other-password',
  }, recoveryOptions()), /invalid_or_expired_password_reset_code/);

  const deliveryRepository = new InMemoryControlPlaneRepository();
  createEligibleUser(deliveryRepository, 'delivery-failure@example.test');
  const scheduled = [];
  const alerts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    const accepted = await requestPasswordRecovery(deliveryRepository, { email: 'delivery-failure@example.test' }, recoveryOptions({
      env: {
        NODE_ENV: 'production',
        RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <password-reset@example.test>',
        RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '246810',
        RAIBITSERVER_EMAIL_DELIVERY_MODE: 'webhook',
        RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/reset',
      },
      scheduleDelivery: (task) => scheduled.push(task),
      operatorAlert: (event) => alerts.push(event),
    }));
    assert.deepEqual(accepted, { accepted: true });
    scheduled[0]();
    await waitFor(() => alerts.length === 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(deliveryRepository.store.emailVerificationCodes[0].consumedAt !== null, true);
  assert.deepEqual(alerts, [{ code: 'password_reset_delivery_failed', challengeId: deliveryRepository.store.emailVerificationCodes[0].id }]);
  const alertAudit = deliveryRepository.store.auditLogs.find((row) => row.action === 'user.password-reset:delivery-failed');
  assert.deepEqual(alertAudit.metadata, { reasonCode: 'password_reset_delivery_failed' });
  assert.equal(JSON.stringify(alertAudit).includes('delivery-failure@example.test'), false);
  t.diagnostic(JSON.stringify({ publicClasses: classes.length, ttlSeconds: PASSWORD_RESET_TTL_SECONDS, maxAttempts: PASSWORD_RESET_MAX_ATTEMPTS, cooldownBoundaryMs: 60_000, deliveryChallengeConsumed: true, alertSecretMatches: 0 }));
});

test('password recovery happy path works through real local HTTP routes and capture-email storage', async (t) => {
  const previous = {
    jwt: process.env.RAIBITSERVER_AUTH_JWT_SECRET,
    from: process.env.RAIBITSERVER_EMAIL_FROM,
    code: process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE,
    mode: process.env.RAIBITSERVER_EMAIL_DELIVERY_MODE,
  };
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = jwtSecret;
  process.env.RAIBITSERVER_EMAIL_FROM = verificationEnv.RAIBITSERVER_EMAIL_FROM;
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = verificationEnv.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE;
  process.env.RAIBITSERVER_EMAIL_DELIVERY_MODE = 'console';
  const controlPlane = new RAIBITSERVERControlPlane();
  const email = 'http-reset@example.test';
  const user = controlPlane.store.createUser({
    email,
    name: 'HTTP Reset',
    passwordHash: hashPassword('old-password'),
    approvalStatus: 'APPROVED',
    emailVerifiedAt: new Date().toISOString(),
  });
  controlPlane.store.createUser({ email: 'http-oauth-only@example.test', name: 'OAuth', passwordHash: null, approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString() });
  controlPlane.store.createUser({ email: 'http-banned@example.test', name: 'Banned', passwordHash: hashPassword('old-password'), approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString(), bannedAt: new Date().toISOString() });
  controlPlane.store.createUser({ email: 'http-unapproved@example.test', name: 'Pending', passwordHash: hashPassword('old-password'), approvalStatus: 'PENDING', emailVerifiedAt: new Date().toISOString() });
  const oldToken = createSessionToken(user, [], jwtSecret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const requested = await postJson(`${baseUrl}/auth/password-reset/request`, { email });
    const parityEmails = ['http-oauth-only@example.test', 'http-banned@example.test', 'http-unapproved@example.test', 'http-unknown@example.test'];
    const parity = await Promise.all(parityEmails
      .map((candidate) => postJson(`${baseUrl}/auth/password-reset/request`, { email: candidate })));
    const cooldown = await Promise.all([email, ...parityEmails]
      .map((candidate) => postJson(`${baseUrl}/auth/password-reset/request`, { email: candidate })));
    await waitFor(() => controlPlane.store.emailDeliveries.length === 1);
    const captured = controlPlane.store.emailDeliveries[0];
    const code = captured.text.match(/\b\d{6}\b/)?.[0];
    assert.equal(code, '246810');
    const completed = await postJson(`${baseUrl}/auth/password-reset/complete`, { email, code, newPassword: 'new-password' });
    const oldSession = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: `Bearer ${oldToken}` } });
    const oldLogin = await postJson(`${baseUrl}/auth/login`, { email, password: 'old-password' });
    const newLogin = await postJson(`${baseUrl}/auth/login`, { email, password: 'new-password' });

    assert.equal(requested.status, 202);
    assert.equal(requested.headers.get('retry-after'), '60');
    assert.deepEqual(requested.body, { accepted: true });
    assert.equal(parity.every((response) => response.status === 202 && response.text === requested.text && response.headers.get('retry-after') === '60'), true);
    assert.equal(cooldown.every((response) => response.status === 429 && response.text === cooldown[0].text && response.headers.get('retry-after') === '60'), true);
    assert.equal(completed.status, 200);
    assert.deepEqual(completed.body, { reset: true });
    assert.equal('token' in completed.body, false);
    assert.equal(oldSession.status, 401);
    assert.equal(oldLogin.status, 401);
    assert.equal(newLogin.status, 200);
    assert.equal(typeof newLogin.body.token, 'string');
    t.diagnostic(JSON.stringify({ requestStatus: requested.status, parityStatuses: parity.map((response) => response.status), cooldownStatuses: cooldown.map((response) => response.status), retryAfter: requested.headers.get('retry-after'), capturedDeliveries: controlPlane.store.emailDeliveries.length, completionStatus: completed.status, autoSession: 'token' in completed.body, oldJwtStatus: oldSession.status, oldPasswordStatus: oldLogin.status, newPasswordStatus: newLogin.status }));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreEnv('RAIBITSERVER_AUTH_JWT_SECRET', previous.jwt);
    restoreEnv('RAIBITSERVER_EMAIL_FROM', previous.from);
    restoreEnv('RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE', previous.code);
    restoreEnv('RAIBITSERVER_EMAIL_DELIVERY_MODE', previous.mode);
  }
});

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not reached');
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

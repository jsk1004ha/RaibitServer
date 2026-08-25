import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverEmailVerificationMessage,
  issueSignupEmailVerificationCode,
  verifyEmailCodeAndCreateSession,
} from '../packages/core/src/email-verification.ts';
import * as security from '../packages/core/src/security.ts';
import * as identity from '../packages/core/src/identity.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const verificationEnv = Object.freeze({
  NODE_ENV: 'test',
  RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
  RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '246810',
});
const jwtSecret = 'atomic-signup-verification-secret';

async function signup(repository, email, organizationSlug) {
  return issueSignupEmailVerificationCode(repository, {
    email,
    password: 'correct-horse',
    name: email.split('@')[0],
    studentId: '2500',
    organizationSlug,
  }, { jwtSecret, env: verificationEnv });
}

async function verify(repository, email, code = '246810') {
  return verifyEmailCodeAndCreateSession(repository, { email, code }, {
    jwtSecret,
    issuer: 'raibitserver-test',
    env: verificationEnv,
  });
}

test('one signup verification code can create an account only once under concurrency', async () => {
  const repository = new InMemoryControlPlaneRepository();
  await signup(repository, 'atomic@example.test', 'atomic-org');

  const outcomes = await Promise.allSettled([
    verify(repository, 'atomic@example.test'),
    verify(repository, 'atomic@example.test'),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(repository.store.users.size, 1);
  assert.equal(repository.store.organizations.size, 1);
  assert.equal(repository.store.members.length, 1);
  assert.equal(repository.store.emailVerificationCodes[0].consumedAt !== null, true);
});

test('concurrent signups cannot both claim ownership of the same organization slug', async () => {
  const repository = new InMemoryControlPlaneRepository();
  await Promise.all([
    signup(repository, 'owner-a@example.test', 'one-owner-org'),
    signup(repository, 'owner-b@example.test', 'one-owner-org'),
  ]);

  const outcomes = await Promise.allSettled([
    verify(repository, 'owner-a@example.test'),
    verify(repository, 'owner-b@example.test'),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(repository.store.organizations.size, 1);
  assert.equal(repository.store.users.size, 1);
  assert.equal(repository.store.members.filter((member) => member.role === 'owner').length, 1);
});

test('concurrent invalid verification attempts stop exactly at the attempt cap', async () => {
  const repository = new InMemoryControlPlaneRepository();
  await signup(repository, 'attempt-cap@example.test', 'attempt-cap-org');

  await Promise.allSettled(Array.from({ length: 12 }, () => verify(repository, 'attempt-cap@example.test', '000000')));

  const [record] = repository.store.emailVerificationCodes;
  assert.equal(record.attempts, 5);
  await assert.rejects(() => verify(repository, 'attempt-cap@example.test'), /invalid_or_expired_email_verification_code/);
  assert.equal(repository.store.users.size, 0);
});

test('Prisma signup completion uses one serializable transaction and insert-only writes', async () => {
  const calls = [];
  const record = {
    id: 'code-1',
    email: 'prisma-atomic@example.test',
    purpose: 'signup',
    attempts: 0,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    payload: {
      kind: 'signup',
      email: 'prisma-atomic@example.test',
      name: 'Prisma Atomic',
      passwordHash: 'stored-password-hash',
      organizationSlug: 'prisma-atomic-org',
      organizationName: 'Prisma Atomic Org',
      plan: 'free',
      policy: { role: 'USER', accountType: 'NON_CLUB', approvalStatus: 'APPROVED' },
    },
  };
  const transaction = {
    emailVerificationCode: {
      findFirst: async () => record,
      updateMany: async (input) => { calls.push(['code.updateMany', input]); return { count: 1 }; },
    },
    organization: {
      findUnique: async () => null,
      create: async (input) => { calls.push(['organization.create', input]); return { id: 'org-1', ...input.data }; },
    },
    user: {
      findUnique: async () => null,
      count: async () => 0,
      create: async (input) => { calls.push(['user.create', input]); return { id: 'user-1', sessionVersion: 0, ...input.data }; },
    },
    membership: {
      create: async (input) => { calls.push(['membership.create', input]); return { id: 'member-1', ...input.data }; },
      findMany: async () => [{ id: 'member-1', organizationId: 'org-1', userId: 'user-1', role: 'owner' }],
    },
  };
  let transactionOptions;
  const repository = new PrismaControlPlaneRepository({
    $transaction: async (handler, options) => {
      transactionOptions = options;
      return handler(transaction);
    },
  });

  const result = await repository.completeSignupEmailVerification({
    email: record.email,
    purpose: 'signup',
    maxAttempts: 5,
    now: Date.now(),
    verifyCode: () => true,
    resolvePolicy: (payload) => payload.policy,
  });

  assert.equal(result.status, 'verified');
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
  assert.deepEqual(calls.map(([name]) => name), [
    'code.updateMany',
    'organization.create',
    'user.create',
    'membership.create',
  ]);
});

test('Prisma email challenge replacement is atomic and purpose-scoped', async () => {
  const calls = [];
  const created = { id: 'replacement-code' };
  const transaction = {
    $queryRawUnsafe: async (query, key, now, pruneLimit) => {
      calls.push(['advisory-lock', { query, key, now, pruneLimit }]);
      return [{ locked: null }];
    },
    emailVerificationCode: {
      updateMany: async (input) => {
        calls.push(['code.updateMany', input]);
        return { count: 1 };
      },
      create: async (input) => {
        calls.push(['code.create', input]);
        return { ...created, ...input.data };
      },
    },
  };
  let transactions = 0;
  let transactionOptions;
  const repository = new PrismaControlPlaneRepository({
    $transaction: async (handler, options) => {
      transactions += 1;
      transactionOptions = options;
      return handler(transaction);
    },
  });
  const input = {
    email: 'atomic-replacement@example.test',
    purpose: 'signup',
    payload: { kind: 'signup' },
    codeHash: 'replacement-hash',
    codeSalt: 'replacement-salt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sentAt: new Date().toISOString(),
    attempts: 0,
  };

  const result = await repository.replaceEmailVerificationCode(input);

  assert.equal(transactions, 1);
  assert.deepEqual(transactionOptions, { maxWait: 5_000, timeout: 10_000 });
  assert.equal(result.id, created.id);
  assert.deepEqual(calls.map(([name]) => name), ['advisory-lock', 'code.updateMany', 'code.create']);
  assert.match(calls[0][1].query, /pg_advisory_xact_lock/);
  assert.match(calls[0][1].query, /DELETE FROM "EmailVerificationCode"/);
  assert.match(calls[0][1].query, /LIMIT \$3/);
  assert.equal(calls[0][1].key, JSON.stringify([input.email, 'signup']));
  assert.equal(calls[0][1].pruneLimit, 256);
  assert.deepEqual(calls[1][1].where, {
    email: input.email,
    purpose: 'signup',
    consumedAt: null,
  });
});

test('auth abuse limits bind email, source, shared source, and global counters durably', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const env = {
    RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT: '2',
    RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT: '2',
    RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT: '3',
    RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_RATE_WINDOW_MS: '60000',
  };

  const enforceAuthAbuseLimits = security.enforceAuthAbuseLimits;
  assert.equal(typeof enforceAuthAbuseLimits, 'function');
  await enforceAuthAbuseLimits(repository, { action: 'signup', email: 'same@example.test', source: '10.0.0.1', env, now: 1_000 });
  await enforceAuthAbuseLimits(repository, { action: 'signup', email: 'same@example.test', source: '10.0.0.2', env, now: 1_001 });
  await assert.rejects(
    () => enforceAuthAbuseLimits(repository, { action: 'signup', email: 'same@example.test', source: '10.0.0.3', env, now: 1_002 }),
    /rate_limit_exceeded/,
  );

  await enforceAuthAbuseLimits(repository, { action: 'email-verify', email: 'rotate-a@example.test', source: '10.0.0.9', env, now: 2_000 });
  await enforceAuthAbuseLimits(repository, { action: 'email-resend', email: 'rotate-b@example.test', source: '10.0.0.9', env, now: 2_001 });
  await enforceAuthAbuseLimits(repository, { action: 'signup', email: 'rotate-c@example.test', source: '10.0.0.9', env, now: 2_002 });
  await assert.rejects(
    () => enforceAuthAbuseLimits(repository, { action: 'email-verify', email: 'rotate-d@example.test', source: '10.0.0.9', env, now: 2_003 }),
    /rate_limit_exceeded/,
  );

  assert.equal([...repository.store.authRateLimits.keys()].some((key) => key.includes('same@example.test')), false);
  assert.match([...repository.store.authRateLimits.keys()][0], /^auth:source:/);
});

test('auth global limiter is preflighted and clamps excessive configured capacity', async () => {
  const consumed = [];
  const repository = {
    async peekAuthRateLimit() {
      return { allowed: true, count: 0 };
    },
    async consumeAuthRateLimit(input) {
      consumed.push(input);
      const allowed = !input.key.startsWith('auth:global:');
      return { allowed, count: allowed ? 1 : input.limit + 1, resetAt: input.now + input.windowMs };
    },
  };

  await assert.rejects(() => security.enforceAuthAbuseLimits(repository, {
    action: 'signup',
    email: 'cap@example.test',
    source: '192.0.2.10',
    now: 1_000,
    env: { RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '1000000' },
  }), /rate_limit_exceeded/);

  assert.equal(consumed.length, 3);
  assert.match(consumed[0].key, /^auth:source:/);
  assert.match(consumed[1].key, /^auth:flow-source:/);
  assert.match(consumed[2].key, /^auth:global:/);
  assert.equal(consumed[2].limit, 50_000);
});

test('source rejection does not consume global capacity or create a high-cardinality email row', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const env = {
    RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT: '1',
    RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '100',
  };

  await security.enforceAuthAbuseLimits(repository, {
    action: 'signup', email: 'first@example.test', source: '192.0.2.20', env, now: 1_000,
  });
  const globalKey = [...repository.store.authRateLimits.keys()].find((key) => key.startsWith('auth:global:'));
  const sizeBeforeRejectedSource = repository.store.authRateLimits.size;
  const globalCount = repository.store.authRateLimits.get(globalKey).count;

  await assert.rejects(() => security.enforceAuthAbuseLimits(repository, {
    action: 'signup', email: 'second@example.test', source: '192.0.2.20', env, now: 1_001,
  }), /rate_limit_exceeded/);

  assert.equal(repository.store.authRateLimits.get(globalKey).count, globalCount);
  assert.equal(repository.store.authRateLimits.size, sizeBeforeRejectedSource);
});

test('global preflight blocks rotating sources before they allocate new limiter rows', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const env = {
    RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '1',
  };

  await security.enforceAuthAbuseLimits(repository, {
    action: 'signup', email: 'first@example.test', source: '192.0.2.30', env, now: 1_000,
  });
  const sizeAtCapacity = repository.store.authRateLimits.size;
  const globalKey = [...repository.store.authRateLimits.keys()].find((key) => key.startsWith('auth:global:'));
  const globalCountAtCapacity = repository.store.authRateLimits.get(globalKey).count;

  await assert.rejects(() => security.enforceAuthAbuseLimits(repository, {
    action: 'signup', email: 'rotated@example.test', source: '192.0.2.31', env, now: 1_001,
  }), /rate_limit_exceeded/);

  assert.equal(repository.store.authRateLimits.size, sizeAtCapacity);
  assert.equal(repository.store.authRateLimits.get(globalKey).count, globalCountAtCapacity);
});

test('resend cooldown is durable and independent of general auth limits', async () => {
  const repository = new InMemoryControlPlaneRepository();
  const enforceAuthAbuseLimits = security.enforceAuthAbuseLimits;
  assert.equal(typeof enforceAuthAbuseLimits, 'function');
  const env = {
    RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT: '100',
    RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT: '100',
    RAIBITSERVER_EMAIL_RESEND_COOLDOWN_MS: '60000',
  };
  const input = { action: 'email-resend', email: 'cooldown@example.test', source: '192.0.2.1', env, now: 10_000 };

  await enforceAuthAbuseLimits(repository, input);
  await assert.rejects(() => enforceAuthAbuseLimits(repository, { ...input, now: 10_001 }), /rate_limit_exceeded/);
  await enforceAuthAbuseLimits(repository, { ...input, now: 70_001 });
});

test('password hashing exposes a nonblocking async path', async () => {
  const hashPasswordAsync = identity.hashPasswordAsync;
  assert.equal(typeof hashPasswordAsync, 'function');
  const pending = hashPasswordAsync('correct-horse', { salt: 'fixed-test-salt', cost: 16_384 });
  assert.equal(typeof pending?.then, 'function');
  const encoded = await pending;
  assert.equal(identity.verifyPassword('correct-horse', encoded), true);
});

test('email webhook delivery aborts a hung request within the configured bound', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  try {
    const delivery = deliverEmailVerificationMessage({
      from: 'RAIBITSERVER <email-verification@example.test>',
      to: 'hung@example.test',
      subject: 'Verification',
      text: 'code',
    }, {
      NODE_ENV: 'production',
      RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
      RAIBITSERVER_EMAIL_DELIVERY_MODE: 'webhook',
      RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
      RAIBITSERVER_EMAIL_WEBHOOK_TIMEOUT_MS: '100',
    }).then(() => 'delivered', (error) => error.message);
    const outcome = await Promise.race([
      delivery,
      new Promise((resolve) => setTimeout(() => resolve('still-hung'), 500)),
    ]);
    assert.equal(outcome, 'email_delivery_timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

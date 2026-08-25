import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { issueSignupEmailVerificationCode, resendEmailVerificationCode } from '../packages/core/src/email-verification.ts';
import { hashPassword } from '../packages/core/src/identity.ts';

const signupPayload = (input) => ({ name: 'Enumeration Test', studentId: '2500', ...input });

test('signup returns the same generic response for registered and unregistered targets', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createUser({
    email: 'registered-signup@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  const server = await startApi(controlPlane);
  const accepted = {
    statusCode: 201,
    body: {
      emailVerification: { accepted: true },
      signup: { status: 'verification_requested' },
    },
  };

  try {
    const unregistered = await request(server.address().port, '/auth/signup', {
      email: 'unregistered-signup@example.com',
      password: 'correct-horse',
      organizationSlug: 'unregistered-signup',
    });
    await waitFor(() => controlPlane.store.emailDeliveries.length === 1);
    const deliveriesAfterUnregistered = controlPlane.store.emailDeliveries.length;
    const registered = await request(server.address().port, '/auth/signup', {
      email: 'registered-signup@example.com',
      password: 'correct-horse',
      organizationSlug: 'registered-signup-attempt',
    });

    assert.deepEqual(unregistered, accepted);
    assert.deepEqual(registered, accepted);
    assert.equal(deliveriesAfterUnregistered, 1);
    assert.equal(controlPlane.store.emailDeliveries.length, deliveriesAfterUnregistered);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('signup default organization lookup cannot reveal a registered email', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createOrganization({ name: 'Registered personal org', slug: 'registered-default' });
  controlPlane.store.createUser({
    email: 'registered-default@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  const server = await startApi(controlPlane);

  try {
    const registered = await request(server.address().port, '/auth/signup', {
      email: 'registered-default@example.com',
      password: 'correct-horse',
    });
    const unregistered = await request(server.address().port, '/auth/signup', {
      email: 'unregistered-default@example.com',
      password: 'correct-horse',
    });

    assert.deepEqual(registered, unregistered);
    assert.equal(registered.statusCode, 201);
    assert.deepEqual(registered.body.emailVerification, { accepted: true });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('signup applies weak-password validation equally to registered and unregistered targets', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createUser({
    email: 'registered-weak@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  const server = await startApi(controlPlane);

  try {
    const registered = await request(server.address().port, '/auth/signup', {
      email: 'registered-weak@example.com',
      password: 'weak',
      organizationSlug: 'registered-weak-attempt',
    });
    const unregistered = await request(server.address().port, '/auth/signup', {
      email: 'unregistered-weak@example.com',
      password: 'weak',
      organizationSlug: 'unregistered-weak-attempt',
    });

    assert.deepEqual(registered, unregistered);
    assert.equal(registered.statusCode, 400);
    assert.match(registered.body.error, /password must be at least 8 characters/);
    assert.equal(controlPlane.store.emailDeliveries.length, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('signup hides an organization slug collision equally for registered and unregistered targets', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createOrganization({ name: 'Claimed Org', slug: 'claimed-org' });
  controlPlane.store.createUser({
    email: 'registered-collision@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  const server = await startApi(controlPlane);

  try {
    const registered = await request(server.address().port, '/auth/signup', {
      email: 'registered-collision@example.com',
      password: 'correct-horse',
      organizationSlug: 'claimed-org',
    });
    const unregistered = await request(server.address().port, '/auth/signup', {
      email: 'unregistered-collision@example.com',
      password: 'correct-horse',
      organizationSlug: 'claimed-org',
    });

    assert.deepEqual(registered, unregistered);
    assert.equal(registered.statusCode, 201);
    assert.deepEqual(registered.body.emailVerification, { accepted: true });
    assert.equal(controlPlane.store.emailDeliveries.length, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('resend returns the same generic response without mailing registered or unknown targets', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createUser({
    email: 'registered-resend@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  const server = await startApi(controlPlane);
  const accepted = {
    statusCode: 200,
    body: { emailVerification: { accepted: true } },
  };

  try {
    await request(server.address().port, '/auth/signup', {
      email: 'pending-resend@example.com',
      password: 'correct-horse',
      organizationSlug: 'pending-resend',
    });
    await waitFor(() => controlPlane.store.emailDeliveries.length === 1);
    const pending = await request(server.address().port, '/auth/email/resend', {
      email: 'pending-resend@example.com',
    });
    await waitFor(() => controlPlane.store.emailDeliveries.length === 2);
    const deliveriesAfterPending = controlPlane.store.emailDeliveries.length;
    const registered = await request(server.address().port, '/auth/email/resend', {
      email: 'registered-resend@example.com',
    });
    const unknown = await request(server.address().port, '/auth/email/resend', {
      email: 'unknown-resend@example.com',
    });

    assert.deepEqual(pending, accepted);
    assert.deepEqual(registered, accepted);
    assert.deepEqual(unknown, accepted);
    assert.equal(deliveriesAfterPending, 2);
    assert.equal(controlPlane.store.emailDeliveries.length, deliveriesAfterPending);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('signup and resend do not expose account state when email delivery fails', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createUser({
    email: 'registered-delivery@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  await issueSignupEmailVerificationCode(controlPlane.store, signupPayload({
    email: 'pending-delivery@example.com',
    password: 'correct-horse',
    organizationSlug: 'pending-delivery',
  }), {
    jwtSecret: 'auth-enumeration-delivery-secret',
    env: {
      NODE_ENV: 'test',
      RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console',
      RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@localhost>',
      RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '135790',
    },
  });

  const failingEnv = {
    NODE_ENV: 'production',
    RAIBITSERVER_EMAIL_DELIVERY_MODE: 'webhook',
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  const options = { jwtSecret: 'auth-enumeration-delivery-secret', env: failingEnv };

  try {
    const registeredSignup = await issueSignupEmailVerificationCode(controlPlane.store, signupPayload({
      email: 'registered-delivery@example.com', password: 'correct-horse', organizationSlug: 'registered-delivery-attempt',
    }), options);
    const unknownSignup = await issueSignupEmailVerificationCode(controlPlane.store, signupPayload({
      email: 'unknown-delivery@example.com', password: 'correct-horse', organizationSlug: 'unknown-delivery',
    }), options);
    const registeredResend = await resendEmailVerificationCode(controlPlane.store, { email: 'registered-delivery@example.com' }, options);
    const unknownResend = await resendEmailVerificationCode(controlPlane.store, { email: 'never-pending@example.com' }, options);
    const pendingResend = await resendEmailVerificationCode(controlPlane.store, { email: 'pending-delivery@example.com' }, options);

    for (const result of [registeredSignup, unknownSignup, registeredResend, unknownResend, pendingResend]) {
      assert.deepEqual(result, { accepted: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('signup uses a bounded user count instead of a full repository snapshot', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  let countCalls = 0;
  let snapshotCalls = 0;
  const repository = {
    countUsers: async () => {
      countCalls += 1;
      return 0;
    },
    snapshot: async () => {
      snapshotCalls += 1;
      throw new Error('full snapshot must not be used by signup');
    },
    findUserByEmail: controlPlane.store.findUserByEmail.bind(controlPlane.store),
    findOrganizationBySlug: controlPlane.store.findOrganizationBySlug.bind(controlPlane.store),
    invalidatePendingEmailVerificationCodes: controlPlane.store.invalidatePendingEmailVerificationCodes.bind(controlPlane.store),
    createEmailVerificationCode: controlPlane.store.createEmailVerificationCode.bind(controlPlane.store),
    replaceEmailVerificationCode: (...args) => controlPlane.store.replaceEmailVerificationCode(...args),
  };
  const scheduled = [];

  const result = await issueSignupEmailVerificationCode(repository, signupPayload({
    email: 'bounded-count@example.test',
    password: 'correct-horse',
    organizationSlug: 'bounded-count',
  }), {
    jwtSecret: 'bounded-count-signup-secret',
    env: verificationEnv(),
    scheduleDelivery: (task) => scheduled.push(task),
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(countCalls, 1);
  assert.equal(snapshotCalls, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(controlPlane.store.findPendingEmailVerificationCode('bounded-count@example.test', 'signup')?.payload?.policy?.bootstrapReason, 'first-user');
});

test('signup performs the same bounded public work for new, registered, and organization-collision targets', async () => {
  const cases = [
    { name: 'new', expectedPurpose: 'signup' },
    { name: 'registered', expectedPurpose: 'request-padding', registered: true },
    { name: 'organization-collision', expectedPurpose: 'request-padding', organizationCollision: true },
  ];

  for (const scenario of cases) {
    const controlPlane = new RAIBITSERVERControlPlane();
    if (scenario.registered) {
      controlPlane.store.createUser({
        email: `${scenario.name}@example.test`,
        passwordHash: hashPassword('existing-password'),
        emailVerifiedAt: new Date().toISOString(),
        approvalStatus: 'APPROVED',
      });
    }
    if (scenario.organizationCollision) {
      controlPlane.store.createOrganization({ name: 'Claimed organization', slug: 'timing-target' });
    }
    const tracked = trackRepository(controlPlane.store, [
      'countUsers',
      'findUserByEmail',
      'findOrganizationBySlug',
      'replaceEmailVerificationCode',
    ]);
    const scheduled = [];
    const options = {
      jwtSecret: 'signup-timing-enumeration-secret',
      env: verificationEnv(),
      scheduleDelivery: (task) => scheduled.push(task),
    };

    let result;
    const scryptCalls = await countAsyncScryptCalls(async () => {
      result = await issueSignupEmailVerificationCode(tracked.repository, signupPayload({
        email: `${scenario.name}@example.test`,
        password: 'correct-horse',
        organizationSlug: 'timing-target',
      }), options);
    });

    assert.deepEqual(result, { accepted: true }, scenario.name);
    assert.equal(scryptCalls, 1, scenario.name);
    assert.deepEqual(tracked.calls, [
      'countUsers',
      'findUserByEmail',
      'findOrganizationBySlug',
      'replaceEmailVerificationCode',
    ], scenario.name);
    assert.equal(scheduled.length, 1, scenario.name);
    assert.equal(controlPlane.store.emailVerificationCodes.at(-1)?.purpose, scenario.expectedPurpose, scenario.name);
  }
});

test('resend performs the same bounded public work for pending, registered, and unknown targets', async () => {
  const cases = [
    { name: 'pending', expectedPurpose: 'signup', pending: true },
    { name: 'registered', expectedPurpose: 'request-padding', registered: true },
    { name: 'unknown', expectedPurpose: 'request-padding' },
  ];

  for (const scenario of cases) {
    const controlPlane = new RAIBITSERVERControlPlane();
    const email = `${scenario.name}-resend@example.test`;
    if (scenario.registered) {
      controlPlane.store.createUser({
        email,
        passwordHash: hashPassword('existing-password'),
        emailVerifiedAt: new Date().toISOString(),
        approvalStatus: 'APPROVED',
      });
    }
    if (scenario.pending) createPendingSignup(controlPlane.store, email);
    const tracked = trackRepository(controlPlane.store, [
      'findUserByEmail',
      'findPendingEmailVerificationCode',
      'replaceEmailVerificationCode',
    ]);
    const scheduled = [];

    const result = await resendEmailVerificationCode(tracked.repository, { email }, {
      jwtSecret: 'resend-timing-enumeration-secret',
      env: verificationEnv(),
      scheduleDelivery: (task) => scheduled.push(task),
    });

    assert.deepEqual(result, { accepted: true }, scenario.name);
    assert.deepEqual(tracked.calls, [
      'findUserByEmail',
      'findPendingEmailVerificationCode',
      'replaceEmailVerificationCode',
    ], scenario.name);
    assert.equal(scheduled.length, 1, scenario.name);
    assert.equal(controlPlane.store.emailVerificationCodes.at(-1)?.purpose, scenario.expectedPurpose, scenario.name);
  }
});

test('organization-collision padding preserves an existing signup challenge', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const email = 'preserved-signup@example.test';
  createPendingSignup(controlPlane.store, email);
  const original = controlPlane.store.findPendingEmailVerificationCode(email, 'signup');
  controlPlane.store.createOrganization({ name: 'Already claimed', slug: 'already-claimed' });
  const scheduled = [];

  const result = await issueSignupEmailVerificationCode(controlPlane.store, signupPayload({
    email,
    password: 'replacement-password',
    organizationSlug: 'already-claimed',
  }), {
    jwtSecret: 'preserve-pending-signup-secret',
    env: verificationEnv(),
    scheduleDelivery: (task) => scheduled.push(task),
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(scheduled.length, 1);
  assert.equal(controlPlane.store.findPendingEmailVerificationCode(email, 'signup')?.id, original.id);
  assert.equal(controlPlane.store.emailVerificationCodes.at(-1)?.purpose, 'request-padding');
});

test('signup and resend return after durable challenge persistence without awaiting webhook I/O', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const originalFetch = globalThis.fetch;
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await deliveryGate;
    return new Response('', { status: 202, headers: { 'x-message-id': `message-${fetchCalls}` } });
  };
  const options = {
    jwtSecret: 'durable-async-delivery-secret',
    env: {
      NODE_ENV: 'production',
      RAIBITSERVER_EMAIL_DELIVERY_MODE: 'webhook',
      RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
      RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
      RAIBITSERVER_EMAIL_WEBHOOK_TIMEOUT_MS: '5000',
    },
  };
  const email = 'durable-async@example.test';
  let signupOperation;

  try {
    signupOperation = issueSignupEmailVerificationCode(controlPlane.store, signupPayload({
      email,
      password: 'correct-horse',
      organizationSlug: 'durable-async',
    }), options);
    const signup = await settleBefore(signupOperation, 1_000, 'signup waited for webhook delivery');
    assert.deepEqual(signup, { accepted: true });
    assert.ok(controlPlane.store.findPendingEmailVerificationCode(email, 'signup'), 'signup challenge must be durable before returning');
    await waitFor(() => fetchCalls === 1);

    const previousChallengeId = controlPlane.store.findPendingEmailVerificationCode(email, 'signup').id;
    const resendOperation = resendEmailVerificationCode(controlPlane.store, { email }, options);
    const resend = await settleBefore(resendOperation, 250, 'resend waited for webhook delivery');
    assert.deepEqual(resend, { accepted: true });
    const replacement = controlPlane.store.findPendingEmailVerificationCode(email, 'signup');
    assert.ok(replacement);
    assert.notEqual(replacement.id, previousChallengeId, 'resend replacement must be durable before returning');
    await waitFor(() => fetchCalls === 2);
  } finally {
    releaseDelivery();
    if (signupOperation) await Promise.allSettled([signupOperation]);
    await waitFor(() => controlPlane.store.emailDeliveries.length === fetchCalls);
    globalThis.fetch = originalFetch;
  }
});

async function startApi(controlPlane) {
  const server = http.createServer(createApiHandler(controlPlane, {
    auth: { mode: 'jwt', jwtSecret: 'auth-enumeration-contract-secret' },
  }));
  server.listen(0);
  await once(server, 'listening');
  return server;
}

function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(path === '/auth/signup' ? signupPayload(body) : body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        'content-length': Buffer.byteLength(payload),
        'content-type': 'application/json',
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function verificationEnv() {
  return {
    NODE_ENV: 'test',
    RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console',
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '135790',
  };
}

function trackRepository(repository, methods) {
  const calls = [];
  const trackedMethods = new Set(methods);
  return {
    calls,
    repository: new Proxy(repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (!trackedMethods.has(property) || typeof value !== 'function') return value;
        return (...args) => {
          calls.push(property);
          return value.apply(target, args);
        };
      },
    }),
  };
}

function createPendingSignup(repository, email) {
  repository.createEmailVerificationCode({
    email,
    purpose: 'signup',
    payload: {
      kind: 'signup',
      name: email,
      studentId: '2500',
      clubMemberClaim: false,
      email,
      passwordHash: hashPassword('correct-horse'),
      organizationSlug: 'pending-timing',
      organizationName: 'Pending timing',
      plan: 'free',
      policy: {},
    },
    codeHash: 'pending-code-hash',
    codeSalt: 'pending-code-salt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sentAt: new Date().toISOString(),
    attempts: 0,
  });
}

async function countAsyncScryptCalls(operation) {
  const original = crypto.scrypt;
  let calls = 0;
  crypto.scrypt = function countedScrypt(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    await operation();
    return calls;
  } finally {
    crypto.scrypt = original;
  }
}

async function settleBefore(operation, timeoutMs, message) {
  const timedOut = Symbol('timed-out');
  const outcome = await Promise.race([
    operation,
    new Promise((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);
  assert.notEqual(outcome, timedOut, message);
  return outcome;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for asynchronous email delivery');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

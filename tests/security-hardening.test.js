import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApiHandler } from '../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../packages/core/src/control-plane.ts';
import { signJwtHs256, subjectFromRequest } from '../packages/core/src/auth.ts';
import { assertApiRuntimeConfig, validateApiRuntimeConfig } from '../packages/core/src/config.ts';
import { createSessionToken, signupPolicyForAccount, shouldPromoteFirstLogin } from '../packages/core/src/identity.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';

test('env auth bypass flag is ignored unless explicitly confirmed outside production', async () => {
  const previous = snapshotEnv(['RAIBITSERVER_AUTH_DISABLED', 'RAIBITSERVER_AUTH_DISABLED_CONFIRM', 'NODE_ENV', 'RAIBITSERVER_AUTH_JWT_SECRET']);
  process.env.RAIBITSERVER_AUTH_DISABLED = '1';
  delete process.env.RAIBITSERVER_AUTH_DISABLED_CONFIRM;
  process.env.NODE_ENV = 'production';
  delete process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  const server = http.createServer(createApiHandler(new RAIBITSERVERControlPlane()));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const response = await request(port, 'GET', '/projects');
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    server.close();
    restoreEnv(previous);
  }
});

test('API runtime config fails fast for unsafe production security settings', () => {
  const safe = validateApiRuntimeConfig({
    NODE_ENV: 'production',
    PORT: '8080',
    RAIBITSERVER_AUTH_RATE_LIMIT: '25',
    RAIBITSERVER_AUTH_JWT_SECRET: 'x'.repeat(32),
    RAIBITSERVER_SECRET_ENCRYPTION_KEY: 'y'.repeat(32),
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
  });
  assert.equal(safe.ok, true);
  assert.equal(safe.config.port, 8080);
  assert.equal(safe.config.auth.rateLimit, 25);
  assert.equal(safe.config.kubernetes.ingressGatewayNamespace, 'ingress-nginx');

  const invalidGateway = validateApiRuntimeConfig({ RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE: 'INVALID/namespace' });
  assert.equal(invalidGateway.ok, false);
  assert.equal(invalidGateway.issues.some((issue) => issue.code === 'INVALID_KUBERNETES_NAMESPACE'), true);

  const unsafeEnv = {
    NODE_ENV: 'production',
    PORT: '70000',
    RAIBITSERVER_AUTH_RATE_LIMIT: '0',
    RAIBITSERVER_AUTH_DISABLED: '1',
    RAIBITSERVER_AUTH_DEV_HEADERS: '1',
    RAIBITSERVER_AUTH_DEV_TOKEN: '1',
    RAIBITSERVER_AUTH_JWT_SECRET: 'short',
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
  };
  const unsafe = validateApiRuntimeConfig(unsafeEnv);
  assert.equal(unsafe.ok, false);
  assert.deepEqual(unsafe.issues.map((issue) => issue.code), [
    'INVALID_PORT',
    'INVALID_POSITIVE_INTEGER',
    'UNSAFE_PRODUCTION_AUTH_DISABLED',
    'UNSAFE_PRODUCTION_DEV_HEADERS',
    'UNSAFE_PRODUCTION_DEV_TOKEN',
    'WEAK_JWT_SECRET',
    'MISSING_SECRET_ENCRYPTION_KEY',
  ]);
  assert.throws(() => assertApiRuntimeConfig(unsafeEnv), /invalid API runtime configuration/);
});

test('production API runtime config fails fast when email delivery is not configured', () => {
  const base = {
    NODE_ENV: 'production',
    RAIBITSERVER_AUTH_JWT_SECRET: 'x'.repeat(32),
    RAIBITSERVER_SECRET_ENCRYPTION_KEY: 'y'.repeat(32),
  };

  const missing = validateApiRuntimeConfig(base);
  assert.equal(missing.ok, false);
  assert.equal(missing.issues.some((issue) => issue.code === 'MISSING_EMAIL_DELIVERY'), true);
  assert.throws(() => assertApiRuntimeConfig(base), /RAIBITSERVER_EMAIL_WEBHOOK_URL MISSING_EMAIL_DELIVERY/);

  const configured = validateApiRuntimeConfig({
    ...base,
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
  });
  assert.equal(configured.ok, true);

  const consoleOnly = validateApiRuntimeConfig({
    ...base,
    RAIBITSERVER_EMAIL_DELIVERY_MODE: 'console',
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_WEBHOOK_URL: 'https://mailer.example.test/verify',
  });
  assert.equal(consoleOnly.issues.some((issue) => issue.code === 'INVALID_EMAIL_DELIVERY'), true);

  const invalidWebhook = validateApiRuntimeConfig({
    ...base,
    RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <email-verification@example.test>',
    RAIBITSERVER_EMAIL_WEBHOOK_URL: 'not-a-webhook-url',
  });
  assert.equal(invalidWebhook.issues.some((issue) => issue.code === 'INVALID_EMAIL_DELIVERY'), true);
});

test('production ignores dev-token minting flag and requires real authorization', async () => {
  const previous = snapshotEnv(['NODE_ENV', 'RAIBITSERVER_AUTH_DEV_TOKEN', 'RAIBITSERVER_AUTH_JWT_SECRET', 'RAIBITSERVER_SECRET_ENCRYPTION_KEY']);
  process.env.NODE_ENV = 'production';
  process.env.RAIBITSERVER_AUTH_DEV_TOKEN = '1';
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'x'.repeat(32);
  process.env.RAIBITSERVER_SECRET_ENCRYPTION_KEY = 'y'.repeat(32);
  const server = http.createServer(createApiHandler(new RAIBITSERVERControlPlane()));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const response = await request(port, 'POST', '/auth/dev-token', { sub: 'attacker', global: true });
    assert.equal(response.statusCode, 404);
    const admin = signJwtHs256({ sub: 'admin', role: 'owner', global: true }, process.env.RAIBITSERVER_AUTH_JWT_SECRET);
    const authorized = await request(port, 'POST', '/auth/dev-token', { sub: 'attacker', role: 'owner', global: true }, admin);
    assert.equal(authorized.statusCode, 404);
    assert.equal(validateApiRuntimeConfig(process.env).issues.some((issue) => issue.code === 'UNSAFE_PRODUCTION_DEV_TOKEN'), true);
  } finally {
    server.close();
    restoreEnv(previous);
  }
});

test('production admin bootstrap requires configured admin email plus bootstrap token', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const env = {
      NODE_ENV: 'production',
      ADMIN_EMAILS: 'admin@example.com',
      RAIBITSERVER_ADMIN_BOOTSTRAP_TOKEN: 'x'.repeat(32),
    };
    const firstUser = signupPolicyForAccount({}, 'first@example.com', { env, firstUser: true });
    assert.equal(firstUser.role, 'USER');
    assert.equal(firstUser.approvalStatus, 'PENDING');
    const wrongToken = signupPolicyForAccount({ bootstrapToken: 'wrong' }, 'admin@example.com', { env, firstUser: true });
    assert.equal(wrongToken.role, 'USER');
    const bootstrapped = signupPolicyForAccount({ bootstrapToken: 'x'.repeat(32) }, 'admin@example.com', { env, firstUser: true });
    assert.equal(bootstrapped.role, 'ADMIN');
    assert.equal(shouldPromoteFirstLogin({ id: 'u1', role: 'USER' }, [{ id: 'u1', role: 'USER' }]), false);

    const unsafe = validateApiRuntimeConfig({
      NODE_ENV: 'production',
      RAIBITSERVER_AUTH_JWT_SECRET: 'x'.repeat(32),
      RAIBITSERVER_SECRET_ENCRYPTION_KEY: 'y'.repeat(32),
      ADMIN_EMAILS: 'admin@example.com',
    });
    assert.equal(unsafe.issues.some((issue) => issue.code === 'MISSING_ADMIN_BOOTSTRAP_TOKEN'), true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('session JWT lifetime is server-clamped and login brute force is rate limited', async () => {
  const secret = 'security-test-secret';
  const previousCode = process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE;
  process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = '222222';
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret, issuer: 'raibitserver' } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const signup = await request(port, 'POST', '/auth/signup', { email: 'ttl@example.com', password: 'correct-horse', organizationSlug: 'ttl-org', expiresInSeconds: 315360000 });
    assert.equal(signup.statusCode, 201);
    assert.equal(signup.body.user, undefined);
    const verified = await request(port, 'POST', '/auth/email/verify', { email: 'ttl@example.com', code: '222222' });
    assert.equal(verified.statusCode, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(verified.body.user, 'passwordHash'), false);
    const payload = decodeJwt(verified.body.token);
    assert.equal(payload.exp - payload.iat <= 24 * 60 * 60, true);

    let limited;
    for (let i = 0; i < 11; i += 1) {
      limited = await request(port, 'POST', '/auth/login', { email: 'ttl@example.com', password: `wrong-password-${i}` });
    }
    assert.equal(limited.statusCode, 429);
  } finally {
    server.close();
    if (previousCode === undefined) delete process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE; else process.env.RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE = previousCode;
  }
});

test('Prisma user creation redacts passwordHash before returning API-facing user data', async () => {
  const repo = new PrismaControlPlaneRepository({
    user: {
      upsert: async () => ({
        id: 'usr_1',
        email: 'hash@example.com',
        name: 'Hash',
        role: 'USER',
        accountType: 'NON_CLUB',
        approvalStatus: 'PENDING',
        passwordHash: 'stored-password-hash',
      }),
    },
  });
  const user = await repo.createUser({ email: 'hash@example.com', name: 'Hash', passwordHash: 'stored-password-hash' });
  assert.equal(Object.prototype.hasOwnProperty.call(user, 'passwordHash'), false);
});

test('auth rate limiting has deterministic local storage and an atomic PostgreSQL path', async () => {
  const store = new ControlPlaneStore();
  const key = 'login:user@example.com:127.0.0.1';
  assert.equal(store.consumeAuthRateLimit({ key, limit: 2, windowMs: 60_000, now: 1_000 }).allowed, true);
  assert.equal(store.consumeAuthRateLimit({ key, limit: 2, windowMs: 60_000, now: 1_001 }).allowed, true);
  assert.equal(store.consumeAuthRateLimit({ key, limit: 2, windowMs: 60_000, now: 1_002 }).allowed, false);
  assert.equal(store.authRateLimits.get(key).count, 2);
  assert.equal(store.consumeAuthRateLimit({ key, limit: 2, windowMs: 60_000, now: 61_001 }).allowed, true);

  let query = '';
  let values = [];
  const repo = new PrismaControlPlaneRepository({
    $queryRawUnsafe: async (sql, ...params) => {
      query = sql;
      values = params;
      return [{ count: 1, expiresAt: new Date(61_000) }];
    },
  });
  const consumed = await repo.consumeAuthRateLimit({ key, limit: 2, windowMs: 60_000, now: 1_000 });
  assert.equal(consumed.allowed, true);
  assert.match(query, /ON CONFLICT/);
  assert.match(query, /RETURNING/);
  assert.match(query, /DELETE FROM "AuthRateLimit"/);
  assert.match(query, /LIMIT \$4/);
  assert.equal(values[0], key);
  assert.equal(values[3], 256);
  assert.equal(values[4], 2);
});

test('auth retention opportunistically prunes a bounded batch of expired in-memory rows', () => {
  const store = new ControlPlaneStore();
  for (let index = 0; index < 300; index += 1) {
    store.authRateLimits.set(`expired-${index}`, {
      key: `expired-${index}`,
      count: 1,
      windowStartedAt: 0,
      expiresAt: 999,
    });
  }
  store.emailVerificationCodes = Array.from({ length: 300 }, (_, index) => ({
    id: `expired-code-${index}`,
    email: `expired-${index}@example.test`,
    purpose: 'request-padding',
    expiresAt: new Date(999).toISOString(),
    consumedAt: null,
  }));

  store.consumeAuthRateLimit({ key: 'active', limit: 10, windowMs: 60_000, now: 1_000 });
  store.replaceEmailVerificationCode({
    email: 'active@example.test',
    purpose: 'request-padding',
    codeHash: 'hash',
    codeSalt: 'salt',
    expiresAt: new Date(61_000).toISOString(),
    sentAt: new Date(1_000).toISOString(),
  });

  assert.equal(store.authRateLimits.size, 45);
  assert.equal(store.emailVerificationCodes.length, 45);
});

test('password replacement increments the session version', () => {
  const store = new ControlPlaneStore();
  const first = store.createUser({ email: 'password-version@example.com', passwordHash: 'old-hash', approvalStatus: 'APPROVED' });
  const replaced = store.createUser({ email: 'password-version@example.com', passwordHash: 'new-hash', approvalStatus: 'APPROVED' });
  assert.equal(first.sessionVersion, 0);
  assert.equal(replaced.sessionVersion, 1);
});

test('membership role changes and removals revoke existing sessions', () => {
  const secret = 'membership-session-secret';
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Membership Org', slug: 'membership-org' });
  const user = store.createUser({ email: 'member@example.com', approvalStatus: 'APPROVED' });
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });

  const ownerToken = createSessionToken(user, store.listMembershipsForUser(user.id), secret);
  store.addMember({ organizationId: organization.id, userId: user.id, role: 'viewer' });
  assert.throws(
    () => subjectFromRequest(bearerRequest(ownerToken), { mode: 'jwt', jwtSecret: secret, currentUser: (id) => store.findUserById(id) }),
    /session has been revoked/,
  );
  assert.equal(store.findUserById(user.id).sessionVersion, 1);

  const viewer = store.findUserById(user.id);
  const viewerToken = createSessionToken(viewer, store.listMembershipsForUser(user.id), secret);
  assert.equal(typeof store.removeMember, 'function');
  store.removeMember({ organizationId: organization.id, userId: user.id });
  assert.throws(
    () => subjectFromRequest(bearerRequest(viewerToken), { mode: 'jwt', jwtSecret: secret, currentUser: (id) => store.findUserById(id) }),
    /session has been revoked/,
  );
  assert.equal(store.findUserById(user.id).sessionVersion, 2);
});

test('an authoritative user lookup rejects legacy sessions for deleted users', () => {
  const secret = 'legacy-deleted-user-secret';
  const token = signJwtHs256({
    sub: 'deleted-user',
    role: 'viewer',
    organizationId: 'org-a',
  }, secret);

  const legacySubject = subjectFromRequest(bearerRequest(token), { mode: 'jwt', jwtSecret: secret });
  assert.equal(legacySubject.id, 'deleted-user');
  assert.equal(legacySubject.organizationId, 'org-a');

  assert.throws(
    () => subjectFromRequest(bearerRequest(token), {
      mode: 'jwt',
      jwtSecret: secret,
      currentUser: () => null,
    }),
    (error) => error.statusCode === 401 && /session user no longer exists/.test(error.message),
  );
});

test('Prisma membership role changes and removals rotate sessionVersion in transactions', async () => {
  let transactionCalls = 0;
  const userUpdates = [];
  const deletedMemberships = [];
  const prisma = {
    membership: {
      findUnique: async () => ({ organizationId: 'org-a', userId: 'user-a', role: 'owner' }),
      upsert: async () => ({ organizationId: 'org-a', userId: 'user-a', role: 'viewer' }),
      delete: async ({ where }) => {
        deletedMemberships.push(where);
        return { organizationId: 'org-a', userId: 'user-a', role: 'viewer' };
      },
    },
    user: {
      update: async (query) => {
        userUpdates.push(query);
        return { id: 'user-a', sessionVersion: userUpdates.length };
      },
    },
  };
  prisma.$transaction = async (operation) => {
    transactionCalls += 1;
    return operation(prisma);
  };
  const repo = new PrismaControlPlaneRepository(prisma);

  await repo.addMember({ organizationId: 'org-a', userId: 'user-a', role: 'viewer' });
  assert.equal(transactionCalls, 1);
  assert.deepEqual(userUpdates[0], { where: { id: 'user-a' }, data: { sessionVersion: { increment: 1 } } });

  assert.equal(typeof repo.removeMember, 'function');
  await repo.removeMember({ organizationId: 'org-a', userId: 'user-a' });
  assert.equal(transactionCalls, 2);
  assert.equal(deletedMemberships.length, 1);
  assert.deepEqual(userUpdates[1], { where: { id: 'user-a' }, data: { sessionVersion: { increment: 1 } } });
});

test('logout rotates the authenticated user session version and rejects token replay', async () => {
  const secret = 'logout-revocation-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const organization = controlPlane.store.createOrganization({ name: 'Logout Org', slug: 'logout-org' });
  const user = controlPlane.store.createUser({ email: 'logout@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: organization.id, userId: user.id, role: 'viewer' });
  const token = createSessionToken(user, controlPlane.store.listMembershipsForUser(user.id), secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const logout = await request(port, 'POST', '/auth/logout', null, token);
    assert.equal(logout.statusCode, 200);
    assert.equal(controlPlane.store.findUserById(user.id).sessionVersion, 1);

    const replay = await request(port, 'GET', '/auth/me', null, token);
    assert.equal(replay.statusCode, 401);
    assert.match(replay.body.error, /session has been revoked/);
  } finally {
    server.close();
  }
});

test('auth rate limits do not trust spoofed X-Forwarded-For unless explicitly enabled', async () => {
  const previous = snapshotEnv(['RAIBITSERVER_TRUST_PROXY_HEADERS']);
  delete process.env.RAIBITSERVER_TRUST_PROXY_HEADERS;
  const secret = 'xff-spoof-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret, issuer: 'raibitserver' } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const signup = await request(port, 'POST', '/auth/signup', { email: 'xff@example.com', password: 'correct-horse', organizationSlug: 'xff-org' });
    assert.equal(signup.statusCode, 201);

    let limited;
    for (let i = 0; i < 11; i += 1) {
      limited = await request(port, 'POST', '/auth/login', { email: 'xff@example.com', password: `wrong-${i}` }, null, { 'x-forwarded-for': `198.51.100.${i}` });
    }
    assert.equal(limited.statusCode, 429);
  } finally {
    server.close();
    restoreEnv(previous);
  }
});

test('tenant API rejects risky sources and strips service/resource mass-assignment fields', async () => {
  const previous = snapshotEnv(['NODE_ENV', 'RAIBITSERVER_ALLOW_LOCAL_SOURCE']);
  const controlPlane = new RAIBITSERVERControlPlane();
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'disabled', allowDisabled: true, defaultRole: 'owner' } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const org = controlPlane.store.createOrganization({ name: 'Secure Org', slug: 'secure-org' });
    const project = controlPlane.store.createProject({ organizationId: org.id, name: 'secure', slug: 'secure' });
    process.env.NODE_ENV = 'production';
    const localSource = await request(port, 'POST', `/projects/${project.id}/services`, { name: 'local', sourceType: 'local', localPath: '/etc' });
    assert.equal(localSource.statusCode, 400);
    const privateGit = await request(port, 'POST', `/projects/${project.id}/services`, { name: 'git', sourceType: 'github', repoUrl: 'https://127.0.0.1/internal/repo.git' });
    assert.equal(privateGit.statusCode, 400);

    process.env.NODE_ENV = 'development';
    process.env.RAIBITSERVER_ALLOW_LOCAL_SOURCE = '1';
    for (const [name, repoUrl, secret] of [
      ['file-userinfo', 'file://user:file-api-secret@localhost/repo.git', 'file-api-secret'],
      ['file-query', 'file:///tmp/repo.git?access_token=file-query-api-secret', 'file-query-api-secret'],
    ]) {
      const credentialedFile = await request(port, 'POST', `/projects/${project.id}/services`, { name, sourceType: 'github', repoUrl });
      assert.equal(credentialedFile.statusCode, 400);
      assert.match(credentialedFile.body.error, /credentialed git URLs are not allowed/i);
      assert.equal(JSON.stringify(credentialedFile.body).includes(secret), false);
    }
    restoreEnv(previous);

    const service = await request(port, 'POST', `/projects/${project.id}/services`, {
      name: 'web',
      sourceType: 'image',
      image: 'registry.local/web:1',
      status: 'READY',
      desiredState: { privileged: true },
      projectId: 'other-project',
      id: 'attacker-id',
    });
    assert.equal(service.statusCode, 201);
    assert.equal(service.body.status, 'created');
    assert.equal(service.body.desiredState, undefined);
    assert.notEqual(service.body.id, 'attacker-id');
    assert.equal(service.body.projectId, project.id);

    const resource = await request(port, 'POST', `/projects/${project.id}/resources`, { name: 'pg', engine: 'postgresql', status: 'READY', desiredState: { providerConnection: 'secret' } });
    assert.equal(resource.statusCode, 201);
    assert.equal(resource.body.status, 'provisioning');
    assert.notEqual(resource.body.desiredState.status, 'READY');
  } finally {
    server.close();
    restoreEnv(previous);
  }
});

test('limited environment writers can update plain keys but not secret-looking keys', async () => {
  const secret = 'env-write-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Env Org', slug: 'env-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'env', slug: 'env' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'web', sourceType: 'image', image: 'registry.local/web:1' });
  const user = controlPlane.store.createUser({ id: 'dev-env', email: 'dev-env@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: org.id, userId: user.id, role: 'developer' });
  const token = signJwtHs256({ sub: user.id, role: 'developer', organizationId: org.id }, secret);
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const plain = await request(port, 'POST', `/projects/${project.id}/services/${service.id}/env`, { PUBLIC_FLAG: 'true' }, token);
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.body.plainCount, 1);

    const secretWrite = await request(port, 'POST', `/projects/${project.id}/services/${service.id}/env`, { DATABASE_URL: 'postgresql://user:pass@db/app' }, token);
    assert.equal(secretWrite.statusCode, 403);
    assert.match(secretWrite.body.error, /requires env:write/);

    const fileSecretWrite = await request(port, 'POST', `/projects/${project.id}/services/${service.id}/env-file`, { content: 'API_TOKEN=secret-token' }, token);
    assert.equal(fileSecretWrite.statusCode, 403);
    assert.match(fileSecretWrite.body.error, /requires env:write/);
  } finally {
    server.close();
  }
});

test('deployment status changes require a builder/system actor, not normal deploy permission', async () => {
  const secret = 'status-secret';
  const controlPlane = new RAIBITSERVERControlPlane();
  const org = controlPlane.store.createOrganization({ name: 'Status Org', slug: 'status-org' });
  const project = controlPlane.store.createProject({ organizationId: org.id, name: 'status', slug: 'status' });
  const service = controlPlane.store.createService({ projectId: project.id, name: 'api', sourceType: 'image', image: 'registry.local/api:1' });
  const deployment = controlPlane.store.createDeployment({ serviceId: service.id, status: 'queued' });
  const developerUser = controlPlane.store.createUser({ id: 'dev', email: 'status-dev@example.com', approvalStatus: 'APPROVED' });
  controlPlane.store.addMember({ organizationId: org.id, userId: developerUser.id, role: 'developer' });
  const server = http.createServer(createApiHandler(controlPlane, { auth: { mode: 'jwt', jwtSecret: secret } }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const developer = signJwtHs256({ sub: developerUser.id, role: 'developer', organizationId: org.id }, secret);
    const denied = await request(port, 'POST', `/deployments/${deployment.id}/status`, { status: 'BUILDING' }, developer);
    assert.equal(denied.statusCode, 403);

    const globalOwner = signJwtHs256({ sub: 'owner', role: 'owner', global: true }, secret);
    const ownerDenied = await request(port, 'POST', `/deployments/${deployment.id}/status`, { status: 'BUILDING' }, globalOwner);
    assert.equal(ownerDenied.statusCode, 403);

    const builder = signJwtHs256({ sub: 'builder', role: 'owner', global: true, system: true }, secret);
    const allowed = await request(port, 'POST', `/deployments/${deployment.id}/status`, { status: 'BUILDING', workflowJob: { injected: true } }, builder);
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.status, 'BUILDING');
    assert.equal(allowed.body.workflowJob, undefined);
  } finally {
    server.close();
  }
});

test('resource console audit stores redacted query previews instead of raw statements', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  const project = controlPlane.store.createProject({ organizationId: 'org-1', name: 'audit', slug: 'audit' });
  const resource = controlPlane.store.createResource({ projectId: project.id, name: 'local-sqlite', engine: 'sqlite' });
  await controlPlane.store.runResourceConsoleQuery(resource.id, "SELECT 'super-secret-token' AS token", { role: 'db-admin', confirmed: true, actorUserId: 'tester' });
  const audit = controlPlane.store.snapshot().auditLogs.find((row) => row.action === 'resource.console:query');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit.metadata).includes('super-secret-token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(audit.metadata, 'query'), false);
  assert.match(audit.metadata.queryPreview, /SELECT '\?' AS token/);
});

function decodeJwt(token) {
  return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
}

function bearerRequest(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

function request(port, method, path, body = null, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { ...extraHeaders, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

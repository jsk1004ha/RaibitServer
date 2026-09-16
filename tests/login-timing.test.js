import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import ts from 'typescript';
import { registerHooks } from 'node:module';

const schemaSubpaths = new Map([
  ['@raibitserver/schemas', new URL('../packages/schemas/src/index.ts', import.meta.url)],
  ['@raibitserver/schemas/deployment-health-contract', new URL('../packages/schemas/src/deployment-health-contract.ts', import.meta.url)],
  ['@raibitserver/schemas/desired-state-validation', new URL('../packages/schemas/src/desired-state-validation.ts', import.meta.url)],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (schemaSubpaths.has(specifier)) return { url: schemaSubpaths.get(specifier).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createApiHandler } = await import('../packages/core/src/api.ts');
const { RAIBITSERVERControlPlane, ResourceCapabilityUnavailable, ResourceIntentInvalid } = await import('../packages/core/src/index.ts');
const { createSessionToken, hashPassword, normalizeEmail, shouldPromoteFirstLogin, verifyPasswordAsync } = await import('../packages/core/src/identity.ts');
const schemas = await import('../packages/schemas/src/index.ts');
const UnmatchedCoreError = class extends Error {};

test('compatibility API login runs one async scrypt for every account state', async () => {
  const controlPlane = new RAIBITSERVERControlPlane();
  controlPlane.store.createUser({
    email: 'existing-compat@example.com',
    passwordHash: hashPassword('correct-horse'),
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  controlPlane.store.createUser({
    email: 'nullable-compat@example.com',
    passwordHash: null,
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  controlPlane.store.createUser({
    email: 'malformed-compat@example.com',
    passwordHash: 'not-a-password-hash',
    emailVerifiedAt: new Date().toISOString(),
    approvalStatus: 'APPROVED',
  });
  const server = http.createServer(createApiHandler(controlPlane, {
    auth: { mode: 'jwt', jwtSecret: 'compatibility-login-timing-secret' },
  }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const existing = await countAsyncScryptCalls(async () => {
      const response = await request(port, '/auth/login', {
        email: 'existing-compat@example.com',
        password: 'wrong-password',
      });
      assert.deepEqual(response, { statusCode: 401, body: { error: 'invalid_credentials' } });
    });
    const missing = await countAsyncScryptCalls(async () => {
      const response = await request(port, '/auth/login', {
        email: 'missing-compat@example.com',
        password: 'wrong-password',
      });
      assert.deepEqual(response, { statusCode: 401, body: { error: 'invalid_credentials' } });
    });
    const nullable = await countAsyncScryptCalls(async () => {
      const response = await request(port, '/auth/login', {
        email: 'nullable-compat@example.com',
        password: 'wrong-password',
      });
      assert.deepEqual(response, { statusCode: 401, body: { error: 'invalid_credentials' } });
    });
    const malformed = await countAsyncScryptCalls(async () => {
      const response = await request(port, '/auth/login', {
        email: 'malformed-compat@example.com',
        password: 'wrong-password',
      });
      assert.deepEqual(response, { statusCode: 401, body: { error: 'invalid_credentials' } });
    });

    assert.equal(existing, 1);
    assert.equal(missing, 1);
    assert.equal(nullable, 1);
    assert.equal(malformed, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Nest login runs one async scrypt for every account state', async () => {
  const users = new Map([
    ['existing-nest@example.com', {
      id: 'existing-nest',
      email: 'existing-nest@example.com',
      passwordHash: hashPassword('correct-horse'),
    }],
    ['nullable-nest@example.com', {
      id: 'nullable-nest',
      email: 'nullable-nest@example.com',
      passwordHash: null,
    }],
    ['malformed-nest@example.com', {
      id: 'malformed-nest',
      email: 'malformed-nest@example.com',
      passwordHash: 'not-a-password-hash',
    }],
  ]);
  const repository = {
    findUserByEmail: async (email) => users.get(email) || null,
  };
  const Service = await loadNestService(repository);
  const service = new Service();
  const previousSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'nest-login-timing-secret';

  try {
    const existing = await countAsyncScryptCalls(async () => {
      await assert.rejects(
        service.login({ email: 'existing-nest@example.com', password: 'wrong-password' }),
        /invalid credentials/,
      );
    });
    const missing = await countAsyncScryptCalls(async () => {
      await assert.rejects(
        service.login({ email: 'missing-nest@example.com', password: 'wrong-password' }),
        /invalid credentials/,
      );
    });
    const nullable = await countAsyncScryptCalls(async () => {
      await assert.rejects(
        service.login({ email: 'nullable-nest@example.com', password: 'wrong-password' }),
        /invalid credentials/,
      );
    });
    const malformed = await countAsyncScryptCalls(async () => {
      await assert.rejects(
        service.login({ email: 'malformed-nest@example.com', password: 'wrong-password' }),
        /invalid credentials/,
      );
    });

    assert.equal(existing, 1);
    assert.equal(missing, 1);
    assert.equal(nullable, 1);
    assert.equal(malformed, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.RAIBITSERVER_AUTH_JWT_SECRET;
    else process.env.RAIBITSERVER_AUTH_JWT_SECRET = previousSecret;
  }
});

test('Nest auth maps invalid email input to a 400-class exception', async () => {
  const Service = await loadNestService({ findUserByEmail: async () => null });
  const service = new Service();
  const previousSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'nest-invalid-email-secret';

  try {
    for (const operation of [
      () => service.signup({ email: 'not-an-email', password: 'correct-horse' }),
      () => service.resendEmailVerification({ email: 'not-an-email' }),
      () => service.login({ email: 'not-an-email', password: 'wrong-password' }),
    ]) {
      await assert.rejects(operation, (error) => error instanceof TestBadRequestException);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.RAIBITSERVER_AUTH_JWT_SECRET;
    else process.env.RAIBITSERVER_AUTH_JWT_SECRET = previousSecret;
  }
});

test('production Nest login never loads the unbounded user list for disabled first-login promotion', async () => {
  let listUsersCalls = 0;
  const repository = {
    findUserByEmail: async () => ({
      id: 'production-user',
      email: 'production-user@example.test',
      passwordHash: hashPassword('correct-horse'),
      role: 'USER',
      accountType: 'NON_CLUB',
      approvalStatus: 'APPROVED',
      emailVerifiedAt: new Date().toISOString(),
      sessionVersion: 0,
    }),
    listUsers: async () => {
      listUsersCalls += 1;
      throw new Error('production login must not enumerate all users');
    },
    listMembershipsForUser: async () => [],
  };
  const Service = await loadNestService(repository);
  const service = new Service();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.RAIBITSERVER_AUTH_JWT_SECRET = 'production-login-bounded-secret';

  try {
    const result = await service.login({
      email: 'production-user@example.test',
      password: 'correct-horse',
    });
    assert.equal(result.user.id, 'production-user');
    assert.equal(listUsersCalls, 0);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.RAIBITSERVER_AUTH_JWT_SECRET;
    else process.env.RAIBITSERVER_AUTH_JWT_SECRET = previousSecret;
  }
});

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

async function loadNestService(repository) {
  const source = await fs.readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      emitDecoratorMetadata: false,
      experimentalDecorators: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const nest = {
    BadRequestException: TestBadRequestException,
    ConflictException: TestHttpException,
    ForbiddenException: TestHttpException,
    HttpException: TestHttpException,
    Injectable: () => (target) => target,
    NotFoundException: TestHttpException,
    UnauthorizedException: TestHttpException,
  };
  const core = new Proxy({
    ResourceCapabilityUnavailable,
    ResourceIntentInvalid,
    OrganizationCreationError: UnmatchedCoreError,
    ProjectSettingsError: UnmatchedCoreError,
    GitHubSourceConflict: UnmatchedCoreError,
    RecoveryError: UnmatchedCoreError,
    DeploymentOperationError: UnmatchedCoreError,
    createSessionToken,
    createControlPlaneRepository: () => Promise.resolve(repository),
    enforceAuthAbuseLimits: async () => {},
    normalizeEmail,
    shouldPromoteFirstLogin,
    verifyPasswordAsync,
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {
        throw new Error(`unexpected @raibitserver/core call: ${String(property)}`);
      };
    },
  });
  const require = (specifier) => {
    if (specifier === '@nestjs/common') return nest;
    if (specifier === '@raibitserver/core') return core;
    if (specifier === '@raibitserver/schemas') return schemas;
    throw new Error(`unexpected module import: ${specifier}`);
  };
  const execute = new Function('exports', 'require', 'module', compiled);
  execute(module.exports, require, module);
  return module.exports.RAIBITSERVERService;
}

class TestHttpException extends Error {}
class TestBadRequestException extends TestHttpException {}

function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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

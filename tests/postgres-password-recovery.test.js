import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../packages/core/src/identity.ts';
import { completePasswordRecovery, requestPasswordRecovery } from '../packages/core/src/password-recovery.ts';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';

const require = createRequire(import.meta.url);
const databaseUrl = process.env.RAIBITSERVER_TEST_DATABASE_URL;
const postgresOptions = {
  skip: databaseUrl ? false : 'NOT_RUN: RAIBITSERVER_TEST_DATABASE_URL is deferred by user approval',
};
const jwtSecret = 'postgres-password-recovery-secret';
const env = {
  NODE_ENV: 'test',
  RAIBITSERVER_EMAIL_FROM: 'RAIBITSERVER <password-reset@example.test>',
  RAIBITSERVER_EMAIL_VERIFICATION_TEST_CODE: '246810',
};

test('password recovery happy path and adversarial matrix are atomic in PostgreSQL', postgresOptions, async (t) => {
  assert.ok(databaseUrl);
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: databaseUrl });
  const schema = `password_reset_${randomUUID().replaceAll('-', '')}`;
  const repositories = [];
  t.after(async () => {
    await Promise.all(repositories.map((repository) => repository.disconnect()));
    try { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
    t.diagnostic(JSON.stringify({ cleanup: 'PASS', schema }));
  });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  const migrate = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: url.href },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
  for (let index = 0; index < 20; index += 1) {
    repositories.push(await PrismaControlPlaneRepository.connect({
      env: { ...process.env, RAIBITSERVER_DB_POOL_SIZE: '1' },
      prismaOptions: { datasourceUrl: url.href, transactionOptions: { maxWait: 30_000, timeout: 30_000 } },
    }));
  }

  const email = `postgres-reset-${randomUUID()}@example.test`;
  const user = await repositories[0].createUser({
    email,
    name: 'PostgreSQL Reset',
    passwordHash: hashPassword('old-password'),
    approvalStatus: 'APPROVED',
    emailVerifiedAt: new Date(),
  });
  await requestPasswordRecovery(repositories[0], { email }, {
    jwtSecret,
    env,
    scheduleDelivery: () => {},
  });

  const outcomes = await Promise.allSettled(repositories.map((repository) => completePasswordRecovery(repository, {
    email,
    code: '246810',
    newPassword: 'new-password',
  }, { jwtSecret, env })));

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 19);
  const updated = await repositories[0].findUserByEmail(email);
  assert.equal(verifyPassword('new-password', updated.passwordHash), true);
  assert.equal(updated.sessionVersion, user.sessionVersion + 1);
  assert.equal(await repositories[0].prisma.emailVerificationCode.count({ where: { email, purpose: 'password-reset', consumedAt: null } }), 0);
  assert.equal(await repositories[0].prisma.auditLog.count({ where: { actorUserId: user.id, action: 'user.password:reset' } }), 1);
  const stored = JSON.stringify(await repositories[0].prisma.emailVerificationCode.findMany({ where: { email } }));
  assert.equal(stored.includes('246810'), false);
  assert.equal(stored.includes('new-password'), false);
  t.diagnostic(JSON.stringify({ consumers: 20, winners: 1, sessionVersionIncrement: 1, rawSecretMatches: 0 }));
});

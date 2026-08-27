import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { keysetCursorForRows, utcMonthBounds } from '../packages/core/src/store-helpers.ts';

const databaseUrl = process.env.RAIBITSERVER_TEST_DATABASE_URL;

test('Prisma repository matches migrated PostgreSQL schema and preserves production boundaries', { skip: !databaseUrl }, async () => {
  const repository = await PrismaControlPlaneRepository.connect({
    env: { ...process.env, DATABASE_URL: databaseUrl },
    prismaOptions: { datasourceUrl: databaseUrl },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const rateLimitKey = `integration:${suffix}`;
  let organization;
  let user;

  try {
    user = await repository.createUser({
      email: `postgres-${suffix}@example.test`,
      name: 'PostgreSQL Integration',
      role: 'USER',
      accountType: 'NON_CLUB',
      approvalStatus: 'APPROVED',
    });
    organization = await repository.createOrganization({ name: `Integration ${suffix}`, slug: `integration-${suffix}` });
    await repository.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
    await repository.setQuota({ userId: user.id, accountType: 'NON_CLUB', maxProjects: 20, maxServices: 20, maxDeploymentsPerDay: 20 });

    const projects = [];
    for (let index = 0; index < 3; index += 1) {
      projects.push(await repository.createProject({ organizationId: organization.id, name: `Project ${index}`, slug: `project-${suffix}-${index}`, actorUserId: user.id }));
    }
    const service = await repository.createService({
      projectId: projects[0].id,
      name: 'web',
      sourceType: 'image',
      image: 'registry.example.test/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      desiredSpec: { resources: { requests: { cpu: '250m', memory: '256Mi' } } },
    });
    await repository.upsertServiceEnvironment({
      projectId: projects[0].id,
      serviceId: service.id,
      actorUserId: user.id,
      entries: [
        { key: 'PUBLIC_URL', value: 'https://integration.example.test', isSecret: false },
        { key: 'API_TOKEN', value: 'must-remain-sealed', isSecret: true },
      ],
    });
    const serviceWithEnvironment = await repository.getService(service.id);
    assert.equal(serviceWithEnvironment.desiredSpec.env.PUBLIC_URL, 'https://integration.example.test');
    assert.equal(serviceWithEnvironment.desiredSpec.env.API_TOKEN, undefined);

    const month = utcMonthBounds();
    const buildStartedAt = new Date(month.start + 2 * 86_400_000);
    const buildFinishedAt = new Date(buildStartedAt.getTime() + 10 * 60_000);
    const deployedAt = new Date(buildFinishedAt.getTime());
    const finishedAt = new Date(deployedAt.getTime() + 2 * 3_600_000);
    await repository.createDeployment({
      projectId: projects[0].id,
      serviceId: service.id,
      status: 'READY',
      deploymentType: 'preview',
      imageUrl: 'registry.example.test/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      buildStartedAt,
      buildFinishedAt,
      deployedAt,
      finishedAt,
    });
    await repository.prisma.usageRecord.createMany({
      data: [
        { userId: user.id, metric: 'build-minutes', value: 5, unit: 'minutes', recordedAt: new Date(month.start + 3 * 86_400_000) },
        { userId: user.id, metric: 'build-minutes', value: 999, unit: 'minutes', recordedAt: new Date(month.start - 86_400_000) },
      ],
    });

    const usage = await repository.quotaUsageForUser(user.id);
    assert.equal(usage.maxProjects, 3);
    assert.equal(usage.maxServices, 1);
    assert.equal(usage.maxPreviewDeployments, 1);
    assert.equal(usage.maxBuildMinutesPerMonth, 15);
    assert.equal(usage.maxRuntimeHoursPerMonth, 2);
    assert.equal(usage.maxCpuMillicores, 250);
    assert.equal(usage.maxMemoryMb, 256);

    const firstPage = await repository.listProjectsForOrganizations([organization.id], { limit: 2 });
    assert.equal(firstPage.length, 2);
    const cursor = keysetCursorForRows(firstPage, 'createdAt');
    assert.ok(cursor);
    await repository.createProject({ organizationId: organization.id, name: 'Newer Project', slug: `project-${suffix}-newer` });
    const secondPage = await repository.listProjectsForOrganizations([organization.id], { limit: 2, cursor });
    assert.equal(secondPage.length, 1);
    assert.equal(firstPage.some((row) => row.id === secondPage[0].id), false);

    const workflowJob = await repository.enqueueWorkflowJob({ type: 'integration', targetType: 'project', targetId: projects[0].id, payload: {} });
    const claims = await Promise.all([
      repository.claimNextWorkflowJob({ workerId: `worker-a-${suffix}` }),
      repository.claimNextWorkflowJob({ workerId: `worker-b-${suffix}` }),
    ]);
    assert.equal(claims.filter((claim) => claim?.id === workflowJob.id).length, 1);

    const limits = await Promise.all([
      repository.consumeAuthRateLimit({ key: rateLimitKey, limit: 1, windowMs: 60_000 }),
      repository.consumeAuthRateLimit({ key: rateLimitKey, limit: 1, windowMs: 60_000 }),
    ]);
    assert.deepEqual(limits.map((entry) => entry.allowed).sort(), [false, true]);

  } finally {
    if (organization) {
      await repository.prisma.workflowJob.deleteMany({ where: { targetType: 'project', targetId: { in: (await repository.prisma.project.findMany({ where: { organizationId: organization.id }, select: { id: true } })).map((row) => row.id) } } });
      await repository.prisma.organization.deleteMany({ where: { id: organization.id } });
    }
    if (user) {
      await repository.prisma.usageRecord.deleteMany({ where: { userId: user.id } });
      await repository.prisma.user.deleteMany({ where: { id: user.id } });
    }
    await repository.prisma.authRateLimit.deleteMany({ where: { key: rateLimitKey } });
    await repository.disconnect();
  }
});

test('Prisma cancellation terminalizes build work without violating workflow scheduling constraints', { skip: !databaseUrl }, async () => {
  const repository = await PrismaControlPlaneRepository.connect({
    env: { ...process.env, DATABASE_URL: databaseUrl },
    prismaOptions: { datasourceUrl: databaseUrl },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let organization;

  try {
    organization = await repository.createOrganization({ name: `Cancellation ${suffix}`, slug: `cancellation-${suffix}` });
    const project = await repository.createProject({ organizationId: organization.id, name: 'Cancellation', slug: `cancellation-project-${suffix}` });
    const service = await repository.createService({ projectId: project.id, name: 'web', sourceType: 'image' });
    const { deployment, workflowJob } = await repository.createDeploymentWorkflow({
      deployment: { projectId: project.id, serviceId: service.id, status: 'queued' },
      workflow: { type: 'build-and-deploy', payload: { serviceId: service.id, projectId: project.id } },
    });
    await repository.prisma.workflowJob.update({
      where: { id: workflowJob.id },
      data: { status: 'running', attempts: 1, lockedBy: 'builder-cancel-race', lockedAt: new Date() },
    });
    await repository.prisma.deployment.update({ where: { id: deployment.id }, data: { status: 'BUILDING' } });

    const result = await repository.cancelDeployment(deployment.id, { reason: 'operator cancelled' });
    assert.equal(result.deployment.status, 'CANCELLED');
    assert.ok(result.deployment.finishedAt);
    const cancelledJob = await repository.prisma.workflowJob.findUnique({ where: { id: workflowJob.id } });
    assert.equal(cancelledJob.status, 'cancelled');
    assert.equal(cancelledJob.lockedBy, null);
    assert.equal(cancelledJob.lockedAt, null);
    assert.ok(cancelledJob.runAfter instanceof Date);
    assert.equal(await repository.prisma.deploymentEvent.count({ where: { deploymentId: deployment.id, type: 'deployment.cancelled' } }), 1);

    for (const status of ['DEPLOYING', 'READY']) {
      const late = await repository.createDeployment({ projectId: project.id, serviceId: service.id, status });
      await assert.rejects(
        repository.cancelDeployment(late.id, { reason: 'too late' }),
        (error) => error?.statusCode === 409 && /deployment_cancellation_conflict/.test(error.message),
      );
      assert.equal((await repository.getDeployment(late.id)).status, status);
    }
  } finally {
    if (organization) await repository.prisma.organization.deleteMany({ where: { id: organization.id } });
    await repository.disconnect();
  }
});

test('Prisma email challenge replacement serializes concurrent writers', { skip: !databaseUrl }, async () => {
  const repository = await PrismaControlPlaneRepository.connect({
    env: { ...process.env, DATABASE_URL: databaseUrl },
    prismaOptions: { datasourceUrl: databaseUrl },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const email = `verification-${suffix}@example.test`;

  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => repository.replaceEmailVerificationCode({
      email,
      purpose: 'signup',
      payload: { kind: 'signup', index },
      codeHash: `hash-${index}`,
      codeSalt: `salt-${index}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sentAt: new Date().toISOString(),
      attempts: 0,
    })));
    const activeChallenges = await repository.prisma.emailVerificationCode.findMany({
      where: { email, purpose: 'signup', consumedAt: null },
    });
    assert.equal(activeChallenges.length, 1);
  } finally {
    await repository.prisma.emailVerificationCode.deleteMany({ where: { email } });
    await repository.disconnect();
  }
});

test('Prisma auth retention prunes bounded expired batches without deleting active rows', { skip: !databaseUrl }, async () => {
  const repository = await PrismaControlPlaneRepository.connect({
    env: { ...process.env, DATABASE_URL: databaseUrl },
    prismaOptions: { datasourceUrl: databaseUrl },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ratePrefix = `retention:${suffix}:`;
  const emailPrefix = `retention-${suffix}-`;
  const expiredAt = new Date(Date.now() - 60_000);
  const activeExpiresAt = new Date(Date.now() + 60_000);

  try {
    await repository.prisma.authRateLimit.createMany({
      data: Array.from({ length: 300 }, (_, index) => ({
        key: `${ratePrefix}${index}`,
        count: 1,
        windowStartedAt: new Date(expiredAt.getTime() - 60_000),
        expiresAt: expiredAt,
      })),
    });
    await repository.prisma.emailVerificationCode.createMany({
      data: Array.from({ length: 300 }, (_, index) => ({
        email: `${emailPrefix}${index}@example.test`,
        purpose: 'request-padding',
        codeHash: `expired-hash-${index}`,
        codeSalt: `expired-salt-${index}`,
        expiresAt: expiredAt,
        sentAt: expiredAt,
      })),
    });

    const activeRateKey = `${ratePrefix}active`;
    const activeEmail = `${emailPrefix}active@example.test`;
    await repository.consumeAuthRateLimit({ key: `${ratePrefix}prune-1`, limit: 10, windowMs: 60_000 });
    assert.equal(await repository.prisma.authRateLimit.count({
      where: { key: { startsWith: ratePrefix }, expiresAt: { lte: new Date() } },
    }), 44);
    await repository.consumeAuthRateLimit({ key: `${ratePrefix}prune-2`, limit: 10, windowMs: 60_000 });
    const concurrentLimits = await Promise.all([
      repository.consumeAuthRateLimit({ key: activeRateKey, limit: 1, windowMs: 60_000 }),
      repository.consumeAuthRateLimit({ key: activeRateKey, limit: 1, windowMs: 60_000 }),
    ]);
    assert.deepEqual(concurrentLimits.map((result) => result.allowed).sort(), [false, true]);
    await repository.replaceEmailVerificationCode({
      email: activeEmail,
      purpose: 'request-padding',
      codeHash: 'active-hash',
      codeSalt: 'active-salt',
      expiresAt: activeExpiresAt.toISOString(),
      sentAt: new Date().toISOString(),
    });

    assert.equal(await repository.prisma.authRateLimit.count({
      where: { key: { startsWith: ratePrefix }, expiresAt: { lte: new Date() } },
    }), 0);
    assert.equal(await repository.prisma.emailVerificationCode.count({
      where: { email: { startsWith: emailPrefix }, expiresAt: { lte: new Date() } },
    }), 44);
    assert.equal((await repository.peekAuthRateLimit({ key: activeRateKey, limit: 1 })).count, 1);
    assert.equal(await repository.prisma.emailVerificationCode.count({
      where: { email: activeEmail, consumedAt: null },
    }), 1);
  } finally {
    await repository.prisma.authRateLimit.deleteMany({ where: { key: { startsWith: ratePrefix } } });
    await repository.prisma.emailVerificationCode.deleteMany({ where: { email: { startsWith: emailPrefix } } });
    await repository.disconnect();
  }
});

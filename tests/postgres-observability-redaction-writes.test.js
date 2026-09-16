import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { appendPrismaObservationLog } from '../packages/core/src/observability-writes.ts';

test('PostgreSQL log writes serialize finite redaction checkpoints across restart and rollback', {
  skip: !process.env.RAIBITSERVER_TEST_DATABASE_URL && process.env.RAIBITSERVER_REQUIRE_POSTGRES_TESTS !== '1',
}, async t => {
  // Given a disposable CI database with unique tenant rows and independent clients.
  assert.ok(process.env.RAIBITSERVER_TEST_DATABASE_URL, 'disposable PostgreSQL URL is required');
  const repositories = [];
  const connect = async () => {
    const repository = await PrismaControlPlaneRepository.connect({ prismaOptions: { datasourceUrl: process.env.RAIBITSERVER_TEST_DATABASE_URL } });
    repositories.push(repository);
    return repository;
  };
  const first = await connect();
  const prisma = first.prisma;
  const id = 'redaction-' + randomUUID();
  const stateKeys = [];
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.ingestionCursor.deleteMany({ where: { key: { in: stateKeys } } });
    await Promise.all(repositories.map(repository => repository.disconnect()));
  });
  await prisma.organization.create({ data: { id, name: id, slug: id } });
  await prisma.project.create({ data: { id, organizationId: id, name: id, slug: id } });
  await prisma.service.create({ data: { id, projectId: id, name: 'app', slug: 'app', type: 'web', sourceType: 'image' } });
  await prisma.deployment.create({ data: { id, projectId: id, serviceId: id } });
  const canary = 'AuditSyntheticValue_97531';
  for (const kind of ['runtime', 'build']) {
    const data = kind === 'runtime'
      ? { serviceId: id, deploymentId: id, podUid: id, podName: id, containerName: 'app', level: 'info' }
      : { deploymentId: id, step: 'build', level: 'info' };
    const scope = kind === 'runtime' ? [kind, id, id, id, 'app'] : [kind, id, 'build'];
    const key = 'ts-log-state:' + createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    stateKeys.push(key);
    const append = (repository, line) => kind === 'runtime'
      ? repository.appendRuntimeLog({ ...data, line })
      : repository.appendBuildLog({ ...data, line });
    // When the opener is committed, another client resumes and a closing write rolls back.
    const opening = await append(first, 'POSTGRES_PASSWORD="begin');
    const restarted = await connect();
    await assert.rejects(appendPrismaObservationLog(restarted.prisma, { kind, data: { ...data, id: opening.id, line: 'end"' } }));
    const middle = await Promise.all([append(first, canary), append(restarted, canary)]);
    const end = await append(restarted, 'end" ready=true');
    const visible = await append(first, 'healthy');
    // Then committed rows and state show no secret, successful close restores ordinary output.
    assert.deepEqual(middle.map(row => row.line), ['****', '****']);
    assert.equal(end.line, '****" ready=true');
    assert.equal(visible.line, 'healthy');
    const model = kind === 'runtime' ? prisma.runtimeLog : prisma.buildLog;
    const rows = await model.findMany({ where: { deploymentId: id } });
    assert.equal(JSON.stringify(rows).includes(canary), false);
    const cursor = await prisma.ingestionCursor.findUnique({ where: { key } });
    assert.deepEqual(JSON.parse(cursor.cursor), { v: 1, pem: false });
    // Missing checkpoint for an existing source is not mistaken for a new source.
    await prisma.ingestionCursor.delete({ where: { key } });
    assert.equal((await append(restarted, canary)).line, '****');
  }
  t.diagnostic('runtime/build checkpoint restart, concurrent writes, failed-insert rollback, and missing-state masking verified');
});

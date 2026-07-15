import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as workflows from '../packages/core/src/workflows.ts';
import { ControlPlaneStore } from '../packages/core/src/store.ts';
import { InMemoryControlPlaneRepository, PrismaControlPlaneRepository } from '../packages/core/src/persistence.ts';
import { boundedActivityRows, decodeKeysetCursor } from '../packages/core/src/store-helpers.ts';

const cursor = (at, id) => Buffer.from(JSON.stringify({ v: 1, at, id }), 'utf8').toString('base64url');

test('activity lists are bounded, chronological, and support an after cursor', () => {
  const store = new ControlPlaneStore();
  store.buildLogs = Array.from({ length: 1_205 }, (_, index) => ({
    id: `log-${index}`,
    deploymentId: 'dep-1',
    line: String(index),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));

  const defaultPage = store.listDeploymentLogs('dep-1');
  assert.equal(defaultPage.length, 200);
  assert.equal(defaultPage[0].id, 'log-1005');
  assert.equal(defaultPage.at(-1).id, 'log-1204');

  const cursorPage = store.listDeploymentLogs('dep-1', { after: store.buildLogs[99].timestamp, limit: 10_000 });
  assert.equal(cursorPage.length, 1_000);
  assert.equal(cursorPage[0].id, 'log-100');
  assert.equal(cursorPage.at(-1).id, 'log-1099');
});

test('Prisma activity queries enforce the same database-side bound', async () => {
  let query;
  const prisma = {
    buildLog: {
      async findMany(input) {
        query = input;
        return [{ id: 'new', timestamp: new Date('2026-01-02T00:00:00Z') }, { id: 'old', timestamp: new Date('2026-01-01T00:00:00Z') }];
      },
    },
  };
  const repository = new PrismaControlPlaneRepository(prisma);
  const rows = await repository.listDeploymentLogs('dep-1', { limit: 5000 });
  assert.equal(query.take, 1000);
  assert.deepEqual(query.orderBy, [{ timestamp: 'desc' }, { id: 'desc' }]);
  assert.deepEqual(rows.map((row) => row.id), ['old', 'new']);
});

test('project lists return service and resource counts without per-project queries', async () => {
  const store = new ControlPlaneStore();
  const organization = store.createOrganization({ name: 'Counts', slug: 'counts' });
  const project = store.createProject({ organizationId: organization.id, name: 'Counted', slug: 'counted' });
  store.createService({ projectId: project.id, name: 'web' });
  store.createResource({ projectId: project.id, name: 'postgresql', type: 'database', engine: 'postgresql' });
  store.createResource({ projectId: project.id, name: 'redis', type: 'cache', engine: 'redis' });

  const memoryRows = await new InMemoryControlPlaneRepository(store).listProjectsForOrganizations([organization.id]);
  assert.equal(memoryRows[0].serviceCount, 1);
  assert.equal(memoryRows[0].resourceCount, 2);

  let query;
  const prismaRows = await new PrismaControlPlaneRepository({
    project: {
      async findMany(input) {
        query = input;
        return [{ id: project.id, organizationId: organization.id, createdAt: new Date(), _count: { services: 1, resources: 2 } }];
      },
    },
  }).listProjectsForOrganizations([organization.id]);
  assert.deepEqual(query.include, { _count: { select: { services: true, resources: true } } });
  assert.equal(prismaRows[0].serviceCount, 1);
  assert.equal(prismaRows[0].resourceCount, 2);
  assert.equal('_count' in prismaRows[0], false);
});

test('versioned keyset cursors preserve equal-timestamp rows and reject malformed input', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const later = '2026-01-01T00:00:01.000Z';
  const activity = [
    { id: 'a', timestamp: at },
    { id: 'b', timestamp: at },
    { id: 'c', timestamp: at },
    { id: 'd', timestamp: later },
  ];
  const first = boundedActivityRows(activity, { cursor: cursor(at, 'a'), limit: 2 });
  const second = boundedActivityRows(activity, { cursor: cursor(first.at(-1).timestamp, first.at(-1).id), limit: 2 });
  assert.deepEqual([...first, ...second].map((row) => row.id), ['b', 'c', 'd']);
  assert.throws(() => boundedActivityRows(activity, { cursor: 'not-a-versioned-cursor' }), (error) => error?.statusCode === 400 && /cursor/i.test(error.message));
  assert.equal(decodeKeysetCursor(cursor('1970-01-01T00:00:00.000Z', 'epoch')).at, '1970-01-01T00:00:00.000Z');

  const store = new ControlPlaneStore();
  const repository = new InMemoryControlPlaneRepository(store);
  store.services = new Map([
    ['a', { id: 'a', projectId: 'project-1', createdAt: at }],
    ['b', { id: 'b', projectId: 'project-1', createdAt: at }],
    ['c', { id: 'c', projectId: 'project-1', createdAt: at }],
    ['old', { id: 'old', projectId: 'project-1', createdAt: '2025-12-31T23:59:59.000Z' }],
  ]);
  const newest = await repository.listServicesForProject('project-1', { limit: 2 });
  const older = await repository.listServicesForProject('project-1', { limit: 2, cursor: cursor(newest.at(-1).createdAt, newest.at(-1).id) });
  assert.deepEqual([...newest, ...older].map((row) => row.id), ['c', 'b', 'a', 'old']);
});

test('deployment listings are deterministic and bounded in memory and Prisma', async () => {
  const store = new ControlPlaneStore();
  const repository = new InMemoryControlPlaneRepository(store);
  const at = '2026-01-01T00:00:00.000Z';
  store.deployments = new Map(Array.from({ length: 1_205 }, (_, index) => {
    const id = String(index).padStart(4, '0');
    return [id, { id, serviceId: 'service-1', projectId: 'project-1', createdAt: at }];
  }));
  const rows = await repository.listDeploymentsForService('service-1', { limit: 50_000 });
  assert.equal(rows.length, 1_000);
  assert.equal(rows[0].id, '1204');
  assert.equal(rows.at(-1).id, '0205');

  let query;
  const prismaRepository = new PrismaControlPlaneRepository({
    deployment: { async findMany(input) { query = input; return []; } },
  });
  await prismaRepository.listDeploymentsForService('service-1', { limit: 50_000, cursor: cursor(at, '0205') });
  assert.equal(query.take, 1_000);
  assert.deepEqual(query.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.deepEqual(query.where.AND.at(-1).OR, [{ createdAt: { lt: new Date(at) } }, { createdAt: new Date(at), id: { lt: '0205' } }]);
});

test('bounded SSE sends only deltas, heartbeats, and releases work on disconnect', async () => {
  const sse = await import('../packages/core/src/sse.ts').catch(() => ({}));
  assert.equal(typeof sse.startBoundedSseStream, 'function');
  const req = new EventEmitter();
  const res = new FakeResponse();
  let loads = 0;
  const stream = sse.startBoundedSseStream({
    req,
    res,
    event: 'deployment.snapshot',
    initialPayload: { logs: [{ id: 'log-1' }], logCursor: 'cursor-1', stream: { retryMs: 10, heartbeatMs: 15, maxLifetimeMs: 500, slowClientTimeoutMs: 20 } },
    load: async () => {
      loads += 1;
      return loads === 1 ? { logs: [{ id: 'log-2' }], logCursor: 'cursor-2' } : { logs: [], logCursor: 'cursor-2' };
    },
  });
  await delay(45);
  const output = res.chunks.join('');
  assert.match(output, /event: deployment\.snapshot[\s\S]*log-1/);
  assert.match(output, /event: deployment\.delta[\s\S]*log-2/);
  assert.equal((output.match(/event: deployment\.delta/g) || []).length, 1);
  assert.match(output, /: keepalive /);
  req.emit('close');
  const loadsAtClose = loads;
  const chunksAtClose = res.chunks.length;
  await delay(35);
  assert.equal(loads, loadsAtClose);
  assert.equal(res.chunks.length, chunksAtClose);
  assert.equal(stream.closed, true);
});

test('bounded SSE enforces maximum lifetime and terminates stalled clients', async () => {
  const { startBoundedSseStream } = await import('../packages/core/src/sse.ts').catch(() => ({}));
  assert.equal(typeof startBoundedSseStream, 'function');
  const lifetimeResponse = new FakeResponse();
  startBoundedSseStream({
    req: new EventEmitter(),
    res: lifetimeResponse,
    event: 'service.logs.snapshot',
    initialPayload: { logs: [], stream: { retryMs: 100, heartbeatMs: 100, maxLifetimeMs: 30, slowClientTimeoutMs: 10 } },
    load: async () => ({ logs: [] }),
  });
  await delay(60);
  assert.equal(lifetimeResponse.ended, true);

  const slowResponse = new FakeResponse({ backpressureAt: 2 });
  startBoundedSseStream({
    req: new EventEmitter(),
    res: slowResponse,
    event: 'deployment.snapshot',
    initialPayload: { logs: [{ id: 'log-1' }], stream: { retryMs: 100, heartbeatMs: 100, maxLifetimeMs: 500, slowClientTimeoutMs: 15 } },
    load: async () => ({ logs: [] }),
  });
  await delay(40);
  assert.equal(slowResponse.ended, true);

  const disconnectRequest = new EventEmitter();
  const disconnectResponse = new FakeResponse({ backpressureAt: 2 });
  startBoundedSseStream({
    req: disconnectRequest,
    res: disconnectResponse,
    event: 'deployment.snapshot',
    initialPayload: { logs: [], stream: { retryMs: 100, heartbeatMs: 100, maxLifetimeMs: 500, slowClientTimeoutMs: 500 } },
    load: async () => ({ logs: [] }),
  });
  assert.equal(disconnectResponse.listenerCount('drain'), 1);
  disconnectRequest.emit('close');
  assert.equal(disconnectResponse.listenerCount('drain'), 0);

  const throwingResponse = new FakeResponse({ throwAt: 1 });
  assert.doesNotThrow(() => startBoundedSseStream({
    req: new EventEmitter(),
    res: throwingResponse,
    event: 'deployment.snapshot',
    initialPayload: { logs: [], stream: { retryMs: 100, heartbeatMs: 100, maxLifetimeMs: 500 } },
    load: async () => ({ logs: [] }),
  }));
  assert.equal(throwingResponse.ended, true);
});

test('production quota usage is computed by one aggregate database round trip', async () => {
  let queryCount = 0;
  const tracked = (value) => async () => { queryCount += 1; return value; };
  const prisma = {
    $queryRawUnsafe: tracked([{
      maxProjects: 1,
      maxServices: 1,
      maxDeploymentsPerDay: 1,
      maxPreviewDeployments: 0,
      services: [{ desiredSpec: { cpu: '250m', memory: '128Mi' } }],
      resources: [{ type: 'database', desiredSpec: { storageMb: 256 } }],
      deployments: [],
      usageRecords: [{ metric: 'build-minutes', value: 2 }],
    }]),
    membership: { findMany: tracked([{ organizationId: 'org-1' }]) },
    project: { findMany: tracked([{ id: 'project-1' }]) },
    service: { findMany: tracked([{ id: 'service-1', desiredSpec: {} }]) },
    resource: { findMany: tracked([]) },
    deployment: { findMany: tracked([]) },
    usageRecord: { findMany: tracked([]) },
  };
  const repository = new PrismaControlPlaneRepository(prisma);
  const usage = await repository.quotaUsageForUser('user-1');
  assert.equal(queryCount, 1);
  assert.equal(usage.maxProjects, 1);
  assert.equal(usage.maxCpuMillicores, 250);
  assert.equal(usage.maxBuildMinutesPerMonth, 2);
});

test('Prisma connection options clamp pool and query timeouts', async () => {
  const key = `__raibit_prisma_options_${Date.now()}`;
  const moduleSource = `export class PrismaClient { constructor(options) { globalThis[${JSON.stringify(key)}] = options; } async $connect() {} async $disconnect() {} }`;
  const clientModule = `data:text/javascript,${encodeURIComponent(moduleSource)}`;
  await PrismaControlPlaneRepository.connect({
    clientModule,
    connect: false,
    env: {
      DATABASE_URL: 'postgresql://user:secret@db.example.test:5432/control?schema=public',
      RAIBITSERVER_DB_POOL_SIZE: '9999',
      RAIBITSERVER_DB_POOL_TIMEOUT_SECONDS: '0',
      RAIBITSERVER_DB_QUERY_TIMEOUT_MS: '9999999',
    },
  });
  const options = globalThis[key];
  delete globalThis[key];
  const configured = new URL(options.datasourceUrl);
  assert.equal(configured.searchParams.get('connection_limit'), '50');
  assert.equal(configured.searchParams.get('pool_timeout'), '1');
  assert.equal(configured.searchParams.get('socket_timeout'), '60');
  assert.equal(options.transactionOptions.maxWait, 5_000);
  assert.equal(options.transactionOptions.timeout, 60_000);
});

test('workflow queue drains cap total jobs and active concurrency', async () => {
  assert.equal(typeof workflows.drainWorkflowQueue, 'function');
  const queue = Array.from({ length: 130 }, (_, index) => workflows.createWorkflowJobRecord({ id: `job-${index}`, targetId: `target-${index}`, runAfter: '2026-01-01T00:00:00.000Z' }));
  let active = 0;
  let peak = 0;
  const result = await workflows.drainWorkflowQueue(queue, {
    default: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(2);
      active -= 1;
      return { ok: true };
    },
  }, { maxJobs: 50_000, concurrency: 50_000, now: '2026-01-02T00:00:00.000Z' });
  assert.equal(result.processed, 100);
  assert.equal(result.succeeded, 100);
  assert.ok(peak <= 16, `peak concurrency ${peak} exceeded 16`);
  assert.equal(queue.filter((job) => job.status === 'queued').length, 30);
});

test('keyset query indexes cover list and activity scopes', async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8'),
    readFile(new URL('../prisma/migrations/000007_performance_boundaries/migration.sql', import.meta.url), 'utf8').catch(() => ''),
  ]);
  for (const index of [
    '@@index([organizationId, createdAt, id])',
    '@@index([projectId, createdAt, id])',
    '@@index([serviceId, createdAt, id])',
    '@@index([deploymentId, timestamp, id])',
    '@@index([serviceId, timestamp, id])',
  ]) assert.ok(schema.includes(index), `${index} missing`);
  assert.match(migration, /CREATE INDEX[^;]+\("serviceId", "createdAt", "id"\)/);
  assert.match(migration, /CREATE INDEX[^;]+\("deploymentId", "timestamp", "id"\)/);
  assert.match(migration, /CREATE INDEX[^;]+"Resource"\(UPPER\(status\), "updatedAt", "createdAt"\)/);
});

test('Nest list routes expose keyset cursors and streams load cursor deltas', async () => {
  const [projectController, serviceController, resourceController, deploymentController, controlPlane] = await Promise.all([
    readFile(new URL('../apps/api/src/modules/projects/projects.controller.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/modules/services/services.controller.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/modules/resources/resources.controller.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/modules/deployments/deployments.controller.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8'),
  ]);
  for (const source of [projectController, serviceController, resourceController, deploymentController]) assert.match(source, /@Query\(\) query/);
  for (const key of ['projects', 'services', 'resources', 'deployments']) assert.match(controlPlane, new RegExp(`keysetPage\\('${key}'`));
  assert.match(deploymentController, /startBoundedSseStream/);
  assert.match(deploymentController, /logCursor/);
  assert.match(deploymentController, /eventCursor/);
  assert.doesNotMatch(deploymentController, /send\(await load\(\)\)/);
});

test('production quota and dashboard paths avoid invalid fields and whole-database snapshots', async () => {
  const persistence = await readFile(new URL('../packages/core/src/persistence.ts', import.meta.url), 'utf8');
  const quotaStart = persistence.indexOf('async function prismaQuotaUsage');
  assert.notEqual(quotaStart, -1);
  const quotaBlock = persistence.slice(quotaStart, persistence.indexOf('async function applyPrismaGitHubCatalogWebhook', quotaStart));
  assert.doesNotMatch(quotaBlock, /startedAt:\s*true/);
  assert.match(quotaBlock, /recordedAt:\s*\{\s*gte:/);
  assert.match(quotaBlock, /deploymentBuildMinutesWithin/);

  const service = await readFile(new URL('../apps/api/src/raibitserver.service.ts', import.meta.url), 'utf8');
  const listProjectsBlock = service.slice(service.indexOf('async listProjects'), service.indexOf('async getProject'));
  assert.match(listProjectsBlock, /listProjectsForOrganizations/);
  const currentUserBlock = service.slice(service.indexOf('async currentUser'), service.indexOf('async approveUser'));
  assert.match(currentUserBlock, /findUserById/);
  assert.match(service, /async adminOverview/);
  const dashboardApi = await readFile(new URL('../apps/dashboard/lib/api.ts', import.meta.url), 'utf8');
  const projectConsole = dashboardApi.slice(dashboardApi.indexOf('export async function loadProjectConsole'), dashboardApi.indexOf('export async function loadResourceConsole'));
  assert.match(projectConsole, /\/overview/);
  assert.doesNotMatch(projectConsole, /Promise\.all\(services\.map/);
});

class FakeResponse extends EventEmitter {
  constructor({ backpressureAt = Number.POSITIVE_INFINITY, throwAt = Number.POSITIVE_INFINITY } = {}) {
    super();
    this.backpressureAt = backpressureAt;
    this.throwAt = throwAt;
    this.chunks = [];
    this.headers = {};
    this.ended = false;
    this.statusCode = 0;
  }

  status(code) { this.statusCode = code; return this; }
  setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; }
  flushHeaders() {}
  write(chunk) {
    if (this.chunks.length + 1 === this.throwAt) throw new Error('socket write failed');
    this.chunks.push(String(chunk));
    return this.chunks.length < this.backpressureAt;
  }
  end() { this.ended = true; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

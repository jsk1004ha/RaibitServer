import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scope = ['--organization-id', 'org_1', '--project-id', 'project_1'];
const deploymentScope = [...scope, '--service-id', 'service_1', '--deployment-id', 'deployment_1'];
const backup = {
  id: 'backup_1', organizationId: 'org_1', projectId: 'project_1', resourceId: 'resource_1', engine: 'postgresql',
  status: 'READY', createdAt: '2026-09-06T00:00:00.000Z', readyAt: '2026-09-06T00:00:01.000Z', errorCode: null,
  size: '42', expiresAt: '2026-10-06T00:00:00.000Z', recoverable: true,
};
const restore = {
  id: 'restore_1', organizationId: 'org_1', projectId: 'project_1', backupId: 'backup_1', sourceResourceId: 'resource_1',
  targetResourceId: 'resource_2', engine: 'postgresql', status: 'READY', createdAt: '2026-09-06T00:00:00.000Z',
  readyAt: '2026-09-06T00:00:02.000Z', errorCode: null,
};

test('CLI accepted lifecycle happy path', async (t) => {
  // Given a real HTTP fixture exposing the accepted typed routes.
  const requests = [];
  const fixture = await startFixture((req, body, res) => {
    requests.push({ method: req.method, url: req.url, body, lastEventId: req.headers['last-event-id'] });
    if (req.url?.endsWith('/stream') && req.headers.accept === 'text/event-stream') {
      const serviceStream = req.url.startsWith('/services/');
      const payload = serviceStream
        ? { service: null, logs: [{ id: 'runtime_1', line: 'ready', timestamp: '2026-09-06T00:00:00.000Z' }], serviceCursor: 'service-cursor', logCursor: 'log-cursor', stream: streamConfig() }
        : { deployment: null, logs: [{ id: 'log_1', line: 'built', timestamp: '2026-09-06T00:00:00.000Z' }], events: [{ id: 'event_1', timestamp: '2026-09-06T00:00:00.000Z' }], deploymentCursor: 'deployment-cursor', logCursor: 'log-cursor', eventCursor: 'event-cursor', stream: streamConfig() };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`id: resume-next\nevent: ${serviceStream ? 'service.logs.snapshot' : 'deployment.snapshot'}\ndata: ${JSON.stringify(payload)}\n\n`);
      return;
    }
    const response = responseFor(req.url ?? '');
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  t.after(() => fixture.close());

  // When every accepted lifecycle command is driven through the spawned CLI.
  const commands = [
    ['deploy', 'retry', ...deploymentScope, '--idempotency-key', 'retry-key', '--json'],
    ['services', 'redeploy', ...scope, '--service-id', 'service_1', '--idempotency-key', 'redeploy-key', '--json'],
    ['deployments', 'logs', ...deploymentScope, '--cursor', 'log-page', '--json'],
    ['deployments', 'events', ...deploymentScope, '--cursor', 'event-page', '--json'],
    ['services', 'logs', ...scope, '--service-id', 'service_1', '--cursor', 'runtime-page', '--json'],
    ['resources', 'attach', ...scope, '--resource-id', 'resource_1', '--service-id', 'service_1', '--env-prefix', 'DATABASE', '--json'],
    ['resources', 'backup', 'create', ...scope, '--resource-id', 'resource_1', '--idempotency-key', 'backup-key', '--json'],
    ['resources', 'backup', 'list', ...scope, '--resource-id', 'resource_1', '--cursor', 'backup-page', '--limit', '50'],
    ['resources', 'backup', 'delete', ...scope, '--resource-id', 'resource_1', '--backup-id', 'backup_1', '--confirm', '--json'],
    ['resources', 'restore', 'create', ...scope, '--resource-id', 'resource_1', '--backup-id', 'backup_1', '--name', 'restored-db', '--idempotency-key', 'restore-key', '--json'],
    ['resources', 'restore', 'get', ...scope, '--resource-id', 'resource_1', '--backup-id', 'backup_1', '--restore-id', 'restore_1', '--json'],
  ];
  const outputs = [];
  for (const command of commands) {
    const result = await runCli(fixture.url, command);
    assert.equal(result.code, 0, `${command.join(' ')}\n${result.stderr}`);
    if (command.includes('--json')) assert.doesNotThrow(() => JSON.parse(result.stdout));
    else assert.match(result.stdout, /engine\t/);
    outputs.push(result.stdout);
  }
  const followed = [];
  for (const command of [
    ['deployments', 'logs', ...deploymentScope, '--follow', '--cursor', 'deployment-resume', '--json'],
    ['deployments', 'events', ...deploymentScope, '--follow', '--cursor', 'event-resume', '--json'],
    ['services', 'logs', ...scope, '--service-id', 'service_1', '--follow', '--cursor', 'service-resume', '--json'],
  ]) followed.push(await runFollowingCli(fixture.url, command));
  for (const result of followed) assert.equal(JSON.parse(result.stdout).nextCursor, 'resume-next');
  assert.doesNotMatch(outputs.join(''), /postgres:\/\/|private-key|artifactKey|connectionUrl/i);

  // Then every method, path, cursor, and body matches the actual API contract.
  assert.deepEqual(requests.map(({ method, url, body }) => ({ method, url, body })).slice(0, 11), [
    { method: 'POST', url: '/deployments/deployment_1/retry', body: { requestIdempotencyKey: 'retry-key', snapshotVersion: 1 } },
    { method: 'POST', url: '/services/service_1/redeploy', body: { requestIdempotencyKey: 'redeploy-key', snapshotVersion: 1 } },
    { method: 'GET', url: '/deployments/deployment_1/logs?cursor=log-page', body: null },
    { method: 'GET', url: '/deployments/deployment_1/events?cursor=event-page', body: null },
    { method: 'GET', url: '/services/service_1/logs?cursor=runtime-page', body: null },
    { method: 'POST', url: '/resources/resource_1/attach', body: { serviceId: 'service_1', envPrefix: 'DATABASE' } },
    { method: 'POST', url: '/resources/resource_1/backups', body: { requestIdempotencyKey: 'backup-key', formatVersion: 1 } },
    { method: 'GET', url: '/resources/resource_1/backups?limit=50&cursor=backup-page', body: null },
    { method: 'DELETE', url: '/backups/backup_1', body: { confirmed: true } },
    { method: 'POST', url: '/backups/backup_1/restores', body: { requestIdempotencyKey: 'restore-key', formatVersion: 1, name: 'restored-db' } },
    { method: 'GET', url: '/restores/restore_1', body: null },
  ]);
  assert.deepEqual(requests.slice(11).map(({ url, lastEventId }) => ({ url, lastEventId })), [
    { url: '/deployments/deployment_1/stream', lastEventId: 'deployment-resume' },
    { url: '/deployments/deployment_1/stream', lastEventId: 'event-resume' },
    { url: '/services/service_1/logs/stream', lastEventId: 'service-resume' },
  ]);
});

test('CLI lifecycle adversarial matrix', async (t) => {
  // Given typed API failures, a secret-bearing error, and a stream that never emits.
  const openResponses = new Set();
  let streamOpened;
  const streamStarted = new Promise((resolve) => { streamOpened = resolve; });
  let requestCount = 0;
  const fixture = await startFixture((req, _body, res) => {
    requestCount += 1;
    if (req.url?.endsWith('/stream')) {
      if (req.url.includes('/eof/')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end();
        return;
      }
      openResponses.add(res);
      res.on('close', () => openResponses.delete(res));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streamOpened();
      return;
    }
    if (req.url === '/deployments/foreign/retry') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...deploymentOperation(), deployment: { ...deploymentOperation().deployment, projectId: 'project_foreign' } }));
      return;
    }
    const statuses = { '/deployments/auth/retry': 403, '/deployments/conflict/retry': 409, '/deployments/unavailable/retry': 503 };
    const status = statuses[req.url] ?? 500;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode: status, message: 'DATABASE_URL=postgres://user:pass@db/app artifactKey=private-key', code: status === 503 ? 'NOT_RUN' : 'FAILED' }));
  });
  t.after(() => fixture.close());

  // When invalid, unauthorized, conflicting, unavailable, secret, EOF, and SIGINT cases run.
  const missingScope = await runCli(fixture.url, ['deploy', 'retry', '--deployment-id', 'deployment_1', '--idempotency-key', 'key', '--json']);
  const missingConfirmation = await runCli(fixture.url, ['resources', 'backup', 'delete', ...scope, '--resource-id', 'resource_1', '--backup-id', 'backup_1', '--json']);
  const invalidKey = await runCli(fixture.url, ['deploy', 'retry', ...deploymentScope, '--idempotency-key', 'key with spaces', '--json']);
  const invalidCursor = await runCli(fixture.url, ['resources', 'backup', 'list', ...scope, '--resource-id', 'resource_1', '--cursor', 'x'.repeat(1025), '--json']);
  assert.equal(requestCount, 0);
  const codes = [];
  for (const deploymentId of ['auth', 'conflict', 'unavailable', 'secret', 'foreign']) {
    const result = await runCli(fixture.url, ['deploy', 'retry', ...scope, '--service-id', 'service_1', '--deployment-id', deploymentId, '--idempotency-key', 'key', '--json']);
    codes.push(result.code);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgres:\/\/|private-key|artifactKey/i);
  }
  const eof = await runCli(fixture.url, ['deployments', 'logs', ...scope, '--service-id', 'service_1', '--deployment-id', 'eof', '--follow', '--json']);
  const interrupted = await runFollowingCli(fixture.url, ['services', 'logs', ...scope, '--service-id', 'service_1', '--follow', '--json'], false, streamStarted);

  // Then exit codes are exact, no invalid command reaches HTTP, and SIGINT closes the stream.
  assert.equal(missingScope.code, 2);
  assert.equal(missingConfirmation.code, 2);
  assert.equal(invalidKey.code, 2);
  assert.equal(invalidCursor.code, 2);
  assert.deepEqual(codes, [3, 4, 5, 1, 3]);
  assert.equal(eof.code, 1);
  assert.equal(interrupted.code === 0 || interrupted.signal === 'SIGINT', true);
  assert.equal(openResponses.size, 0);
});

function responseFor(url) {
  if (url.includes('/retry') || url.includes('/redeploy')) return { status: 202, body: deploymentOperation() };
  if (url.includes('/logs')) return { status: 200, body: { logs: [{ id: 'log_1', line: 'safe', timestamp: '2026-09-06T00:00:00.000Z' }], nextCursor: null } };
  if (url.includes('/events')) return { status: 200, body: { events: [{ id: 'event_1', timestamp: '2026-09-06T00:00:00.000Z' }], nextCursor: null } };
  if (url.endsWith('/attach')) return { status: 201, body: { operationId: 'attach_1', status: 'ATTACHED', resourceId: 'resource_1', serviceId: 'service_1' } };
  if (url.startsWith('/backups/') && url.endsWith('/restores')) return { status: 202, body: restore };
  if (url.includes('/backups?')) return { status: 200, body: { backups: [backup], nextCursor: null } };
  if (url.includes('/backups')) return { status: 202, body: backup };
  if (url.startsWith('/backups/')) return { status: 200, body: backup };
  if (url.startsWith('/restores/')) return { status: 200, body: restore };
  return { status: 404, body: { statusCode: 404, message: 'not found' } };
}

function deploymentOperation() {
  return {
    operationId: 'operation_1', status: 'QUEUED', streamHref: '/deployments/deployment_1/stream',
    deployment: { id: 'deployment_2', serviceId: 'service_1', projectId: 'project_1', status: 'queued', artifactKey: 'private-key', connectionUrl: 'postgres://user:pass@db/app' },
    workflowJob: { id: 'job_1', targetId: 'deployment_2', targetType: 'deployment', type: 'retry', status: 'QUEUED', payload: {} },
  };
}

function streamConfig() {
  return { retryMs: 10, heartbeatMs: 100, maxLifetimeMs: 1000, slowClientTimeoutMs: 100 };
}

async function startFixture(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    handler(req, text ? JSON.parse(text) : null, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

function runCli(baseUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/cli/src/index.ts', ...args], {
      cwd: root,
      env: { ...process.env, RAIBITSERVER_API_URL: baseUrl, RAIBITSERVER_TOKEN: 'fixture-token', NO_COLOR: '1' },
    });
    collect(child, resolve, reject);
  });
}

async function runFollowingCli(baseUrl, args, waitForOutput = true, ready) {
  const child = spawn(process.execPath, ['apps/cli/src/index.ts', ...args], {
    cwd: root,
    env: { ...process.env, RAIBITSERVER_API_URL: baseUrl, RAIBITSERVER_TOKEN: 'fixture-token', NO_COLOR: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (waitForOutput) await once(child.stdout, 'data');
  else await ready;
  child.kill('SIGINT');
  const [code, signal] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

function collect(child, resolve, reject) {
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
}

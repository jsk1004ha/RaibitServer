import { createServer } from 'node:http';
import {
  FIXED_TIME,
  PUBLIC_SITE_SCENARIOS,
  loginAccounts,
  resetCustomDomainFixture,
  resetOrganizationFixture,
  resetProjectSettingsFixture,
  resetResourceRecoveryFixture,
  resourceRecoveryFixtureSnapshot,
  responseFor,
} from './data.mjs';
import { redactFixtureRequestBody } from './redact.mjs';
import { createFixtureState } from './state.mjs';

const port = 3411;
const requests = [];
const fixtureState = createFixtureState();
const streamAttempts = new Map();

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/__fixture/ready') return send(response, 200, { ready: true, fixedTime: FIXED_TIME });
  if (url.pathname === '/__fixture/requests') return send(response, 200, { requests });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body = {};
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { body = { invalidJson: true }; }
  }
  if (url.pathname === '/__fixture/state' && request.method === 'GET') return send(response, 200, { ...fixtureState.snapshot(), resourceRestores: resourceRecoveryFixtureSnapshot() });
  if (url.pathname === '/__fixture/state' && request.method === 'POST') {
    const nextState = fixtureState.selectPublicSiteScenario(body?.publicSiteScenario);
    if (!nextState) return send(response, 400, { error: 'invalid_fixture_public_site_scenario', allowed: PUBLIC_SITE_SCENARIOS });
    return send(response, 200, nextState);
  }
  if (url.pathname === '/__fixture/reset' && request.method === 'POST') {
    resetProjectSettingsFixture();
    resetCustomDomainFixture();
    resetOrganizationFixture();
    resetResourceRecoveryFixture();
    return send(response, 200, { ...fixtureState.reset(), resourceRestores: resourceRecoveryFixtureSnapshot() });
  }
  const streamMatch = /^\/api\/services\/([^/]+)\/logs\/stream$/.exec(url.pathname);
  if (streamMatch && request.method === 'GET') return sendRuntimeLogStream(request, response, decodeURIComponent(streamMatch[1]));
  requests.push({ method: request.method, path: url.pathname, query: url.search, authorization: request.headers.authorization ? 'Bearer [MASKED]' : null, lastEventId: request.headers['last-event-id'] || null, body: redactFixtureRequestBody(body, url.pathname) });
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const account = loginAccounts.get(String(body.email || '').toLowerCase());
    if (body.email === 'failure@fixture.test') return send(response, 500, { error: 'fixture_upstream_secret_must_not_escape' });
    if (!account || account.password !== body.password) return send(response, 401, { error: 'invalid_credentials' });
    return send(response, 200, { sessionToken: account.token, user: { email: body.email } });
  }
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/, '');
  const result = responseFor({ body, publicSiteScenario: fixtureState.snapshot().publicSiteScenario, token, method: request.method || 'GET', pathname: url.pathname.replace(/^\/api/, '') || '/', searchParams: url.searchParams });
  return send(response, result.status, result.body);
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`fixture-control-plane:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

function sendRuntimeLogStream(request, response, serviceId) {
  const attempt = (streamAttempts.get(serviceId) || 0) + 1;
  streamAttempts.set(serviceId, attempt);
  const streamRequest = { method: request.method, path: new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname, query: '', authorization: request.headers.authorization ? 'Bearer [MASKED]' : null, lastEventId: request.headers['last-event-id'] || null, body: {}, streamClosed: false };
  requests.push(streamRequest);
  const logs = serviceId === 'svc_fixture_worker'
    ? [{ id: 'worker-initial', timestamp: FIXED_TIME, level: 'info', line: 'worker-only-initial-log' }, { id: 'worker-hostile', timestamp: FIXED_TIME, level: 'warn', line: '<img src=x onerror="fixture-hostile-log">' }, ...(attempt > 1 ? [{ id: 'worker-live', timestamp: '2026-08-31T03:00:01.000Z', level: 'info', line: 'worker-only-live-log' }] : [])]
    : [{ id: 'web-initial', timestamp: FIXED_TIME, level: 'info', line: 'web-only-initial-log' }];
  const payload = JSON.stringify({ logs });
  response.writeHead(200, { 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'content-type': 'text/event-stream; charset=utf-8' });
  response.write(`retry: 1000\nid: ${serviceId}-snapshot-${attempt}\nevent: service.logs.snapshot\ndata: ${payload}\n\n`);
  response.once('close', () => { streamRequest.streamClosed = true; });
  if (serviceId === 'svc_fixture_worker') {
    const delta = JSON.stringify({ logs: [{ id: 'worker-live', timestamp: '2026-08-31T03:00:01.000Z', level: 'info', line: 'worker-only-live-log' }] });
    setTimeout(() => {
      if (!response.writableEnded) response.write(`id: ${serviceId}-delta-${attempt}\nevent: service.logs.delta\ndata: ${delta}\n\n`);
    }, 50);
  }
}

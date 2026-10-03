import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
const templateCatalog = JSON.parse(readFileSync(new URL('../../../../../test-fixtures/contracts/starter-catalog-v1.json', import.meta.url), 'utf8'));
let templateState = { enabled: true, preflightConflict: false, installStatus: 'provisioning' };
const templateInstallations = new Map();
const templateRequestKeys = new Map();

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
  if (url.pathname === '/__fixture/templates' && request.method === 'POST') {
    templateState = { ...templateState, ...body };
    return send(response, 200, templateState);
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
    templateState = { enabled: true, preflightConflict: false, installStatus: 'provisioning' };
    templateInstallations.clear();
    templateRequestKeys.clear();
    return send(response, 200, { ...fixtureState.reset(), resourceRestores: resourceRecoveryFixtureSnapshot() });
  }
  const streamMatch = /^\/api\/services\/([^/]+)\/logs\/stream$/.exec(url.pathname);
  if (streamMatch && request.method === 'GET') return sendRuntimeLogStream(request, response, decodeURIComponent(streamMatch[1]));
  const recordedBody = url.pathname.includes('/template-installations') && body.inputs && typeof body.inputs === 'object'
    ? { ...body, inputs: Object.fromEntries(Object.keys(body.inputs).map((key) => [key, '[MASKED]'])) }
    : body;
  requests.push({ method: request.method, path: url.pathname, query: url.search, authorization: request.headers.authorization ? 'Bearer [MASKED]' : null, lastEventId: request.headers['last-event-id'] || null, body: redactFixtureRequestBody(recordedBody, url.pathname) });
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const account = loginAccounts.get(String(body.email || '').toLowerCase());
    if (body.email === 'failure@fixture.test') return send(response, 500, { error: 'fixture_upstream_secret_must_not_escape' });
    if (!account || account.password !== body.password) return send(response, 401, { error: 'invalid_credentials' });
    return send(response, 200, { sessionToken: account.token, user: { email: body.email } });
  }
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/, '');
  const templateResult = templateResponse(request.method, url, body, token);
  if (templateResult) return send(response, templateResult.status, templateResult.body);
  const result = responseFor({ body, publicSiteScenario: fixtureState.snapshot().publicSiteScenario, token, method: request.method || 'GET', pathname: url.pathname.replace(/^\/api/, '') || '/', searchParams: url.searchParams });
  return send(response, result.status, result.body);
});

function templateResponse(method, url, body, token) {
  const pathname = url.pathname.replace(/^\/api/, '');
  const projectId = 'prj_fixture_001';
  const installationsPath = `/projects/${projectId}/template-installations`;
  if (pathname !== '/templates' && pathname !== `/projects/${projectId}/environments` && !pathname.startsWith(installationsPath) && !pathname.startsWith('/template-installations/')) return null;
  const json = (status, body) => ({ status, body });
  const error = (status, code) => json(status, { statusCode: status, message: code, code });
  const environmentKind = url.searchParams.get('environmentId') === 'env_fixture_dev' || url.searchParams.get('environmentKind') === 'dev' ? 'dev' : 'prod';
  const environmentId = `env_fixture_${environmentKind}`;
  if (!token || token === 'fixture-expired') return json(401, { error: 'session_expired' });
  if (pathname === '/templates' && method === 'GET') return json(200, {
    catalogDigest: templateCatalog.catalogDigest,
    availability: { enabled: templateState.enabled, reasonCode: templateState.enabled ? null : 'TEMPLATE_UNAVAILABLE' },
    starters: templateCatalog.starters,
  });
  if (pathname === `/projects/${projectId}/environments` && method === 'GET') return json(200, {
    environments: ['prod', 'dev'].map((kind) => ({ id: `env_fixture_${kind}`, projectId, kind, status: 'active', version: 1, createdAt: FIXED_TIME, updatedAt: FIXED_TIME })),
  });
  if (pathname === installationsPath && method === 'GET') return json(200, { installations: [...templateInstallations.values()].filter((row) => row.installation.environmentId === environmentId) });
  const retryId = /^\/template-installations\/([^/]+)\/retry$/.exec(pathname)?.[1];
  if (retryId && method === 'POST') {
    const current = templateInstallations.get(retryId);
    if (!current || current.installation.environmentId !== environmentId) return error(404, 'TEMPLATE_NOT_FOUND');
    if (body.requiredProtocolVersion !== 2 || body.expectedVersion !== current.installation.version || typeof body.requestIdempotencyKey !== 'string') return error(409, 'TEMPLATE_VERSION_CONFLICT');
    const result = { ...current, progress: { ...current.progress, status: 'building', completed: current.resources.length } };
    templateInstallations.set(retryId, result);
    return json(202, result);
  }
  if (method !== 'POST') return error(404, 'TEMPLATE_NOT_FOUND');
  if (!templateState.enabled) return error(409, 'TEMPLATE_UNAVAILABLE');
  const starter = templateCatalog.starters.find((entry) => entry.id === body.catalogId && entry.version === body.catalogVersion);
  if (!starter || body.requiredProtocolVersion !== 2 || body.catalogDigest !== templateCatalog.catalogDigest || body.sourceDigest !== starter.source.digest || typeof body.requestIdempotencyKey !== 'string') return error(400, 'TEMPLATE_INPUT_INVALID');
  if (starter.inputs.some((input) => input.required && !body.inputs?.[input.key])) return error(400, 'TEMPLATE_INPUT_INVALID');
  const preview = { projectId, environmentId, environmentKind, catalogId: starter.id, catalogVersion: starter.version, services: starter.graph.services.map(({ logicalSlug, type }) => ({ logicalSlug, type })), resources: starter.graph.resources };
  if (pathname === `${installationsPath}/preflight`) return templateState.preflightConflict
    ? error(409, 'TEMPLATE_SLUG_CONFLICT')
    : json(200, preview);
  if (pathname !== installationsPath) return error(404, 'TEMPLATE_NOT_FOUND');
  if (templateRequestKeys.has(body.requestIdempotencyKey)) return json(202, templateInstallations.get(templateRequestKeys.get(body.requestIdempotencyKey)));
  const id = `tpl_fixture_${templateInstallations.size + 1}`;
  const result = {
    installation: { id, projectId, environmentId, environmentKind, version: 1, catalogId: starter.id, catalogVersion: starter.version },
    progress: { status: templateState.installStatus, completed: 0, total: preview.services.length + preview.resources.length },
    services: preview.services.map((service) => ({ ...service, id: service.type === 'worker' ? 'svc_fixture_worker' : 'svc_fixture_web', deploymentId: 'dep_fixture_failed' })),
    resources: preview.resources.map((resource) => ({ ...resource, id: 'res_fixture_pg' })),
  };
  templateInstallations.set(id, result);
  templateRequestKeys.set(body.requestIdempotencyKey, id);
  return json(202, result);
}

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

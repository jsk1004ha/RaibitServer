import { createServer } from 'node:http';
import {
  FIXED_TIME,
  PUBLIC_SITE_SCENARIOS,
  loginAccounts,
  responseFor,
} from './data.mjs';
import { redactFixtureRequestBody } from './redact.mjs';
import { createFixtureState } from './state.mjs';

const port = 3411;
const requests = [];
const fixtureState = createFixtureState();

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
  if (url.pathname === '/__fixture/state' && request.method === 'GET') return send(response, 200, fixtureState.snapshot());
  if (url.pathname === '/__fixture/state' && request.method === 'POST') {
    const nextState = fixtureState.selectPublicSiteScenario(body?.publicSiteScenario);
    if (!nextState) return send(response, 400, { error: 'invalid_fixture_public_site_scenario', allowed: PUBLIC_SITE_SCENARIOS });
    return send(response, 200, nextState);
  }
  if (url.pathname === '/__fixture/reset' && request.method === 'POST') {
    return send(response, 200, fixtureState.reset());
  }
  requests.push({ method: request.method, path: url.pathname, query: url.search, authorization: request.headers.authorization ? 'Bearer [MASKED]' : null, body: redactFixtureRequestBody(body, url.pathname) });
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

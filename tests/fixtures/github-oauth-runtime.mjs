import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { bootParityApi } from './api-parity-runtime.mjs';
import { createApiHandler } from '../../packages/core/src/api.ts';
import { RAIBITSERVERControlPlane } from '../../packages/core/src/control-plane.ts';

export const OAUTH_CALLBACK = 'https://console.localhost/api/control/auth/github/callback';
export const OAUTH_AVATAR = 'https://avatars.githubusercontent.com/u/4242?v=4';

export function verifierPair() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  return { codeVerifier, codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url') };
}

export async function bootOAuthRuntime(options = {}) {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const credentials = { clientId: 'oauth-fixture', clientSecret: crypto.randomBytes(32).toString('hex'), token: crypto.randomBytes(32).toString('hex') };
  const counters = { token: 0, profile: 0, emails: 0, pkce: 0, apiStart: 0, apiCallback: 0, consumedBeforeExchange: 0 };
  const stores = [];
  const codes = new Map();
  const secrets = new Set(Object.values(credentials));
  let active = {};
  const provider = http.createServer(async (req, res) => {
    if (req.url === '/login/oauth/access_token') {
      counters.token += 1;
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = new URLSearchParams(body);
      active = codes.get(input.get('code')) || {};
      if (stores.some((store) => [...store.oauthTransactions.values()].some((row) => row.codeChallenge === active.challenge && row.consumedAt !== null))) counters.consumedBeforeExchange += 1;
      if (active.stall) return;
      if (active.malformed) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{'); }
      if (active.missingToken) return json(res, 200, {});
      if (active.failure) return json(res, 502, { error: credentials.token });
      if (active.challenge && crypto.createHash('sha256').update(input.get('code_verifier') || '').digest('base64url') !== active.challenge) return json(res, 400, {});
      if (input.get('redirect_uri') !== (options.redirectUri || OAUTH_CALLBACK)) return json(res, 400, {});
      if (input.has('code_verifier')) counters.pkce += 1;
      if (input.get('client_secret') !== credentials.clientSecret) return json(res, 401, {});
      return json(res, 200, { access_token: credentials.token });
    }
    if (req.url === '/user') {
      counters.profile += 1;
      return json(res, 200, { id: active.githubId || 4242, login: 'oauth-member', name: active.name || 'Provider Name', avatar_url: active.avatar || OAUTH_AVATAR });
    }
    if (req.url === '/user/emails') {
      counters.emails += 1;
      return json(res, 200, [{ email: active.email || 'oauth-member@example.test', primary: true, verified: active.verified !== false }]);
    }
    json(res, 404, {});
  });
  await listen(provider);
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const target = url === 'https://github.com/login/oauth/access_token' ? '/login/oauth/access_token'
      : url === 'https://api.github.com/user' ? '/user' : url === 'https://api.github.com/user/emails' ? '/user/emails' : null;
    return originalFetch(target ? `${address(provider)}${target}` : input, init);
  };
  process.env.GITHUB_CLIENT_ID = credentials.clientId;
  process.env.GITHUB_CLIENT_SECRET = credentials.clientSecret;
  process.env.RAIBITSERVER_GITHUB_REDIRECT_URI = options.redirectUri || OAUTH_CALLBACK;
  delete process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET;
  delete process.env.RAIBITSERVER_TRUST_PROXY_HEADERS;
  delete process.env.RAIBITSERVER_AUTH_RATE_LIMIT_TRUST_PROXY;
  for (const key of ['RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT', 'RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT', 'RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT', 'RAIBITSERVER_AUTH_GLOBAL_RATE_LIMIT', 'RAIBITSERVER_AUTH_RATE_WINDOW_MS']) delete process.env[key];
  if (options.transactionBudgets === true) {
    process.env.RAIBITSERVER_AUTH_SOURCE_RATE_LIMIT = '1000';
    process.env.RAIBITSERVER_AUTH_FLOW_SOURCE_RATE_LIMIT = '2000';
    process.env.RAIBITSERVER_AUTH_EMAIL_RATE_LIMIT = '1000';
  }
  const nest = await bootParityApi();
  nest.app.getHttpServer().on('request', (req) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/auth/github/login') counters.apiStart += 1;
    if (pathname === '/auth/github/callback') counters.apiCallback += 1;
  });
  const jwtSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  secrets.add(jwtSecret);
  const plane = new RAIBITSERVERControlPlane();
  const core = http.createServer(createApiHandler(plane, { auth: { mode: 'jwt', jwtSecret }, githubOAuth: {
    clientId: credentials.clientId, clientSecret: credentials.clientSecret, redirectUri: process.env.RAIBITSERVER_GITHUB_REDIRECT_URI,
  } }));
  await listen(core);
  for (const store of [nest.repository.store, plane.store]) {
    stores.push(store);
    const organization = store.createOrganization({ name: 'OAuth Fixture', slug: 'oauth-fixture' });
    const user = store.createUser({ name: 'Approved Name', email: 'oauth-member@example.test', approvalStatus: 'APPROVED', emailVerifiedAt: new Date().toISOString() });
    store.addMember({ organizationId: organization.id, userId: user.id, role: 'developer' });
  }
  return {
    nest, plane, counters, secrets, ownedPorts: [nest.app.getHttpServer().address().port, core.address().port, provider.address().port],
    surfaces: [{ name: 'nest', baseUrl: nest.baseUrl, store: nest.repository.store }, { name: 'core', baseUrl: address(core), store: plane.store }],
    issueCode(profile = {}) { const code = crypto.randomBytes(24).toString('base64url'); codes.set(code, profile); secrets.add(code); return code; },
    async close() {
      await Promise.all([close(core), close(provider)]);
      await nest.app.close();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    },
  };
}

export async function oauthRequest(baseUrl, pathname, input = {}, token) {
  const response = await fetch(`${baseUrl}${pathname}?${new URLSearchParams(input)}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'manual' });
  return { status: response.status, body: await response.json() };
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
function address(server) { return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

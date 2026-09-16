import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { bootOAuthRuntime } from '../../../tests/fixtures/github-oauth-runtime.mjs';

const routeUrl = new URL('../app/api/control/[...path]/route.ts', import.meta.url);
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && decodeURI(context.parentURL) === decodeURI(routeUrl.href) && specifier === '../../../../lib/api') {
      return { url: 'data:text/javascript,export async function dashboardApiContext(){return {baseUrl:process.env.RAIBIT_TEST_OAUTH_API_URL,headers:{}}}', shortCircuit: true };
    }
    if (specifier === 'next/server') return next('next/server.js', context);
    if (specifier === '../../../../lib/github-oauth-relay') return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (decodeURI(url) === decodeURI(routeUrl.href)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(routeUrl, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return next(url, context);
  },
});
const { GET } = await import(routeUrl.href);
const origin = 'https://console.localhost';
const loginPath = '/api/control/auth/github/login';
const callbackPath = '/api/control/auth/github/callback';
const browserCookie = '__Host-raibitserver_github_oauth_browser';
const stateCookie = '__Host-raibitserver_github_oauth_state';
const verifierCookie = '__Host-raibitserver_github_oauth_verifier';
const relayHeader = 'x-raibitserver-oauth-relay';
const routeContext = (operation) => ({ params: Promise.resolve({ path: ['auth', 'github', operation] }) });

function request(path, cookies = [], headers = {}) {
  return new NextRequest(`${origin}${path}`, { headers: { ...headers, cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') } });
}
async function fixture(t) {
  const previous = { ...process.env };
  const runtime = await bootOAuthRuntime();
  t.after(async () => {
    await runtime.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.RAIBIT_TEST_OAUTH_API_URL = runtime.nest.baseUrl;
  return runtime;
}

test('OAuth BFF issues one stable host-bound browser identity and isolates a second browser after the first is limited', async (t) => {
  // Given: actual Next route and Nest HTTP API, sharing one socket peer.
  await fixture(t);
  const first = await GET(request(loginPath), routeContext('login'));
  assert.equal(first.status, 302);
  const identity = first.cookies.get(browserCookie);
  assert.ok(identity, 'dashboard must issue a signed stable browser identity');
  assert.equal(identity.path, '/');
  assert.equal(identity.secure, true);
  assert.equal(identity.httpOnly, true);
  assert.equal(identity.domain, undefined);
  // When: A exhausts its own starts, while B has no prior transaction.
  for (let count = 1; count < 30; count++) {
    const next = await GET(request(loginPath, [identity]), routeContext('login'));
    assert.equal(new URL(next.headers.get('location')).hostname, 'github.com');
    assert.equal(next.cookies.get(browserCookie)?.value, identity.value);
  }
  const limited = await GET(request(loginPath, [identity]), routeContext('login'));
  const other = await GET(request(loginPath), routeContext('login'));
  // Then: A keeps its identity on errors; only A is denied.
  assert.equal(new URL(limited.headers.get('location')).searchParams.get('error'), 'rate_limit_exceeded');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(limited.cookies.get(browserCookie)?.value, identity.value);
  assert.equal(new URL(other.headers.get('location')).hostname, 'github.com');
  assert.notEqual(other.cookies.get(browserCookie)?.value, identity.value);
});

test('OAuth BFF refuses browser-supplied relay headers and duplicate browser cookies before contacting API', async (t) => {
  const runtime = await fixture(t);
  for (const incoming of [request(loginPath, [], { [relayHeader]: 'forged' }), request(loginPath, [
    { name: browserCookie, value: 'one' }, { name: browserCookie, value: 'two' },
  ])]) {
    const before = runtime.counters.apiStart;
    const response = await GET(incoming, routeContext('login'));
    assert.equal(new URL(response.headers.get('location')).pathname, '/login');
    assert.equal(runtime.counters.apiStart, before);
  }
});

test('OAuth BFF accepts a legitimate callback but rejects copied and legacy transaction cookies', async (t) => {
  const runtime = await fixture(t);
  const start = await GET(request(loginPath), routeContext('login'));
  const cookies = start.cookies.getAll();
  const state = start.cookies.get(stateCookie)?.value;
  const challenge = new URL(start.headers.get('location')).searchParams.get('code_challenge');
  const code = runtime.issueCode({ challenge });
  const callback = `${callbackPath}?${new URLSearchParams({ state, code })}`;
  const legacy = cookies.filter(({ name }) => name !== browserCookie).map(({ name, value }) => ({ name: name.replace('__Host-', ''), value }));
  const before = runtime.counters.apiCallback;
  assert.equal(new URL((await GET(request(callback, legacy), routeContext('callback'))).headers.get('location')).pathname, '/login');
  assert.equal(runtime.counters.apiCallback, before);
  const other = await GET(request(loginPath), routeContext('login'));
  const copied = [...cookies.filter(({ name }) => name !== browserCookie), ...other.cookies.getAll().filter(({ name }) => name === browserCookie)];
  assert.equal(new URL((await GET(request(callback, copied), routeContext('callback'))).headers.get('location')).pathname, '/login');
  const complete = await GET(request(callback, cookies), routeContext('callback'));
  assert.equal(new URL(complete.headers.get('location')).pathname, '/console');
  assert.ok(complete.cookies.get('__Host-raibitserver_session')?.value);
  assert.equal(complete.cookies.get('raibitserver_session')?.maxAge, 0);
  for (const name of [stateCookie, verifierCookie]) assert.equal(complete.cookies.get(name)?.maxAge, 0);
  assert.notEqual(complete.cookies.get(browserCookie)?.maxAge, 0);
});

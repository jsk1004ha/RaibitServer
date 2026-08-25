import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { registerHooks } from 'node:module';
import test from 'node:test';

const dashboardRequire = createRequire(new URL('../apps/dashboard/package.json', import.meta.url));
const { NextRequest } = dashboardRequire('next/server');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') {
      return { shortCircuit: true, url: new URL('../apps/dashboard/node_modules/next/server.js', import.meta.url).href };
    }
    return nextResolve(specifier, context);
  },
});
const { proxy } = await import('../apps/dashboard/proxy.ts');

test('console host requires a session at its root and keeps the public host landing open', { concurrency: false }, () => {
  const originalBasicAuth = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  const originalDashboardOrigin = process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  const originalConsoleUrl = process.env.RAIBITSERVER_CONSOLE_URL;
  delete process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  delete process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  process.env.RAIBITSERVER_CONSOLE_URL = 'https://console.raibit.kr/console';
  try {
    const anonymousConsole = proxy(new NextRequest('https://console.raibit.kr/'));
    assert.equal(anonymousConsole.status, 307);
    assert.equal(anonymousConsole.headers.get('location'), 'https://console.raibit.kr/login?next=%2Fconsole');
    assert.match(anonymousConsole.headers.get('content-security-policy') || '', /default-src 'self'/);

    const authenticatedConsole = proxy(new NextRequest('https://console.raibit.kr/', {
      headers: { cookie: 'raibitserver_session=signed-session' },
    }));
    assert.equal(authenticatedConsole.status, 307);
    assert.equal(authenticatedConsole.headers.get('location'), 'https://console.raibit.kr/console');

    const publicLanding = proxy(new NextRequest('https://raibit.kr/'));
    assert.equal(publicLanding.status, 200);
    assert.equal(publicLanding.headers.get('x-middleware-next'), '1');
  } finally {
    restoreEnvironment('RAIBITSERVER_DASHBOARD_BASIC_AUTH', originalBasicAuth);
    restoreEnvironment('RAIBITSERVER_DASHBOARD_ORIGIN', originalDashboardOrigin);
    restoreEnvironment('RAIBITSERVER_CONSOLE_URL', originalConsoleUrl);
  }
});

test('console host protects non-login pages without trusting lookalike hosts', { concurrency: false }, () => {
  const originalBasicAuth = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  const originalDashboardOrigin = process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  delete process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  delete process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  try {
    const support = proxy(new NextRequest('https://console.raibit.kr/support'));
    assert.equal(support.status, 307);
    assert.equal(support.headers.get('location'), 'https://console.raibit.kr/login?next=%2Fsupport');

    const login = proxy(new NextRequest('https://console.raibit.kr/login'));
    assert.equal(login.status, 200);

    const lookalike = proxy(new NextRequest('https://console.raibit.kr.attacker.example/'));
    assert.equal(lookalike.status, 200);
  } finally {
    restoreEnvironment('RAIBITSERVER_DASHBOARD_BASIC_AUTH', originalBasicAuth);
    restoreEnvironment('RAIBITSERVER_DASHBOARD_ORIGIN', originalDashboardOrigin);
  }
});

test('flat console and resource hosts require their own host session on trusted base domains', { concurrency: false }, () => {
  const originalBasicAuth = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  const originalDashboardOrigin = process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  const originalBaseDomain = process.env.RAIBITSERVER_BASE_DOMAIN;
  delete process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  delete process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  process.env.RAIBITSERVER_BASE_DOMAIN = 'raibit.kr';
  try {
    for (const host of [
      'console--org--project.raibit.kr',
      'resources--org--project--postgres.raibit.kr',
      'console--org--project.raibitserver.app',
      'resources--org--project--postgres.raibitserver.app',
    ]) {
      const anonymous = proxy(new NextRequest(`https://${host}/activity`));
      assert.equal(anonymous.status, 307, host);
      assert.equal(anonymous.headers.get('location'), `https://${host}/login?next=%2Factivity`);

      const authenticated = proxy(new NextRequest(`https://${host}/activity`, {
        headers: { cookie: 'raibitserver_session=signed-session' },
      }));
      assert.equal(authenticated.status, 200, host);
    }

    for (const host of [
      'console--org--project.raibit.kr.attacker.example',
      'resources--org--project--postgres.raibitserver.app.attacker.example',
    ]) {
      assert.equal(proxy(new NextRequest(`https://${host}/activity`)).status, 200, host);
    }
  } finally {
    restoreEnvironment('RAIBITSERVER_DASHBOARD_BASIC_AUTH', originalBasicAuth);
    restoreEnvironment('RAIBITSERVER_DASHBOARD_ORIGIN', originalDashboardOrigin);
    restoreEnvironment('RAIBITSERVER_BASE_DOMAIN', originalBaseDomain);
  }
});

test('public apex sends login and protected navigation to the configured console host', { concurrency: false }, () => {
  const originalBasicAuth = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  const originalDashboardOrigin = process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  const originalConsoleUrl = process.env.RAIBITSERVER_CONSOLE_URL;
  delete process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  delete process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  process.env.RAIBITSERVER_CONSOLE_URL = 'https://console.raibit.kr/console';
  try {
    const signup = proxy(new NextRequest('https://raibit.kr/login?mode=signup'));
    assert.equal(signup.status, 307);
    assert.equal(signup.headers.get('location'), 'https://console.raibit.kr/login?mode=signup');

    const consolePage = proxy(new NextRequest('https://raibit.kr/console?tab=projects'));
    assert.equal(consolePage.status, 307);
    assert.equal(consolePage.headers.get('location'), 'https://console.raibit.kr/console?tab=projects');

    assert.equal(proxy(new NextRequest('https://raibit.kr/')).status, 200);
    assert.equal(proxy(new NextRequest('https://raibit.kr.attacker.example/login')).status, 200);
  } finally {
    restoreEnvironment('RAIBITSERVER_DASHBOARD_BASIC_AUTH', originalBasicAuth);
    restoreEnvironment('RAIBITSERVER_DASHBOARD_ORIGIN', originalDashboardOrigin);
    restoreEnvironment('RAIBITSERVER_CONSOLE_URL', originalConsoleUrl);
  }
});

test('optional Basic Auth protects dashboard planes without closing the public landing', { concurrency: false }, () => {
  const originalBasicAuth = process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH;
  const originalDashboardOrigin = process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  const originalConsoleUrl = process.env.RAIBITSERVER_CONSOLE_URL;
  process.env.RAIBITSERVER_DASHBOARD_BASIC_AUTH = 'review:secret';
  delete process.env.RAIBITSERVER_DASHBOARD_ORIGIN;
  process.env.RAIBITSERVER_CONSOLE_URL = 'https://console.raibit.kr/console';
  try {
    const publicLanding = proxy(new NextRequest('https://raibit.kr/'));
    assert.equal(publicLanding.status, 200);

    const publicLogin = proxy(new NextRequest('https://raibit.kr/login?mode=signup'));
    assert.equal(publicLogin.status, 307);
    assert.equal(publicLogin.headers.get('location'), 'https://console.raibit.kr/login?mode=signup');

    const anonymousConsole = proxy(new NextRequest('https://console.raibit.kr/login'));
    assert.equal(anonymousConsole.status, 401);

    const authenticatedConsole = proxy(new NextRequest('https://console.raibit.kr/login', {
      headers: { authorization: `Basic ${Buffer.from('review:secret').toString('base64')}` },
    }));
    assert.equal(authenticatedConsole.status, 200);
  } finally {
    restoreEnvironment('RAIBITSERVER_DASHBOARD_BASIC_AUTH', originalBasicAuth);
    restoreEnvironment('RAIBITSERVER_DASHBOARD_ORIGIN', originalDashboardOrigin);
    restoreEnvironment('RAIBITSERVER_CONSOLE_URL', originalConsoleUrl);
  }
});

test('production login links return to the public raibit.kr landing instead of looping on the console root', async () => {
  const loginPage = await readFile(new URL('../apps/dashboard/app/login/page.tsx', import.meta.url), 'utf8');
  assert.match(loginPage, /process\.env\.NODE_ENV === 'production' \? 'https:\/\/raibit\.kr\/' : '\/'/);
  assert.equal(loginPage.match(/href=\{publicHomeHref\}/g)?.length, 2);
});

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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

test('production login links return to the public raibit.kr landing instead of looping on the console root', async () => {
  const loginPage = await readFile(new URL('../apps/dashboard/app/login/page.tsx', import.meta.url), 'utf8');
  assert.match(loginPage, /process\.env\.NODE_ENV === 'production' \? 'https:\/\/raibit\.kr\/' : '\/'/);
  assert.equal(loginPage.match(/href=\{publicHomeHref\}/g)?.length, 2);
});

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

import assert from 'node:assert/strict';
import path from 'node:path';
import https from 'node:https';
import { browserName, callbackPath, loginPath, transientNames } from './pr17-security-browser.mjs';

export async function navigate(page, url) {
  try { return await page.goto(url, { waitUntil: 'load', timeout: 15_000 }); }
  catch { throw new Error('pr17_browser_navigation_failed_sensitive_url_omitted'); }
}

export async function start(actor, fx) {
  const response = actor.page.waitForResponse((item) => new URL(item.url()).pathname === loginPath);
  await navigate(actor.page, `${fx.origin}${loginPath}`);
  return response;
}

export async function transaction(actor, fx) {
  const cookies = await actor.context.cookies(fx.origin);
  const state = cookies.find((cookie) => cookie.name.endsWith('raibitserver_github_oauth_state'))?.value;
  const verifier = cookies.find((cookie) => cookie.name.endsWith('raibitserver_github_oauth_verifier'))?.value;
  const identity = cookies.find((cookie) => cookie.name === browserName)?.value;
  assert.ok(Boolean(state && verifier && identity), 'real HTTPS start must issue transaction and browser cookies');
  const challenge = new URL(actor.page.url()).searchParams.get('code_challenge');
  assert.ok(Boolean(challenge), 'real API authorization URL must contain PKCE challenge');
  const code = fx.runtime.issueCode({ challenge });
  for (const secret of [state, verifier, identity, code]) fx.runtime.secrets.add(secret);
  return { state, verifier, identity, code };
}

export async function complete(actor, fx, tuple) {
  const response = actor.page.waitForResponse((item) => new URL(item.url()).pathname === callbackPath);
  await navigate(actor.page, `${fx.origin}${callbackPath}?${new URLSearchParams({ state: tuple.state, code: tuple.code })}`);
  return response;
}

export function snapshot(fx) {
  const store = fx.runtime.nest.repository.store;
  return { ...fx.runtime.counters, consumed: [...store.oauthTransactions.values()].filter((row) => row.consumedAt !== null).length };
}

export async function assertCleared(actor, fx) {
  const cookies = await actor.context.cookies(fx.origin);
  assert.equal(cookies.some((cookie) => transientNames.includes(cookie.name)), false, 'transient host cookies must be deleted');
}

export async function assertDeletion(response) {
  const lines = (await response.headersArray()).filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value);
  for (const name of transientNames) {
    const line = lines.find((item) => item.startsWith(`${name}=`)) || '';
    assert.ok(/; Max-Age=0(?:;|$)/i.test(line), 'callback must emit transient cookie deletion');
    assert.ok(/; Path=\/(?:;|$)/i.test(line) && /; Secure(?:;|$)/i.test(line) && /; HttpOnly(?:;|$)/i.test(line) && /; SameSite=Lax(?:;|$)/i.test(line));
    assert.equal(/; Domain=/i.test(line), false);
  }
}

export async function screenshotClean(actor, fx, name) {
  await Promise.all(fx.browser.contexts().map((context) => context.clearCookies()));
  await navigate(actor.page, `${fx.origin}${new URL(actor.page.url()).pathname === '/console' ? '/console' : '/login'}`);
  assert.equal((await actor.context.cookies()).length, 0);
  assert.equal(new URL(actor.page.url()).search, '');
  await actor.page.screenshot({ path: path.join(fx.evidence, `${name}.png`) });
}

export async function duplicateRequest(fx, name) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: '127.0.0.1', port: new URL(fx.origin).port, path: loginPath,
      rejectUnauthorized: false, headers: { host: new URL(fx.origin).host, cookie: `${name}=one; ${name}=two` },
      signal: AbortSignal.timeout(5000) }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.once('error', () => reject(new Error('pr17_duplicate_request_failed')));
  });
}

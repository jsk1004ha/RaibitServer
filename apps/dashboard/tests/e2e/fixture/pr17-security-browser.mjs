import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { bootOAuthRuntime } from '../../../../../tests/fixtures/github-oauth-runtime.mjs';
import { waitForPortsFree } from './process-tree.mjs';
import { loadSecurityRoute } from './pr17-security-route-loader.mjs';

export const loginPath = '/api/control/auth/github/login';
export const callbackPath = '/api/control/auth/github/callback';
export const browserName = '__Host-raibitserver_github_oauth_browser';
export const transientNames = ['__Host-raibitserver_github_oauth_state', '__Host-raibitserver_github_oauth_verifier'];
export const evidence = process.env.RAIBIT_PR17_EVIDENCE || fileURLToPath(new URL('../../../../../.omo/evidence/pr17-security-20260912/browser/', import.meta.url));

export async function bootSecurityBrowser() {
  const previousEnv = { ...process.env };
  await fs.mkdir(evidence, { recursive: true });
  const privateDirectory = await fs.mkdtemp(path.join(evidence, 'private-'));
  const fx = { evidence, api: [], bff: [], injection: [], faults: [], ownedPorts: [], privateDirectory };
  let route;
  let tls;
  let runtime;
  let browserServer;
  let closed;
  fx.close = () => closed ??= (async () => {
    const failures = [];
    for (const stop of [
      async () => { if (fx.browser) await fx.browser.close(); },
      async () => { if (browserServer) await browserServer.close(); },
      async () => { if (tls) { tls.closeAllConnections(); await new Promise((resolve, reject) => tls.close((error) => error ? reject(error) : resolve())); } },
      async () => { if (runtime) await runtime.close(); },
      async () => { if (route) route.close(); },
      async () => {
        if (path.dirname(privateDirectory) !== path.resolve(evidence) || !path.basename(privateDirectory).startsWith('private-')) throw new Error('pr17_cleanup_scope');
        await fs.rm(privateDirectory, { recursive: true });
      },
    ]) { try { await stop(); } catch { failures.push('pr17_cleanup_operation_failed'); } }
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    try { await waitForPortsFree(fx.ownedPorts); } catch { failures.push('pr17_ports_still_open'); }
    const browserExit = browserServer?.process().exitCode;
    if (browserServer && browserExit === null) failures.push('pr17_browser_still_running');
    await fs.writeFile(path.join(evidence, `pr17-security-${fx.mode}-cleanup.json`), JSON.stringify({
      runnerPid: process.pid, browserPid: fx.browserPid, browserExit, opensslPid: fx.opensslPid,
      ports: fx.ownedPorts, portsClosed: !failures.includes('pr17_ports_still_open'),
      privateMaterialRemoved: !failures.length, environmentRestored: true, failures,
    }, null, 2));
    if (failures.length) throw new Error(failures.join(','));
  })();
  try {
    fx.mode = process.env.RAIBIT_PR17_SESSION_MUTATION === '1' ? 'session-mutation' : process.env.RAIBIT_PR17_LEGACY_MUTATION === '1' ? 'legacy-mutation' : 'fixed';
    const openssl = spawn(process.env.RAIBIT_PR17_OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'), [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(privateDirectory, 'key.pem'),
      '-out', path.join(privateDirectory, 'cert.pem'), '-days', '1', '-subj', '/CN=console.raibit.test',
      '-addext', 'subjectAltName=DNS:console.raibit.test,DNS:tenant.raibit.test,DNS:github.com,IP:127.0.0.1',
    ], { cwd: path.resolve(evidence), stdio: 'ignore', windowsHide: true });
    fx.opensslPid = openssl.pid;
    if ((await once(openssl, 'exit'))[0] !== 0) throw new Error('pr17_tls_generation_failed');
    tls = https.createServer({ key: await fs.readFile(path.join(privateDirectory, 'key.pem')), cert: await fs.readFile(path.join(privateDirectory, 'cert.pem')) }, (req, res) => {
      void respond(req, res).catch(() => { fx.faults.push('pr17_https_handler_failed'); res.destroy(); });
    });
    tls.listen(0, '127.0.0.1'); await once(tls, 'listening');
    const tlsPort = tls.address().port;
    fx.ownedPorts.push(tlsPort);
    fx.origin = `https://console.raibit.test:${tlsPort}`;
    fx.tenantOrigin = `https://tenant.raibit.test:${tlsPort}`;
    process.env.RAIBITSERVER_DASHBOARD_ORIGIN = fx.origin;
    runtime = await bootOAuthRuntime({ redirectUri: `${fx.origin}${callbackPath}` });
    process.env.RAIBITSERVER_OAUTH_RELAY_SECRET = crypto.randomBytes(32).toString('hex');
    runtime.secrets.add(process.env.RAIBITSERVER_OAUTH_RELAY_SECRET);
    fx.runtime = runtime;
    fx.ownedPorts.push(...runtime.ownedPorts);
    process.env.RAIBITSERVER_API_URL = runtime.nest.baseUrl;
    runtime.nest.app.getHttpServer().on('request', (req, res) => {
      const operation = new URL(req.url, 'http://localhost').pathname;
      res.once('finish', () => fx.api.push({ operation, status: res.statusCode, peer: req.socket.remoteAddress }));
    });
    route = await loadSecurityRoute({ legacyMutation: fx.mode === 'legacy-mutation', sessionMutation: fx.mode === 'session-mutation' });
    browserServer = await chromium.launchServer({
      executablePath: process.env.RAIBIT_OAUTH_CHROMIUM || chromium.executablePath(),
      headless: process.env.RAIBIT_PR17_HEADLESS === '1',
      args: ['--no-sandbox', '--no-proxy-server', `--host-resolver-rules=MAP console.raibit.test 127.0.0.1, MAP tenant.raibit.test 127.0.0.1, MAP github.com 127.0.0.1:${tlsPort}, MAP * ~NOTFOUND`],
    });
    fx.browserPid = browserServer.process().pid;
    fx.browser = await chromium.connect(browserServer.wsEndpoint());
    fx.version = fx.browser.version();
    return fx;
  } catch (error) { await fx.close(); throw error; }

  async function respond(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.hostname === 'tenant.raibit.test' && url.pathname === '/pr17-security/inject'
      || url.hostname === 'console.raibit.test' && url.pathname === '/pr17-security/transplant') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'set-cookie': fx.injection });
      return res.end('<title>PR17 cookie response</title><h1>Cookie response delivered</h1>');
    }
    if (url.hostname === 'console.raibit.test' && url.pathname.startsWith('/api/control/')) {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = new route.NextRequest(url, { method: req.method, headers, ...(body.length ? { body } : {}) });
      const result = await route.withHeaders(headers, () => route[req.method](request, {
        params: Promise.resolve({ path: url.pathname.slice('/api/control/'.length).split('/') }),
      }));
      fx.bff.push({ operation: url.pathname, cookieNames: (req.headers.cookie || '').split(';').filter(Boolean).map((entry) => entry.split('=', 1)[0].trim()), status: result.status });
      const responseHeaders = Object.fromEntries(result.headers);
      delete responseHeaders['set-cookie'];
      const cookies = result.headers.getSetCookie();
      for (const cookie of result.cookies.getAll()) if (cookie.value) runtime.secrets.add(cookie.value);
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      res.writeHead(result.status, responseHeaders);
      return res.end(Buffer.from(await result.arrayBuffer()));
    }
    const provider = url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize';
    const landing = url.hostname === 'console.raibit.test' && ['/login', '/console'].includes(url.pathname);
    res.writeHead(provider || landing ? 200 : 404, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<title>PR17 focused OAuth harness</title><h1>${provider ? 'Mock GitHub provider' : url.pathname === '/console' ? 'OAuth callback completed' : 'OAuth sign-in'}</h1><p>HTTPS route harness. Real Next handler and Nest HTTP API.</p>`);
  }
}

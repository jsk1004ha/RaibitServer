import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootOAuthRuntime } from '../../../../../tests/fixtures/github-oauth-runtime.mjs';
import { terminateProcessTree } from './process-tree.mjs';

const dashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = process.env.RAIBIT_OAUTH_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || evidence.startsWith(dashboard)) throw new Error('external_oauth_evidence_directory_required');
await fs.mkdir(evidence, { recursive: true });
const privateDirectory = await fs.mkdtemp(path.join(evidence, 'private-'));
const children = [];
const counters = { start: 0, callback: 0 };
let runtime;
let tls;
let nextPort;
let cleanupPromise;
let manifest;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void cleanup().then(() => process.exit(0), () => process.exit(1)); });

try {
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(privateDirectory, 'key.pem'), '-out', path.join(privateDirectory, 'cert.pem'), '-days', '1', '-subj', '/CN=console.localhost', '-addext', 'subjectAltName=DNS:console.localhost,DNS:localhost,IP:127.0.0.1']);
  tls = https.createServer({ key: await fs.readFile(path.join(privateDirectory, 'key.pem')), cert: await fs.readFile(path.join(privateDirectory, 'cert.pem')) }, proxy);
  tls.listen(0, '127.0.0.1'); await once(tls, 'listening');
  const origin = `https://console.localhost:${tls.address().port}`;
  runtime = await bootOAuthRuntime({ redirectUri: `${origin}/api/control/auth/github/callback` });
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  nextPort = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const nextBin = path.join(dashboard, 'node_modules/next/dist/bin/next');
  const nextEnv = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', RAIBITSERVER_API_URL: runtime.nest.baseUrl,
    RAIBITSERVER_DASHBOARD_ORIGIN: origin, RAIBITSERVER_CONSOLE_URL: `${origin}/console`, RAIBITSERVER_BASE_DOMAIN: 'localhost' };
  if (process.env.RAIBIT_OAUTH_SKIP_BUILD !== '1') await run(process.execPath, [nextBin, 'build'], nextEnv);
  const next = start(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(nextPort)], nextEnv);
  await ready(`http://127.0.0.1:${nextPort}/login`, next);
  manifest = { runId: process.env.RAIBIT_OAUTH_RUN_ID, pid: process.pid, origin, managementOrigin: `https://127.0.0.1:${tls.address().port}`,
    surfaces: runtime.surfaces.map(({ name, baseUrl }) => ({ name, baseUrl })), nextPort, tlsPort: tls.address().port, ownedPorts: runtime.ownedPorts, truthLevel: 'L1', ready: true };
  await fs.writeFile(path.join(evidence, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write('task9 HTTPS OAuth fixture ready\n');
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(`task9 fixture failed: ${error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'fixture_start_failed'}\n`);
  process.exitCode = 1;
} finally { await cleanup(); }

async function proxy(req, res) {
  const url = new URL(req.url || '/', 'https://localhost');
  if (req.headers.host === 'github.com') {
    res.writeHead(url.pathname === '/login/oauth/authorize' ? 200 : 404, { 'content-type': 'text/html' });
    return res.end('<title>OAuth provider fixture</title>');
  }
  if (url.pathname.startsWith('/__oauth/')) {
    try {
      if (!runtime) return json(res, 503, { ready: false });
      if (url.pathname === '/__oauth/counters') return json(res, 200, { ...runtime.counters, ...counters });
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) return json(res, 400, {}); }
      const input = body ? JSON.parse(body) : {};
      if (url.pathname === '/__oauth/code') return json(res, 200, { code: runtime.issueCode(input) });
      if (url.pathname === '/__oauth/expire') {
        for (const row of runtime.nest.repository.store.oauthTransactions.values()) runtime.nest.repository.store.oauthTransactions.set(row.stateHash, { ...row, expiresAt: 0 });
        return json(res, 200, { expired: true });
      }
      if (url.pathname === '/__oauth/reset-account') {
        delete process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET;
        const user = [...runtime.nest.repository.store.users.values()][0];
        Object.assign(user, { approvalStatus: input.pending ? 'PENDING' : 'APPROVED', emailVerifiedAt: input.unverified ? null : new Date().toISOString() });
        return json(res, 200, { updated: true });
      }
      if (url.pathname === '/__oauth/configuration-failure') {
        process.env.RAIBITSERVER_AUTH_RATE_LIMIT_KEY_SECRET = '';
        return json(res, 200, { misconfigured: true });
      }
      if (url.pathname === '/__oauth/scan') {
        for (const value of input.values || []) if (typeof value === 'string') runtime.secrets.add(value);
        const rows = JSON.stringify([...runtime.nest.repository.store.oauthTransactions.values()]);
        return json(res, 200, { clean: ![...runtime.secrets].some((value) => rows.includes(value)), rows: runtime.nest.repository.store.oauthTransactions.size });
      }
      return json(res, 404, {});
    } catch { return json(res, 400, { error: 'fixture_input_invalid' }); }
  }
  if (!nextPort) return json(res, 503, {});
  if (url.pathname === '/api/control/auth/github/login') counters.start += 1;
  if (url.pathname === '/api/control/auth/github/callback') counters.callback += 1;
  const upstream = http.request({ hostname: '127.0.0.1', port: nextPort, path: req.url, method: req.method,
    headers: { ...req.headers, host: `console.localhost:${tls.address().port}`, 'x-forwarded-proto': 'https' } }, (response) => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => json(res, 502, { error: 'fixture_upstream_unavailable' }));
  req.pipe(upstream);
}

function json(res, status, body) { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: dashboard, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  // Runtime output may contain OAuth URLs. Retain only exit/status evidence.
  child.stdout.resume(); child.stderr.resume(); children.push(child); return child;
}
async function run(command, args, env) {
  const child = start(command, args, env);
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('fixture_child_failed');
}
async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('fixture_child_exited');
    try { const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) }); if (response.status < 500) return; }
    catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('fixture_readiness_timeout');
}
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const child of [...children].reverse()) await terminateProcessTree(child);
    if (tls) { tls.closeAllConnections(); await new Promise((resolve) => tls.close(resolve)); }
    if (runtime) await runtime.close();
    if (path.dirname(privateDirectory) !== path.resolve(evidence) || !path.basename(privateDirectory).startsWith('private-')) throw new Error('private_cleanup_scope_invalid');
    await fs.rm(privateDirectory, { recursive: true });
    if (manifest) await fs.writeFile(path.join(evidence, 'runtime-manifest.json'), JSON.stringify({ ...manifest, ready: false }, null, 2));
    await fs.writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ pid: process.pid, childPids: children.map((child) => child.pid),
      ports: [manifest?.tlsPort, nextPort, ...(runtime?.ownedPorts || [])], closed: true, privateMaterialRemoved: true, fetchAndEnvironmentRestored: true }, null, 2));
  })();
  return cleanupPromise;
}

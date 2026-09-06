import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree, waitForPortsFree } from './process-tree.mjs';

const dashboardDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nextBin = path.join(dashboardDirectory, 'node_modules', 'next', 'dist', 'bin', 'next');
const projectNodeModules = path.join(dashboardDirectory, 'node_modules');
const configuredOutput = process.env.RAIBITSERVER_E2E_FIXTURE_OUTPUT_DIR;
if (configuredOutput && !path.isAbsolute(configuredOutput)) throw new Error('dashboard_fixture_output_directory_must_be_absolute');
const fixtureOutput = configuredOutput ?? await mkdtemp(path.join(tmpdir(), 'raibitserver-dashboard-fixture-'));
const nextDistDir = path.join(fixtureOutput, 'next');
const removeFixtureOutput = !configuredOutput;
const children = [];
let cleanupPromise;

try {
  await assertPortsFree([3410, 3411]);
  await run(process.execPath, [nextBin, 'build', '--webpack'], { NODE_ENV: 'production', RAIBITSERVER_NEXT_DIST_DIR: nextDistDir });
  const control = start(process.execPath, [path.join(dashboardDirectory, 'tests/e2e/fixture/control-plane.mjs')]);
  await ready('http://127.0.0.1:3411/__fixture/ready', control);
  const dashboard = start(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', '3410'], {
    NODE_ENV: 'production', RAIBITSERVER_NEXT_DIST_DIR: nextDistDir, RAIBITSERVER_API_URL: 'http://127.0.0.1:3411/api',
    RAIBITSERVER_DASHBOARD_ORIGIN: 'http://console.localhost:3410', RAIBITSERVER_CONSOLE_URL: 'http://console.localhost:3410/console',
    RAIBITSERVER_BASE_DOMAIN: 'localhost', RAIBITSERVER_GIT_SHA: '0123456789abcdef0123456789abcdef01234567', RAIBITSERVER_GITHUB_REPOSITORY: 'raibit/fixture-app',
  });
  await ready('http://127.0.0.1:3410/login', dashboard, { host: 'console.localhost:3410' });
  process.stdout.write('fixture-dashboard:3410\n');
  if (process.env.RAIBITSERVER_FIXTURE_FAIL_AFTER_READY === '1') throw new Error('intentional_fixture_failure');
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await shutdown();
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: dashboardDirectory, env: { ...process.env, ...extraEnv, NODE_PATH: [projectNodeModules, process.env.NODE_PATH, extraEnv.NODE_PATH].filter(Boolean).join(path.delimiter) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); children.push(child); return child;
}
function run(command, args, extraEnv) {
  return new Promise((resolve, reject) => { const child = start(command, args, extraEnv); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`command_failed_${code}`))); });
}
async function ready(url, child, headers = {}) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture_child_exited_${child.exitCode}`);
    try { const response = await fetch(url, { headers, redirect: 'manual' }); if (response.status < 500) return; } catch (error) { if (!(error instanceof TypeError)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fixture_readiness_timeout:${url}`);
}
async function assertPortsFree(ports) {
  for (const port of ports) await new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); reject(new Error(`fixture_port_in_use:${port}`)); }); socket.once('error', () => resolve()); });
}
function shutdown() {
  cleanupPromise ??= (async () => {
    for (const child of [...children].reverse()) await terminateProcessTree(child);
    await waitForPortsFree([3410, 3411]);
    if (removeFixtureOutput) await rm(fixtureOutput, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().then(() => process.exit(0), (error) => { process.stderr.write(`${error}\n`); process.exit(1); }); });

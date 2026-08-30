import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nextBin = path.join(dashboardDirectory, 'node_modules', 'next', 'dist', 'bin', 'next');
const children = [];

await assertPortsFree([3410, 3411]);
await run(process.execPath, [nextBin, 'build'], { NODE_ENV: 'production' });
const control = start(process.execPath, [path.join(dashboardDirectory, 'tests/e2e/fixture/control-plane.mjs')]);
await ready('http://127.0.0.1:3411/__fixture/ready', control);
const dashboard = start(process.execPath, [nextBin, 'start', '--hostname', '0.0.0.0', '--port', '3410'], {
  NODE_ENV: 'production', RAIBITSERVER_API_URL: 'http://127.0.0.1:3411/api',
  RAIBITSERVER_DASHBOARD_ORIGIN: 'http://console.localhost:3410', RAIBITSERVER_CONSOLE_URL: 'http://console.localhost:3410/console',
  RAIBITSERVER_BASE_DOMAIN: 'localhost', RAIBITSERVER_GIT_SHA: '0123456789abcdef0123456789abcdef01234567', RAIBITSERVER_GITHUB_REPOSITORY: 'raibit/fixture-app',
});
await ready('http://127.0.0.1:3410/login', dashboard, { host: 'console.localhost:3410' });
process.stdout.write('fixture-dashboard:3410\n');
await new Promise(() => {});

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: dashboardDirectory, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
async function shutdown() { for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM'); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
process.on('exit', () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); });

import { spawn } from 'node:child_process';
import net from 'node:net';

const TERMINATION_TIMEOUT_MS = 5_000;

export async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForExit(killer, TERMINATION_TIMEOUT_MS);
    if (!(await waitForExit(child, TERMINATION_TIMEOUT_MS))) throw new Error(`fixture_process_tree_still_running:${child.pid}`);
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  if (await waitForExit(child, 1_000)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  if (!(await waitForExit(child, TERMINATION_TIMEOUT_MS))) throw new Error(`fixture_process_tree_still_running:${child.pid}`);
}

export async function waitForPortsFree(ports, timeoutMs = TERMINATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(ports.map(isPortFree));
    if (states.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture_ports_still_in_use:${ports.join(',')}`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

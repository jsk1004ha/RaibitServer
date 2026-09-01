import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from './process-tree.mjs';

const dashboardDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Playwright owns the fixture lifecycle process directly without a package-manager wrapper', async () => {
  const config = await readFile(path.join(dashboardDirectory, 'playwright.config.ts'), 'utf8');
  assert.match(config, /command: 'node tests\/e2e\/fixture\/serve\.mjs'/);
  assert.doesNotMatch(config, /command: 'pnpm test:e2e:serve'/);
});

test('intentional fixture failure releases the dashboard and control-plane ports', { timeout: 180_000 }, async () => {
  for (const port of [3410, 3411]) assert.equal(await isPortFree(port), true, `port ${port} must be free before the fixture starts`);
  const child = spawn(process.execPath, ['tests/e2e/fixture/serve.mjs'], {
    cwd: dashboardDirectory,
    env: { ...process.env, RAIBITSERVER_FIXTURE_FAIL_AFTER_READY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.notEqual(code, 0, output.join(''));
    const occupied = [];
    for (const port of [3410, 3411]) if (!(await isPortFree(port))) occupied.push(port);
    assert.deepEqual(occupied, [], `${output.join('')}\noccupied ports: ${occupied.join(', ')}`);
  } finally {
    await terminateProcessTree(child);
  }
});

function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

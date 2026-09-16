import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/observability-redaction-performance-child.mjs', import.meta.url));
const sizes = [256, 512, 1024];

function runBounded(size, mode) {
  const child = spawnSync(process.execPath, [fixture, String(size), ...(mode ? [mode] : [])], {
    encoding: 'utf8',
    timeout: 1_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(child.error, undefined, `size ${size} child must finish before the external timeout`);
  assert.equal(child.signal, null, `size ${size} child must not require interruption`);
  assert.equal(child.status, 0, `size ${size} child must exit successfully: ${child.stderr}`);
  assert.equal(child.stderr, '', `size ${size} child must not hide an error on stderr`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.outputMatches, true, `size ${size} benign input must remain unchanged`);
  assert.deepEqual(result.state, { v: 1, pem: false });
  assert.equal(result.execPath, process.execPath);
  return result;
}

test('bounds repeated-keyword assignment scanning without changing benign output', () => {
  // Given exact pathological near-miss sizes, when each runs in a separately bounded child.
  const results = sizes.map(size => runBounded(size));
  // Then every child completes with a real output contract; retain timings for scaling reports.
  assert.deepEqual(results.map(result => result.size), sizes);
  assert.deepEqual(results.map(result => result.inputBytes), sizes.map(size => (9 * size) + 1));
});

test('uses the same bounded mechanism for a repeated-keyword query near miss', () => {
  // Given the equivalent query-string near miss, when the largest case runs in a bounded child.
  const result = runBounded(1024, 'query');
  // Then it completes successfully without changing the benign URL.
  assert.equal(result.size, 1024);
});

test('bounds URL credential scanning on repeated-keyword negative input', () => {
  // Given an actual benign URL after a near-limit adversarial prefix, when scanning repeatedly.
  const result = runBounded(1800, 'uri');
  // Then delimiter-driven URL classification remains externally bounded and preserves the input.
  assert.equal(result.iterations, 128);
});

test('bounds JWT scanning on repeated eyJ negative input', () => {
  // Given repeated JWT-like prefixes with no dots, when scanning repeatedly.
  const result = runBounded(2048, 'jwt');
  // Then the scanner does not retry at every hyphen boundary.
  assert.equal(result.iterations, 128);
});

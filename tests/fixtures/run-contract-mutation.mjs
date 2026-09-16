import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [input, mode, target] = process.argv.slice(2);
if (!input || !['--drop', '--drop-transition'].includes(mode) || !target) {
  console.error('usage: node tests/fixtures/run-contract-mutation.mjs <fixture> --drop <STATE> | --drop-transition <machine:from:to>');
  process.exit(2);
}

const sourcePath = path.resolve(input);
const original = await readFile(sourcePath);
const fixture = JSON.parse(original);
let removed = 0;
if (mode === '--drop') {
  for (const machine of Object.values(fixture.machines)) {
    if (Object.hasOwn(machine.states, target)) {
      delete machine.states[target];
      removed += 1;
      for (const state of Object.values(machine.states)) state.next = state.next.filter(next => next !== target);
      for (const [alias, state] of Object.entries(machine.aliases)) if (state === target) delete machine.aliases[alias];
    }
  }
} else {
  const [name, from, to] = target.split(':');
  const state = fixture.machines[name]?.states[from];
  if (state?.next.includes(to)) {
    state.next = state.next.filter(next => next !== to);
    removed = 1;
  }
}
if (!removed) {
  console.error('mutation target not found: ' + target);
  process.exit(2);
}

const temporary = await mkdtemp(path.join(tmpdir(), 'raibit-lifecycle-'));
try {
  const mutatedPath = path.join(temporary, 'lifecycle-v1.json');
  await writeFile(mutatedPath, JSON.stringify(fixture));
  const env = { ...process.env, RAIBITSERVER_LIFECYCLE_FIXTURE: mutatedPath };
  const consumers = [
    { name: 'TypeScript/core+schemas', binary: process.execPath, args: ['--test', 'tests/lifecycle-contract.test.js'], failureMarker: 'AssertionError' },
    ...['builder', 'orchestrator', 'provisioner'].map(service => ({
      name: 'Go/' + service, binary: 'go', args: ['-C', 'services/' + service, 'test', './...', '-run', 'TestLifecycleContract', '-count=1', '-v'], failureMarker: '--- FAIL: TestLifecycleContract',
    })),
  ];
  const results = await Promise.all(consumers.map(consumer => new Promise(resolve => {
    const child = spawn(consumer.binary, consumer.args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => resolve({ name: consumer.name, setupError: error.message, exit: null, output }));
    child.on('close', exit => resolve({ name: consumer.name, exit, output, divergent: exit === 1 && output.includes(consumer.failureMarker) }));
  })));
  for (const result of results) {
    console.log(`consumer=${result.name} exit=${result.exit} divergent=${Boolean(result.divergent)}`);
    console.log(result.output);
    if (result.setupError) console.error(result.setupError);
  }
  const untouched = original.equals(await readFile(sourcePath));
  console.log('source-unchanged=' + untouched + ' sha256=' + createHash('sha256').update(original).digest('hex'));
  const tsFailed = results.some(result => result.name.startsWith('TypeScript/') && result.divergent);
  const goFailed = results.some(result => result.name.startsWith('Go/') && result.divergent);
  const infrastructureFailed = results.some(result => result.setupError || (result.exit !== 0 && !result.divergent));
  process.exitCode = untouched && !infrastructureFailed ? (tsFailed && goFailed ? 1 : 0) : 2;
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log('temporary-fixture-cleanup=complete');
}

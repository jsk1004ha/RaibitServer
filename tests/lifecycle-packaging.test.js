import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncLifecycleContract } from '../scripts/sync-lifecycle-contract.mjs';
import * as coreLifecycle from '../packages/core/src/lifecycle.ts';
import * as schemaLifecycle from '../packages/schemas/src/lifecycle.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

test('Given generated lifecycle data, when checked, then both package mirrors exactly match the canonical fixture', async () => {
  await syncLifecycleContract(root);
  const fixture = JSON.parse(await readFile(path.join(root, 'test-fixtures/contracts/lifecycle-v1.json'), 'utf8'));
  assert.deepEqual(coreLifecycle.LIFECYCLE_CONTRACT, fixture);
  assert.deepEqual(schemaLifecycle.LIFECYCLE_CONTRACT, fixture);
  for (const machine of Object.values(fixture.machines)) {
    assert.deepEqual(coreLifecycle.terminalLifecycleInputs(machine.states, machine.aliases),
      schemaLifecycle.terminalLifecycleInputs(machine.states, machine.aliases));
  }
});

test('Given a stale package mirror, when checking then regenerating, drift fails without writes and explicit generation repairs it', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'raibit-lifecycle-drift-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const relative of ['test-fixtures/contracts', 'packages/core/src', 'packages/schemas/src']) {
    await mkdir(path.join(temporary, relative), { recursive: true });
    await cp(path.join(root, relative, 'lifecycle-v1.json'), path.join(temporary, relative, 'lifecycle-v1.json'));
  }
  for (const relative of ['packages/core/src/lifecycle-v1.json', 'packages/schemas/src/lifecycle-v1.json', 'test-fixtures/contracts/lifecycle-v1.json']) {
    const target = path.join(temporary, relative);
    const original = await readFile(target, 'utf8');
    await writeFile(target, original + '\n');
    await assert.rejects(syncLifecycleContract(temporary), /Lifecycle contract drift/);
    assert.equal(await readFile(target, 'utf8'), original + '\n');
    await syncLifecycleContract(temporary, true);
    await syncLifecycleContract(temporary);
  }
});

test('Given core and schema boundaries, when canonical, legacy and hostile inputs arrive, their accepted values agree', () => {
  for (const [name, parser] of [['deployment', 'parseDeploymentStatus'], ['workflow', 'parseWorkflowStatus']]) {
    const machine = coreLifecycle.LIFECYCLE_CONTRACT.machines[name];
    const values = [undefined, null, '', '  ', ...Object.keys(machine.states), ...Object.keys(machine.aliases)];
    for (const value of values.flatMap(value => typeof value === 'string' ? [value, value.toLowerCase(), ' ' + value.toUpperCase() + ' '] : [value])) {
      assert.equal(coreLifecycle[parser](value), schemaLifecycle[parser](value), String(value));
    }
    for (const value of ['arbitrary', '__proto__', 'toString', 'constructor', 0, {}, []]) {
      let expected;
      try {
        expected = schemaLifecycle[parser](value);
      } catch {
        assert.throws(() => coreLifecycle[parser](value), coreLifecycle.LifecycleStatusError);
        continue;
      }
      assert.equal(coreLifecycle[parser](value), expected);
    }
  }
});

test('Given the API Docker core rootDir, when emitted and isolated, then core lifecycle runs without sibling sources', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'raibit-lifecycle-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'core');
  const args = [
    require.resolve('typescript/bin/tsc'), '-p', '../../packages/core/tsconfig.json',
    '--noEmit', 'false', '--declaration', 'false', '--incremental', 'false',
    '--rootDir', '../../packages/core/src', '--outDir', output,
    '--rewriteRelativeImportExtensions', 'true', '--noEmitOnError', 'true',
  ];
  const emitted = spawnSync(process.execPath, args, { cwd: path.join(root, 'apps/api'), encoding: 'utf8' });
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const api = path.join(temporary, 'api');
  const schemasPackage = path.join(api, 'node_modules', '@raibitserver', 'schemas');
  await mkdir(path.dirname(schemasPackage), { recursive: true });
  await cp(path.join(root, 'packages', 'schemas'), schemasPackage, {
    recursive: true,
    filter: source => path.basename(source) !== 'node_modules',
  });
  await mkdir(path.join(schemasPackage, 'node_modules'), { recursive: true });
  await symlink(path.dirname(require.resolve('zod/package.json', { paths: [path.join(root, 'packages', 'schemas')] })), path.join(schemasPackage, 'node_modules', 'zod'), 'junction');
  await writeFile(path.join(api, 'package.json'), '{"name":"@raibitserver/api","type":"module"}');
  const emittedSchemas = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'build-cli-runtime.mjs'), '--schemas-only', api,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(emittedSchemas.status, 0, emittedSchemas.stdout + emittedSchemas.stderr);
  await writeFile(path.join(output, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(output, 'node_modules'), { recursive: true });
  await symlink(path.dirname(require.resolve('yaml/package.json')), path.join(output, 'node_modules', 'yaml'), 'junction');
  await mkdir(path.join(output, 'node_modules', '@raibitserver'), { recursive: true });
  await symlink(schemasPackage, path.join(output, 'node_modules', '@raibitserver', 'schemas'), 'junction');
  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { canTransitionDeployment, normalizeDeploymentStatus, isDeploymentTerminal, createWorkflowJobRecord } from './index.js';
    import { ServiceCreateSchema } from '@raibitserver/schemas';
    assert.equal(normalizeDeploymentStatus('cleanup-requested'), 'PREVIEW_CLEANUP_REQUESTED');
    assert.equal(canTransitionDeployment('ROLLBACK_REQUESTED', 'DEPLOYING'), true);
    assert.equal(canTransitionDeployment('DEPLOYING', 'CLEANED_UP'), true);
    assert.equal(isDeploymentTerminal('CLEANED_UP'), true);
    assert.equal(createWorkflowJobRecord({ targetId: 'packaged', status: 'completed' }).status, 'succeeded');
    assert.equal(ServiceCreateSchema.parse({ name: 'packaged' }).name, 'packaged');
    assert.throws(() => normalizeDeploymentStatus('arbitrary'));
    console.log('isolated-core-lifecycle-runtime=PASS');
  `], { cwd: output, encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
  assert.match(runtime.stdout, /isolated-core-lifecycle-runtime=PASS/);
});

test('Given only the deployed schemas package, when imported, then lifecycle does not need root test fixtures', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'raibit-lifecycle-schema-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(path.join(root, 'packages/schemas/src'), path.join(temporary, 'src'), { recursive: true });
  await writeFile(path.join(temporary, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(temporary, 'node_modules'));
  await symlink(path.dirname(require.resolve('zod/package.json', { paths: [path.join(root, 'packages/schemas')] })), path.join(temporary, 'node_modules/zod'), 'junction');
  const runtime = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { DeploymentStatusSchema, LIFECYCLE_CONTRACT } from './src/index.ts';
    assert.equal(DeploymentStatusSchema.parse('IMAGE_READY'), 'IMAGE_READY');
    assert.ok(LIFECYCLE_CONTRACT.machines.deployment.states.BUILDING.next.includes('IMAGE_READY'));
    console.log('isolated-schema-lifecycle-runtime=PASS');
  `], { cwd: temporary, encoding: 'utf8' });
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
  assert.match(runtime.stdout, /isolated-schema-lifecycle-runtime=PASS/);
});

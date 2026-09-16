import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';
import { createRunnerContext } from '../scripts/production-evidence/lib/runner-context.mjs';
import { AUTH_BOOTSTRAP } from '../scripts/production-evidence/lib/authenticated-client.mjs';

const deadline = () => new Date(Date.now() + 60_000).toISOString();
const deleteOptions = `${JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'pod-uid', resourceVersion: 'pod-rv-1' } })}\n`;
const pod = '{"apiVersion":"v1","kind":"Pod"}';
const mappedSpawn = (source) => (_file, _args, options) => realSpawn(process.execPath, ['-e', source], options);

test('Given canonical kubectl JSON stdin, When a real child consumes it, Then the exact bytes are delivered once', async () => {
  const source = "const c=[];process.stdin.on('data',x=>c.push(x));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(c).toString('base64')))";
  const context = createRunnerContext(path.resolve('run'), deadline(), undefined, { spawn: (file, args, options) => {
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(Object.hasOwn(options, 'stdin'), false);
    return mappedSpawn(source)(file, args, options);
  } });
  const result = await context.executeFile('kubectl', ['delete', '--raw', '/api/v1/namespaces/runtime/pods/client', '-f', '-'], { stdin: deleteOptions, timeoutMs: 5_000 });
  assert.equal(Buffer.from(result.stdout, 'base64').toString('utf8'), deleteOptions);
});

test('Given unsafe or noncanonical stdin, When command validation runs, Then rejection happens before spawn', async () => {
  let spawned = 0;
  const context = createRunnerContext(path.resolve('run'), deadline(), undefined, { spawn: () => { spawned += 1; throw new Error('must not spawn'); } });
  const invalid = [
    ['node', ['-f', '-'], { stdin: '{}' }],
    ['kubectl', ['create', '-f', 'manifest.json'], { stdin: '{}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: ' {}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{}\n\n' }],
    ['kubectl', ['create', '-f', '-'], { stdin: Buffer.alloc(256 * 1024 + 1, 0x61) }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"apiVersion":"v1","kind":"Secret"}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"kind":"Pod","data":{"key":"value"}}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"kind":"Pod","spec":{"containers":[{"env":[{"name":"X","value":"literal"}]}]}}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"kind":"Pod","note":"Bearer abcdefghijklmnop"}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"kind":"Pod","url":"https://user:pass@example.test"}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{}' , unexpected: true }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"apiVersion":"v1","kind":"Pod","password":"literal"}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"apiVersion":"v1","kind":"Pod","stringData":{}}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: '{"apiVersion":"v1","kind":"Pod","kind":"Pod"}' }],
    ['kubectl', ['create', '-f', '-'], { stdin: 'not-json' }],
    ['kubectl', ['create', '-f', '-'], {}],
    ['kubectl', ['create', '-f', '-', '--server=https://elsewhere.example'], { stdin: pod }],
    ['kubectl', ['delete', '--raw', '/api/v1/namespaces/runtime/pods/client?x=1', '-f', '-'], { stdin: deleteOptions }],
    ['kubectl', ['delete', '--raw', '/api/v1/namespaces/runtime/pods/client', '-f', '-'], { stdin: '{"apiVersion":"v1","kind":"DeleteOptions"}' }],
  ];
  for (const [file, args, options] of invalid) await assert.rejects(context.executeFile(file, args, options), (error) => ['invalid_command', 'redaction'].includes(error.reason));
  assert.equal(spawned, 0);
});

test('Given metadata-only secret references and bootstrap source, When stdin is parsed, Then no literal credential is required', async () => {
  const manifest = JSON.stringify({ apiVersion: 'v1', kind: 'Pod', spec: { containers: [{ args: ['-e', AUTH_BOOTSTRAP],
    env: [{ name: 'OPERATOR_PASSWORD', valueFrom: { secretKeyRef: { name: 'operator', key: 'password', optional: false } } }] }] } });
  const context = createRunnerContext(path.resolve('run'), deadline(), undefined, { spawn: mappedSpawn("process.stdin.resume();process.stdin.on('end',()=>process.exit(0))") });
  assert.equal((await context.executeFile('kubectl', ['create', '-f', '-'], { stdin: manifest })).exitCode, 0);
});

test('Given a child that closes stdin or exceeds its deadline, When execution settles, Then EPIPE is safe and timeout is typed', async () => {
  const closed = createRunnerContext(path.resolve('run'), deadline(), undefined, { spawn: mappedSpawn('process.exit(0)') });
  assert.equal((await closed.executeFile('kubectl', ['create', '-f', '-'], { stdin: pod, timeoutMs: 5_000 })).exitCode, 0);
  const hanging = createRunnerContext(path.resolve('run'), deadline(), undefined, { spawn: mappedSpawn('setInterval(()=>{},1000)') });
  await assert.rejects(hanging.executeFile('kubectl', ['create', '-f', '-'], { stdin: pod, timeoutMs: 25 }), { reason: 'command_timeout' });
});

test('Given a child that prints credential material, When output is collected, Then no leaked value is returned', async () => {
  const context = createRunnerContext(path.resolve('run'), deadline(), undefined, { spawn: mappedSpawn("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('Bearer abcdefghijklmnop'))") });
  await assert.rejects(context.executeFile('kubectl', ['create', '-f', '-'], { stdin: pod }), { reason: 'redaction' });
});

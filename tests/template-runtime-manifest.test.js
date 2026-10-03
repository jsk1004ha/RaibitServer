import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject } from '../packages/core/src/manifest-compiler.ts';

const reference = (name = 'DATABASE_URL') => ({ name, valueFrom: { secretKeyRef: { name: 'database-connection', key: 'DATABASE_URL' } } });
const compile = (service = {}, resources = []) => compileProject({
  organization: { slug: 'acme' },
  project: { slug: 'template-runtime' },
  services: [{ name: 'app', sourceType: 'image', image: 'example/app:1', ...service }],
  resources,
});

test('all workload types project existing Secret references without secret material or input mutation', () => {
  for (const type of ['web', 'private', 'worker', 'job', 'cron']) {
    const service = { type, environment: { NODE_ENV: 'production', LEGACY_TOKEN: 'existing-value' }, secretEnv: [reference()] };
    const before = structuredClone(service);
    const plan = compile(service);
    const kind = type === 'job' ? 'Job' : type === 'cron' ? 'CronJob' : 'Deployment';
    const workload = plan.manifests.find((item) => item.kind === kind);
    const pod = kind === 'CronJob' ? workload.spec.jobTemplate.spec.template.spec : workload.spec.template.spec;
    assert.deepEqual(pod.containers[0].env, [
      { name: 'NODE_ENV', valueFrom: { configMapKeyRef: { name: 'app-config', key: 'NODE_ENV' } } },
      { name: 'LEGACY_TOKEN', valueFrom: { secretKeyRef: { name: 'app-env', key: 'LEGACY_TOKEN' } } },
      reference(),
    ], type);
    assert.deepEqual(plan.manifests.filter((item) => item.kind === 'Secret').map((item) => item.stringData), [{ LEGACY_TOKEN: 'existing-value' }]);
    assert.deepEqual(service, before);
    pod.containers[0].env.at(-1).valueFrom.secretKeyRef.name = 'changed-output';
    assert.deepEqual(service, before, 'manifest reference must not alias caller input');
  }
  assert.equal(compile({ secretEnv: [reference()] }).manifests.some((item) => item.kind === 'Secret'), false);
  assert.doesNotThrow(() => compile({ secretEnv: [] }));
});

test('Secret references reject duplicate names and plain or generated environment collisions', () => {
  for (const service of [
    { secretEnv: [reference(), reference()] },
    { environment: { NODE_ENV: 'production' }, secretEnv: [reference('NODE_ENV')] },
    { environment: { DATABASE_URL: 'existing-value' }, secretEnv: [reference()] },
  ]) {
    assert.throws(() => compile(service), /secretEnv: duplicate environment name/);
  }
  assert.throws(() => compile({ secretEnv: [reference()] }, [{ name: 'database', engine: 'postgresql' }]), /secretEnv: duplicate environment name/);
});

test('Secret references reject malformed objects, inline values, mixed sources, and invalid names', () => {
  const malformed = [
    null, {}, 'DATABASE_URL', [null], [[]], [{}], new Array(1),
    [{ ...reference(), value: 'must-not-be-accepted' }],
    [{ ...reference(), secretRef: 'secret:opaque-input' }],
    [{ name: 'DATABASE_URL', value: 'must-not-be-accepted' }],
    [{ name: 'DATABASE_URL', valueFrom: { configMapKeyRef: { name: 'config', key: 'DATABASE_URL' } } }],
    [{ ...reference(), valueFrom: { ...reference().valueFrom, fieldRef: { fieldPath: 'metadata.name' } } }],
    [{ ...reference(), valueFrom: { secretKeyRef: { ...reference().valueFrom.secretKeyRef, namespace: 'other-tenant' } } }],
    [{ ...reference(), valueFrom: { secretKeyRef: { ...reference().valueFrom.secretKeyRef, optional: true } } }],
    [{ ...reference(), valueFrom: [] }],
    [{ ...reference(), valueFrom: { secretKeyRef: [] } }],
    ...['', 'bad-name', 'lower_case', '1INVALID', 'A'.repeat(129), 42].map((name) => [{ ...reference(), name }]),
    ...['', 'INVALID', 'other/secret', 'a'.repeat(64), 42].map((name) => [{ name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name, key: 'DATABASE_URL' } } }]),
    ...['', 'bad-key', 'lower_case', 'A'.repeat(129), 42].map((key) => [{ name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'database-connection', key } } }]),
    Array.from({ length: 129 }, (_, index) => reference(`VALUE_${index}`)),
  ];
  for (const secretEnv of malformed) {
    assert.throws(() => compile({ secretEnv }), /invalid service.secretEnv/);
  }
  assert.throws(() => compile({ environment: { NODE_ENV: 'production' }, secretEnv: Array.from({ length: 128 }, (_, index) => reference(`VALUE_${index}`)) }), /at most 128/);
});

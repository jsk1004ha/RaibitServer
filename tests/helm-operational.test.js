import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { parseOperationalRuntimeConfig } from '../packages/core/src/operational-contract.ts';

const chart = 'infra/helm/raibitserver';
const productionFixture = `${chart}/ci-production-values.yaml`;
const defaults = YAML.parse(readFileSync(`${chart}/values.yaml`, 'utf8')).operational;
const helm = process.env.HELM_BIN || process.env.HELM_BINARY || 'helm';
const probe = spawnSync(helm, ['version', '--short'], { encoding: 'utf8', timeout: 30_000 });
const renderOptions = {
  skip: !process.env.HELM_BIN && !process.env.HELM_BINARY && probe.error?.code === 'ENOENT'
    ? 'Helm is unavailable; set HELM_BIN or HELM_BINARY to run render checks'
    : false,
};
const active = {
  enabled: true,
  implementationAvailable: true,
  protocolVersion: 2,
  contractDigest: 'a'.repeat(64),
  releaseRevision: 'b'.repeat(40),
  releaseSourceClean: true,
};
const disabledEnv = {
  RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '0',
  RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '0',
  RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '1',
  RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: '',
  RAIBITSERVER_RELEASE_REVISION: '',
  RAIBITSERVER_RELEASE_SOURCE_CLEAN: '0',
};
const activeEnv = {
  RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1',
  RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1',
  RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2',
  RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: active.contractDigest,
  RAIBITSERVER_RELEASE_REVISION: active.releaseRevision,
  RAIBITSERVER_RELEASE_SOURCE_CLEAN: '1',
};

function render(production = false, operational) {
  assert.equal(probe.status, 0, `Helm executable ${helm}: ${probe.stderr || probe.error || probe.stdout}`);
  return spawnSync(helm, ['template', 'raibitserver', chart, '--namespace', 'raibitserver-system',
    ...(production ? ['--values', productionFixture] : []),
    ...(operational ? ['--set-json', `operational=${JSON.stringify({ ...defaults, ...operational })}`] : []),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
}

function assertWorkloadEnvironment(result, expected) {
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const documents = YAML.parseAllDocuments(result.stdout).map((document) => {
    assert.deepEqual(document.errors, [], 'Helm output must be valid YAML');
    return document.toJSON();
  }).filter(Boolean);
  for (const component of ['api', 'orchestrator', 'provisioner', 'builder-dispatcher']) {
    const deployment = documents.find((document) => document.kind === 'Deployment'
      && document.metadata?.name === `raibitserver-${component}`);
    assert.ok(deployment, `missing trusted ${component} Deployment`);
    const container = deployment.spec.template.spec.containers.find((entry) => entry.name === component);
    assert.ok(container, `missing ${component} container`);
    if (component === 'orchestrator') {
      const key = container.env.find((entry) => entry.name === 'RAIBITSERVER_SECRET_ENCRYPTION_KEY');
      if (expected.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED === '1') {
        const api = documents.find((document) => document.kind === 'Deployment' && document.metadata?.name === 'raibitserver-api');
        const sharedSecret = api.spec.template.spec.containers[0].envFrom.find((entry) => entry.secretRef).secretRef.name;
        assert.deepEqual(key?.valueFrom, { secretKeyRef: { name: sharedSecret, key: 'RAIBITSERVER_SECRET_ENCRYPTION_KEY' } },
          'active template runtime requires the canonical API key without optional fallback');
      } else {
        assert.equal(key, undefined, 'disabled template runtime must not require an encryption key to start');
      }
      assert.equal(container.env.some((entry) => entry.name === 'ENCRYPTION_KEY'), false,
        'the chart must not reference the legacy key absent from the shared runtime Secret');
    }
    const entries = container.env.filter((entry) => Object.hasOwn(expected, entry.name));
    assert.equal(entries.length, 6, `${component} must receive each operational variable exactly once`);
    const environment = Object.fromEntries(entries.map(({ name, value }) => [name, value]));
    assert.deepEqual(environment, expected,
      `${component} operational values must be quoted strings and match the release configuration`);
    const runtime = parseOperationalRuntimeConfig(environment);
    assert.equal(runtime.productionActivation, expected.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED === '1');
    assert.equal(runtime.contractDigest, expected.RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST || null);
    assert.deepEqual(runtime.releaseIdentity, expected.RAIBITSERVER_RELEASE_REVISION
      ? { revision: expected.RAIBITSERVER_RELEASE_REVISION, clean: true }
      : null);
  }
  const executor = documents.find((document) => document.kind === 'CronJob'
    && document.metadata?.name === 'raibitserver-builder-executor');
  assert.ok(executor, 'render must include the tenant executor CronJob');
  const pod = executor.spec.jobTemplate.spec.template.spec;
  for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
    assert.deepEqual((container.env ?? []).filter((entry) => Object.hasOwn(expected, entry.name)), [],
      `tenant executor ${container.name} must not receive trusted operational metadata`);
  }
}

test('operational chart defaults and production fixture remain inactive on protocol 1', () => {
  const expected = {
    enabled: false, implementationAvailable: false, protocolVersion: 1,
    contractDigest: '', releaseRevision: '', releaseSourceClean: false,
  };
  assert.deepEqual(defaults, expected);
  const production = YAML.parse(readFileSync(productionFixture, 'utf8'));
  assert.deepEqual({ ...defaults, ...production.operational }, expected);
});

for (const production of [false, true]) {
  const mode = production ? 'production fixture' : 'default chart';
  test(`${mode} renders disabled operational metadata only into trusted workloads`, renderOptions, () => {
    assertWorkloadEnvironment(render(production), disabledEnv);
  });
  test(`${mode} renders complete activated metadata only into trusted workloads`, renderOptions, () => {
    assertWorkloadEnvironment(render(production, active), activeEnv);
  });
}

const invalidConfigurations = [
  ['missing implementation availability', { implementationAvailable: false }, /operational\.implementationAvailable=true/],
  ['protocol 1', { protocolVersion: 1 }, /operational\.protocolVersion=2/],
  ['protocol 3', { protocolVersion: 3 }, /operational\.protocolVersion=2/],
  ['prefixed digest', { contractDigest: `sha256:${active.contractDigest}` }, /operational\.contractDigest/],
  ['uppercase digest', { contractDigest: active.contractDigest.toUpperCase() }, /operational\.contractDigest/],
  ['short digest', { contractDigest: active.contractDigest.slice(1) }, /operational\.contractDigest/],
  ['short revision', { releaseRevision: active.releaseRevision.slice(1) }, /operational\.releaseRevision/],
  ['uppercase revision', { releaseRevision: active.releaseRevision.toUpperCase() }, /operational\.releaseRevision/],
  ['dirty release', { releaseSourceClean: false }, /operational\.releaseSourceClean=true/],
  ...['enabled', 'implementationAvailable', 'releaseSourceClean'].map((field) => [
    `string boolean ${field}`, { [field]: 'false' }, new RegExp(`operational\\.${field} must be a boolean`),
  ]),
];

for (const [name, override, diagnostic] of invalidConfigurations) {
  test(`operational activation rejects ${name}`, renderOptions, () => {
    const result = render(false, { ...active, ...override });
    assert.equal(result.error, undefined, `Helm invocation failed: ${result.error}`);
    assert.notEqual(result.status, 0, `Helm accepted ${name}`);
    assert.match(result.stderr, diagnostic, `Helm must reject ${name} for the operational configuration error`);
  });
}

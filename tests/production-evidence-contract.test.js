import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile, mkdir, cp, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { verifyManifest, REQUIRED_ASSERTIONS, MAX_RUN_AGE_MS } from '../scripts/production-evidence/lib/manifest.mjs';
import { componentSample, runComponent } from '../scripts/production-evidence/run-component.mjs';
import { createRun, writeFragment, verifyArtifacts } from '../scripts/production-evidence/lib/run.mjs';
import { preflight, parseOperatorInputs as ciParser } from '../scripts/production-evidence/preflight.mjs';
import { parseOperatorInputs, inputsFromEnvironment, loadOperatorContract, verifyApprovedSnapshot, digest, environmentFingerprint, assertRedacted, APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST } from '../scripts/production-evidence/lib/operator-inputs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contract = await loadOperatorContract();
const now = Date.parse('2026-09-02T10:00:00.000Z');
const sample = () => componentSample('resources', new Date(now).toISOString());
// Synthetic contract specimens, never captured as actual L3 execution evidence.
function fullManifest(profile = 'train-a') {
  const manifest = sample().manifest;
  manifest.fixture = false;
  manifest.profile = profile;
  manifest.preflight.status = 'PASS';
  manifest.fragments = ['local', 'cluster', 'lifecycle', 'resources', 'operations', ...(profile === 'final' ? ['domains'] : [])].map((component) => {
    const fragment = structuredClone(manifest.fragments[0]);
    fragment.component = component;
    fragment.level = component === 'local' ? 'L1' : component === 'cluster' ? 'L2' : 'L3';
    fragment.provenance = component === 'local' ? 'local' : component === 'cluster' ? 'kind' : 'credentialed';
    fragment.artifacts[0].path = `${component}.json`;
    fragment.assertions = REQUIRED_ASSERTIONS[component].map((id) => ({ id, status: 'PASS', artifactPaths: [`${component}.json`] }));
    fragment.cleanup.assertions[0].artifactPaths = [`${component}.json`];
    return fragment;
  });
  manifest.cleanup.assertions[0].artifactPaths = ['resources.json'];
  return manifest;
}
function operatorInputs() {
  const values = ['fixture-context', 'fixture-prefix', 'fixture.example', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
  return { schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: Object.fromEntries(contract.selectors.map(({ name }, index) => [name, values[index]])),
    secretRefs: contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
      ? { role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`, keys: Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key'] }
      : { role, binding, kind, namespace: 'fixture-system', secretKeyRef: { name: `fixture-${role}`, key: 'fixture-key', optional: false } }) };
}
async function sandbox(t) {
  const directory = await mkdtemp(path.join(process.env.RAIBITSERVER_TEST_EVIDENCE_ROOT ?? tmpdir(), 'task7-'));
  t.after(async () => { await rm(directory, { recursive: true }); });
  return directory;
}
function cli(args, cwd = root) { return spawnSync(process.execPath, [path.join(root, 'scripts/verify-production-evidence.mjs'), ...args], { cwd, encoding: 'utf8' }); }

for (const profile of ['train-a', 'final']) test(`Given complete synthetic ${profile} observations, When aggregating, Then contract eligibility is true`, () => {
  const result = verifyManifest(fullManifest(profile), { now });
  assert.equal(result.releaseEligible, true);
  assert.equal(result.manifestDigest.length, 64);
});
for (const component of ['resources', 'domains']) test(`Given a fresh ${component} fixture, When component verification runs, Then release is false`, () => {
  assert.deepEqual(verifyManifest(componentSample(component, new Date(now).toISOString()).manifest, { now }).releaseEligible, false);
  assert.equal(verifyManifest(fullManifest('final'), { now, fragment: component }).reason, 'component_only');
});
const mutations = [
  ['missing_fragment', (m) => { m.profile = 'final'; }],
  ['missing_fragment', (m) => { m.fragments.pop(); }],
  ['stale_state', (m) => { m.startedAt = new Date(now - MAX_RUN_AGE_MS - 1).toISOString(); }],
  ['stale_state', (m) => { m.observedAt = new Date(now + 1).toISOString(); }],
  ['not_run', (m) => { m.fragments[2].status = 'NOT_RUN'; }],
  ['assertion_failed', (m) => { m.fragments[2].assertions[0].status = 'FAIL'; }],
  ['cleanup_failed', (m) => { m.cleanup.status = 'NOT_RUN'; }],
  ['cleanup_failed', (m) => { m.fragments[2].cleanup.status = 'FAIL'; }],
  ['cleanup_failed', (m) => { m.cleanup.assertions[0].status = 'FAIL'; }],
  ['cleanup_failed', (m) => { m.fragments[2].cleanup.assertions[0].status = 'NOT_RUN'; }],
  ['missing_credentials', (m) => { m.preflight.status = 'NOT_RUN'; }],
  ['missing_approved_input', (m) => { delete m.identity.approvedInputSha256; }],
  ['approved_input_digest_mismatch', (m) => { m.identity.approvedInputSha256 = 'A'.repeat(64); }],
  ['operator_contract_digest_mismatch', (m) => { m.identity.operatorContractDigest = 'a'.repeat(64); }],
  ['misleading_success_output', (m) => { m.releaseEligible = true; }],
  ['redaction', (m) => { m.note = 'password=do-not-log-this'; }],
  ['level_mismatch', (m) => { m.fragments[2].level = 'L1'; }],
  ['level_mismatch', (m) => { m.fragments[2].provenance = 'kind'; }],
  ['reused_fragment', (m) => { m.fragments.push(m.fragments[0]); }],
  ['missing_assertion', (m) => { m.fragments[2].assertions.pop(); }],
  ['missing_artifact', (m) => { m.fragments[2].assertions[0].artifactPaths = ['absent.json']; }],
  ['fixture_not_release_evidence', (m) => { m.fixture = true; for (const f of m.fragments) f.provenance = 'fixture'; }],
];
for (const field of ['runId', 'environmentFingerprint', 'sourceCommitSha', 'migrationDigest', 'operatorInputFingerprint', 'organizationId', 'projectId', 'serviceId', 'deploymentId', 'resourceId']) {
  mutations.push(['identity_mismatch', (m) => { m.fragments[2].identity[field] = field === 'runId' ? 'e22c8e21-c069-44e6-a609-7fb140c52348' : field === 'sourceCommitSha' ? 'a'.repeat(40) : field.endsWith('Id') ? 'other-tenant' : 'a'.repeat(64); }]);
}
for (const [index, [reason, mutate]] of mutations.entries()) test(`Given ${reason} mutation ${index}, When verifying, Then fail closed`, () => {
  const manifest = fullManifest();
  mutate(manifest);
  const result = verifyManifest(manifest, { now });
  assert.equal(result.releaseEligible, false);
  assert.equal(result.reason, reason);
});
test('Given exact operator selectors and references, When local and CI parse, Then the same normalized contract is returned', () => {
  assert.equal(ciParser, parseOperatorInputs);
  assert.deepEqual(ciParser(operatorInputs(), contract), parseOperatorInputs(operatorInputs(), contract));
  assert.equal(contract.selectors.length, 8);
});
test('Given operator environment, When normalized, Then only exact selector names are read and no environment dump is retained', () => {
  const input = operatorInputs();
  const normalized = inputsFromEnvironment({ ...input.selectors, UNRELATED_SECRET: 'excluded' }, input.secretRefs, contract);
  assert.deepEqual(normalized, input); assert.equal(JSON.stringify(normalized).includes('excluded'), false);
});
test('Given committed operator contract, When existing Helm bindings are compared, Then default key names match actual values', async () => {
  const values = parseYaml(await readFile(path.join(root, 'infra/helm/raibitserver/values.yaml'), 'utf8'));
  for (const binding of contract.secretBindings) {
    if (binding.kind === 'worker-secretKeyRef') { assert.equal(binding.availability, 'planned-worker-binding'); continue; }
    const actual = binding.binding.split('.').reduce((value, key) => value[key], values);
    assert.equal(typeof actual.existingSecret, 'string');
    for (const [field, key] of Object.entries(binding.keyFields)) assert.equal(actual[field], key);
  }
});
test('Given an approved snapshot location, When parity is requested, Then its bytes must match before parsing', async () => {
  if (process.env.RAIBITSERVER_APPROVED_INPUT_PATH) assert.deepEqual(await verifyApprovedSnapshot(process.env.RAIBITSERVER_APPROVED_INPUT_PATH), contract);
  else assert.equal(digest(contract), OPERATOR_CONTRACT_DIGEST);
});
for (const change of [v => { delete v.selectors[contract.selectors[0].name]; }, v => { v.selectors.RAIBITSERVER_RELEASE_UNKNOWN = 'x'; }, v => { v.secretRefs.pop(); }, v => { v.secretRefs[0].data = 'forbidden'; }]) test('Given missing or invalid operator bindings, When preflight runs, Then no Secret is accessed', async () => {
  const input = operatorInputs(); change(input); let calls = 0;
  const result = await preflight(input, { inspectSecretReference: () => { calls++; return {}; } });
  assert.equal(result.status, 'NOT_RUN'); assert.equal(calls, 0);
});
for (const drift of [false, true]) test(`Given ${drift ? 'drifted' : 'missing'} approved input, When preflight runs, Then Secret access is zero`, async (t) => {
  const directory = await sandbox(t), file = path.join(directory, 'input.md');
  if (drift) await writeFile(file, 'unapproved bytes');
  let calls = 0;
  const result = await preflight(operatorInputs(), { approvedInputPath: file, inspectSecretReference: () => { calls++; return {}; } });
  assert.equal(result.reason, drift ? 'approved_input_digest_mismatch' : 'missing_approved_input'); assert.equal(calls, 0);
});
test('Given metadata-only reference availability, When preflight succeeds, Then no selector values enter its receipt', async () => {
  const result = await preflight(operatorInputs(), { inspectSecretReference: async () => ({ available: true, keysPresent: true, uid: 'fixture-uid' }) });
  assert.equal(result.status, 'PASS');
  assert.equal(JSON.stringify(result).includes('fixture-context'), false);
});
test('Given absent Secret adapter, When preflight runs, Then credentials are NOT_RUN', async () => { assert.equal((await preflight(operatorInputs())).reason, 'missing_credentials'); });
test('Given an explicitly empty approval path, When preflight runs, Then no fallback permits Secret access', async () => {
  let calls = 0;
  const result = await preflight(operatorInputs(), { approvedInputPath: '', inspectSecretReference: () => { calls++; return { available: true, uid: 'fixture-uid', keysPresent: true }; } });
  assert.equal(result.status, 'NOT_RUN'); assert.equal(calls, 0);
});
test('Given a metadata field change, When fingerprinted, Then environment identity changes', () => {
  const value = { clusterUid: 'cluster-one', apiServer: 'https://api.example', baseDomain: 'apps.example', registryHost: 'registry.example', namespacePrefix: 'run' };
  assert.notEqual(environmentFingerprint(value), environmentFingerprint({ ...value, clusterUid: 'cluster-two' }));
  assert.equal(environmentFingerprint(value), environmentFingerprint(Object.fromEntries(Object.entries(value).reverse())));
});
test('Given a used directory and fragment, When reused, Then both writes are rejected', async (t) => {
  const parent = await sandbox(t), { manifest } = componentSample('resources');
  const directory = await createRun(parent, manifest.identity, manifest.startedAt);
  await assert.rejects(createRun(parent, manifest.identity, manifest.startedAt), { reason: 'reused_directory' });
  await writeFragment(directory, manifest.fragments[0]);
  await assert.rejects(writeFragment(directory, manifest.fragments[0]), { reason: 'reused_fragment' });
});
test('Given an expired attempt, When creating a run, Then creation fails closed', async (t) => {
  const parent = await sandbox(t), { manifest } = componentSample('resources');
  await assert.rejects(createRun(parent, manifest.identity, new Date(Date.now() - MAX_RUN_AGE_MS - 1).toISOString()), { reason: 'stale_state' });
});
test('Given fresh physical component evidence, When CLI runs outside .omo, Then component PASS never becomes release PASS', async (t) => {
  const directory = await sandbox(t), { manifest, artifact } = componentSample('resources');
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest)); await writeFile(path.join(directory, 'assertions.json'), artifact);
  const result = cli([path.join(directory, 'manifest.json')], directory);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).releaseEligible, false);
  assert.equal(existsSync(path.join(directory, '.omo')), false);
});
test('Given missing or altered artifacts, When verifying physical evidence, Then hashes cannot be asserted by declaration', async (t) => {
  const directory = await sandbox(t), { manifest } = componentSample('resources');
  await assert.rejects(verifyArtifacts(directory, manifest), { reason: 'missing_artifact' });
  await writeFile(path.join(directory, 'assertions.json'), 'altered');
  await assert.rejects(verifyArtifacts(directory, manifest), { reason: 'artifact_digest_mismatch' });
});
test('Given identity mismatch, When the CLI runs, Then stdout is empty and stderr contains only the typed reason', async (t) => {
  const directory = await sandbox(t), manifest = fullManifest(); manifest.fragments[0].identity.projectId = 'other';
  const file = path.join(directory, 'manifest.json'); await writeFile(file, JSON.stringify(manifest));
  const result = cli([file]); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'identity_mismatch');
});
test('Given no live credentials, When a component scaffold executes, Then NOT_RUN and cleanup are persisted', async (t) => {
  const parent = await sandbox(t), { manifest } = componentSample('resources');
  const result = await runComponent({ parent, identity: manifest.identity, component: 'resources', inputs: operatorInputs() });
  assert.equal(result.status, 'NOT_RUN'); assert.equal(result.releaseEligible, false);
  const fragment = JSON.parse(await readFile(path.join(parent, manifest.identity.runId, 'resources.json'), 'utf8'));
  assert.equal(fragment.cleanup.status, 'PASS'); assert.equal(fragment.status, 'NOT_RUN');
});
test('Given secret-looking artifact payloads, When redaction is checked, Then raw data is rejected', () => {
  for (const value of ['Bearer abc123', 'postgresql://name:password@db.example', '{"stringData":{"key":"x"}}', '{"password":"do-not-log"}', '{"api_key":"do-not-log"}', '-----BEGIN PRIVATE KEY-----']) assert.throws(() => assertRedacted(value), { reason: 'redaction' });
});
for (const [reason, mutate] of mutations.slice(0, 22)) test(`Given ${reason} in a physical manifest, When the public CLI runs, Then no success output escapes`, async (t) => {
  const directory = await sandbox(t), manifest = fullManifest(); mutate(manifest);
  // Keep timestamp mutation scenarios intact; freshen the other generated cases.
  if (reason !== 'stale_state') { manifest.startedAt = manifest.observedAt = new Date().toISOString(); for (const fragment of manifest.fragments) fragment.startedAt = fragment.observedAt = manifest.startedAt; }
  else if (Date.parse(manifest.observedAt) > now) manifest.observedAt = new Date(Date.now() + 60_000).toISOString();
  else manifest.startedAt = new Date(Date.now() - MAX_RUN_AGE_MS - 60_000).toISOString();
  const file = path.join(directory, 'manifest.json'); await writeFile(file, JSON.stringify(manifest));
  const result = cli([file]);
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), reason);
});
test('Given only committed runtime files, When preflight runs in a copied tree without .omo, Then contract verification succeeds', async (t) => {
  const directory = await sandbox(t);
  for (const relative of ['scripts/production-evidence', 'packages/schemas/src/production-evidence.ts', 'test-fixtures/contracts/operator-inputs-v1.json']) {
    const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(root, relative), target, { recursive: true });
  }
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await symlink(await realpath(path.join(root, 'packages/schemas/node_modules')), path.join(directory, 'packages/schemas/node_modules'), 'junction');
  const result = spawnSync(process.execPath, ['scripts/production-evidence/preflight.mjs', '--contract'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).operatorContractDigest, OPERATOR_CONTRACT_DIGEST);
  assert.equal(existsSync(path.join(directory, '.omo')), false);
});

test('Given an incomplete L1 run, When aggregated, Then release eligibility is explicitly false', async () => {
  const implementation = existsSync('scripts/production-evidence/lib/manifest.mjs')
    ? await import('../scripts/production-evidence/lib/manifest.mjs') : {};
  const result = implementation.verifyManifest?.({ schema: 'raibitserver.production-evidence/v1', profile: 'train-a', fragments: [] });
  assert.equal(result?.releaseEligible, false, 'missing fail-closed aggregation contract');
});

test('Given absent evidence, When the public verifier runs, Then only a typed failure is emitted', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-production-evidence.mjs', 'absent-manifest.json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'missing_manifest');
});

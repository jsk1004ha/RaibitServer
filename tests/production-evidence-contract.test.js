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
import resourceCapabilities from '../packages/schemas/src/resource-capabilities-v1.json' with { type: 'json' };
import { bindingJournalVerification, releaseBindings, synchronizeJournal } from './fixtures/production-evidence/bindings-v1.mjs';
import { createUnsafeFixtureArtifactWriter } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), contract = await loadOperatorContract(), now = Date.parse('2026-09-02T10:00:00.000Z');
const identityKeys = ['runId', 'environmentFingerprint', 'sourceCommitSha', 'migrationDigest', 'approvedInputSha256', 'operatorContractDigest', 'operatorInputFingerprint'], capabilitySnapshot = { schema: 'raibitserver.resource-capability-snapshot/v1', canonicalDigest: digest(resourceCapabilities), requiredEngines: resourceCapabilities.engines.filter(({ runtime }) => runtime === 'dedicated-local').map(({ engine }) => engine) };
function sample(observedAt = new Date(now).toISOString()) {
  const result = componentSample('resources', observedAt); result.manifest.identity = Object.fromEntries(Object.entries(result.manifest.identity).filter(([key]) => identityKeys.includes(key)));
  result.manifest.fragments[0].identity = structuredClone(result.manifest.identity); return result;
}
// Synthetic contract specimens, never captured as actual L3 execution evidence.
function fullManifest(profile = 'train-a') {
  const manifest = sample().manifest; manifest.fixture = false; manifest.profile = profile;
  manifest.preflight.status = 'PASS'; manifest.capabilitySnapshot = structuredClone(capabilitySnapshot);
  manifest.bindingsDigest = digest(releaseBindings);
  manifest.bindingJournal = { schema: 'raibitserver.production-evidence-binding-journal-snapshot/v1',
    runIdentitySha256: digest(manifest.identity), entriesSha256: 'd'.repeat(64), entryCount: releaseBindings.length + 3 };
  manifest.fragments = ['local', 'cluster', 'lifecycle', 'resources', 'operations', ...(profile === 'final' ? ['domains'] : [])].map((component) => {
    const fragment = structuredClone(manifest.fragments[0]);
    fragment.component = component;
    fragment.level = component === 'local' ? 'L1' : component === 'cluster' ? 'L2' : 'L3';
    fragment.provenance = component === 'local' ? 'local' : component === 'cluster' ? 'kind' : 'credentialed';
    fragment.artifacts[0].path = `${component}.json`;
    fragment.assertions = REQUIRED_ASSERTIONS[component].map((id) => ({ id, status: 'PASS', artifactPaths: [`${component}.json`] }));
    fragment.cleanup.assertions[0].artifactPaths = [`${component}.json`];
    fragment.bindingsDigest = manifest.bindingsDigest;
    return fragment;
  });
  manifest.cleanup.assertions[0].artifactPaths = ['resources.json'];
  return manifest;
}
async function verified(t, manifest, journal = bindingJournalVerification(manifest, digest), options = {}) {
  const parent = await sandbox(t);
  const runDirectory = path.join(parent, manifest.identity.runId);
  await mkdir(runDirectory);
  await writeFile(path.join(runDirectory, 'run.json'), JSON.stringify({ schema: 'raibitserver.evidence-run/v1', identity: manifest.identity,
    startedAt: manifest.startedAt }), { flag: 'wx' });
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory,
    allowedPaths: (relative) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(relative) });
  t.after(() => writer.close());
  const authority = await createJournalAuthorityFixtureUnsafe({ runDirectory, identity: manifest.identity, genuineSafeWriter: writer });
  const payloads = [...journal.entries, ...journal.observations];
  for (const [index, payload] of payloads.entries()) await authority.appendBinding({
    role: payload.kind,
    bindingId: `entry-${index}`,
    payload,
    createdAt: new Date(Date.parse(manifest.startedAt) + (index + 1) * 1000).toISOString(),
  });
  const verifiedBindingJournal = await authority.verifyBindingJournal();
  manifest.bindingJournal = structuredClone(verifiedBindingJournal.journal);
  manifest.bindingsDigest = verifiedBindingJournal.bindingsDigest;
  for (const fragment of manifest.fragments) fragment.bindingsDigest = manifest.bindingsDigest;
  return { now, journalAuthority: authority, verifiedBindingJournal, ...options };
}
const previewObservation = (journal) => journal.observations.find(({ kind }) => kind === 'github-pull-request-observation');
const previewEvent = (journal) => journal.entries.find(({ kind }) => kind === 'github-webhook-event');
function operatorInputs() {
  const values = ['fixture-context', 'fixture-prefix', 'fixture.example', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
  return { schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    selectors: Object.fromEntries(contract.selectors.map(({ name }, index) => [name, values[index]])), secretRefs: contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
      ? { role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`, keys: Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key'] } : { role, binding, kind, namespace: 'fixture-system', secretKeyRef: { name: `fixture-${role}`, key: 'fixture-key', optional: false } }) };
}
async function sandbox(t) {
  const directory = await mkdtemp(path.join(process.env.RAIBITSERVER_TEST_EVIDENCE_ROOT ?? tmpdir(), 'task7-')); t.after(async () => { await rm(directory, { recursive: true }); }); return directory;
}
function cli(args, cwd = root) { return spawnSync(process.execPath, [path.join(root, 'scripts/verify-production-evidence.mjs'), ...args], { cwd, encoding: 'utf8' }); }

for (const profile of ['train-a', 'final']) test(`Given a GitHub PR webhook-backed preview and current unverified canonical capabilities for ${profile}, When aggregating, Then release stays NOT_RUN`, async (t) => {
  const manifest = fullManifest(profile), result = verifyManifest(manifest, await verified(t, manifest));
  assert.equal(result.releaseEligible, false); assert.equal(result.reason, 'release_capability_not_verified'); });
for (const component of ['resources', 'domains']) test(`Given a fresh ${component} fixture, When component verification runs, Then release is false`, () => {
  assert.deepEqual(verifyManifest(componentSample(component, new Date(now).toISOString()).manifest, { now }).releaseEligible, false);
  assert.equal(verifyManifest(fullManifest('final'), { now, fragment: component }).reason, 'component_only'); });
for (const profile of ['component', 'train-a', 'final']) for (const kind of [undefined, 'full']) test(`Given ${profile} resources scope=${kind}, When backup proof is missing, Then the full contract is preserved`, () => {
  const manifest = profile === 'component' ? sample().manifest : fullManifest(profile), fragment = manifest.fragments.find(item => item.component === 'resources'); if (kind) fragment.resourceScope = { kind };
  fragment.assertions = fragment.assertions.filter(item => item.id !== 'backup_checksum');
  assert.equal(verifyManifest(manifest, { now, fragment: 'resources' }).reason, 'missing_assertion');
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
for (const field of identityKeys.filter((field) => field !== 'approvedInputSha256')) mutations.push(['identity_mismatch', (m) => { m.fragments[2].identity[field] = field === 'runId' ? 'e22c8e21-c069-44e6-a609-7fb140c52348' : field === 'sourceCommitSha' ? 'a'.repeat(40) : 'a'.repeat(64); }]);
test('Given immutable run identity, When tenant identifiers are embedded, Then the schema rejects them', () => {
  const manifest = fullManifest(); manifest.identity.projectId = 'ambient-project'; assert.equal(verifyManifest(manifest, { now }).reason, 'invalid_schema');
});
test('Given verified-looking request JSON, When no physical verifier capability is supplied, Then journal evidence is rejected', () => { const manifest = fullManifest(), bindingJournal = bindingJournalVerification(manifest, digest); assert.equal(verifyManifest(manifest, { now, bindingJournal }).reason, 'missing_binding_journal'); });
test('Given a forged verifier callback and authority-shaped object, When full evidence is verified, Then neither can mint journal provenance', () => {
  const manifest = fullManifest();
  const forged = bindingJournalVerification(manifest, digest);
  assert.equal(verifyManifest(manifest, { now, verifyBindingJournal: () => forged, journalAuthority: {},
    verifiedBindingJournal: forged }).reason, 'invalid_binding_journal');
});
test('Given a genuine authority but a cloned verified snapshot, When full evidence is verified, Then the private brand rejects it', async (t) => {
  const manifest = fullManifest();
  const options = await verified(t, manifest);
  assert.equal(verifyManifest(manifest, { ...options,
    verifiedBindingJournal: structuredClone(options.verifiedBindingJournal) }).reason, 'invalid_binding_journal');
});
for (const [reason, mutate, options, scenario, manifestOnly] of [
  ['binding_journal_mismatch', (m) => { m.bindingsDigest = 'a'.repeat(64); }, undefined, undefined, true],
  ['binding_journal_mismatch', (m) => { m.fragments[0].bindingsDigest = 'a'.repeat(64); }, undefined, undefined, true],
  ['missing_binding_journal', (m) => { delete m.bindingJournal; delete m.bindingsDigest; for (const fragment of m.fragments) delete fragment.bindingsDigest; }, undefined, undefined, true],
  ['tenant_revision_mismatch', (m, j) => { j.entries.find((binding) => binding.kind === 'tenant-revision').tenantCommitSha = m.identity.sourceCommitSha; synchronizeJournal(m, j, digest); }],
  ['duplicate_binding', (m, j) => { j.entries.push(structuredClone(j.entries[0])); synchronizeJournal(m, j, digest); }],
  ['binding_reassigned', (m, j) => { const project = j.entries.find((binding) => binding.kind === 'project'); j.entries.push({ ...project, organizationId: 'org-2' }); synchronizeJournal(m, j, digest); }],
  ['binding_graph_mismatch', (m, j) => { j.entries.find((binding) => binding.kind === 'service').projectId = 'other-project'; synchronizeJournal(m, j, digest); }],
  ['binding_graph_mismatch', () => {}, { repository: 'other/repository' }],
  ['binding_graph_mismatch', (m, j) => { j.entries.find((binding) => binding.kind === 'deployment' && binding.role === 'failed').tenantCommitSha = '3'.repeat(40); synchronizeJournal(m, j, digest); }],
  ['binding_graph_mismatch', (m, j) => { const candidate = j.entries.find((binding) => binding.kind === 'tenant-revision' && binding.purpose === 'candidate'), preview = j.entries.find((binding) => binding.kind === 'deployment' && binding.role === 'preview'); Object.assign(preview, { tenantRevisionId: candidate.tenantRevisionId, tenantCommitSha: candidate.tenantCommitSha, branch: candidate.branch }); synchronizeJournal(m, j, digest); }, undefined, 'preview deployment reusing the production candidate'],
  ['invalid_binding_journal', (_m, j) => { j.entries.find((binding) => binding.kind === 'tenant-revision').controlled = true; }],
  ['missing_binding_provenance', (_m, j) => { j.observations = j.observations.filter(({ kind }) => kind !== 'github-pull-request-observation'); }, undefined, 'raw preview revision without PR webhook provenance'],
  ['invalid_binding_journal', (_m, j) => { previewObservation(j).event.deliveryId = previewEvent(j).deliveryId = 'delivery-preview-1'; }, undefined, 'malformed GitHub delivery identity'],
  ['webhook_delivery_replayed', (m, j) => { const replay = structuredClone(previewObservation(j)); Object.assign(replay, { observationId: 'observation-preview-replay', receiptPath: 'artifacts/lifecycle/preview-replay.json', artifactPath: 'artifacts/lifecycle/preview-replay-observation.json' }); j.observations.push(replay); }, undefined, 'replayed GitHub delivery observation'],
  ['webhook_delivery_replayed', (m, j) => { j.entries.push({ ...previewEvent(j), webhookEventId: 'c222222222222222222222222' }); synchronizeJournal(m, j, digest); }, undefined, 'duplicate persisted GitHub delivery'],
  ['binding_provenance_mismatch', (_m, j) => { previewObservation(j).event.installationId = '901'; }, undefined, 'preview webhook from a foreign installation'],
  ['invalid_binding_journal', (_m, j) => { previewObservation(j).event.repository = 'foreign/repository'; }, undefined, 'preview webhook for a foreign repository'],
  ['binding_provenance_mismatch', (_m, j) => { previewObservation(j).event.pullRequestNumber = 15; }, undefined, 'preview webhook for a foreign pull request'],
  ['invalid_binding_journal', (_m, j) => { previewObservation(j).event.headSha = '4'.repeat(40); }, undefined, 'preview webhook with a foreign head SHA'],
  ['invalid_binding_journal', (_m, j) => { previewObservation(j).event.headRef = 'foreign/ref'; }, undefined, 'preview webhook with a foreign head ref'],
  ['invalid_binding_journal', (_m, j) => { previewObservation(j).event.signatureVerified = true; }, undefined, 'raw signatureVerified self-attestation'],
  ['binding_provenance_mismatch', (_m, j) => { j.observations[0].identityDigest = 'a'.repeat(64); }],
  ['binding_provenance_mismatch', (_m, j) => { j.observations[0].repository = 'foreign/repository'; }],
  ['capability_snapshot_mismatch', (m) => { m.capabilitySnapshot.canonicalDigest = 'a'.repeat(64); }, undefined, undefined, true],
  ['capability_snapshot_mismatch', (m) => { m.capabilitySnapshot.requiredEngines.push('forged-engine'); }, undefined, undefined, true],
]) test(`Given ${scenario ?? reason}, When full release evidence is verified, Then it fails closed`, async (t) => {
  const manifest = fullManifest(), journal = bindingJournalVerification(manifest, digest);
  if (!manifestOnly) mutate(manifest, journal);
  let verificationOptions;
  try { verificationOptions = await verified(t, manifest, journal, options); }
  catch (error) {
    assert.equal(reason, 'invalid_binding_journal');
    assert.equal(error.reason, 'invalid_journal');
    return;
  }
  if (manifestOnly) mutate(manifest, journal);
  assert.equal(verifyManifest(manifest, verificationOptions).reason, reason);
});
for (const [index, [reason, mutate]] of mutations.entries()) test(`Given ${reason} mutation ${index}, When verifying, Then fail closed`, async (t) => {
  const manifest = fullManifest();
  const verificationOptions = await verified(t, manifest);
  mutate(manifest);
  const result = verifyManifest(manifest, verificationOptions); assert.equal(result.releaseEligible, false); assert.equal(result.reason, reason);
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
  const parent = await sandbox(t), { manifest } = sample(new Date().toISOString());
  const directory = await createRun(parent, manifest.identity, manifest.startedAt);
  await assert.rejects(createRun(parent, manifest.identity, manifest.startedAt), { reason: 'reused_directory' });
  await writeFragment(directory, manifest.fragments[0]);
  await assert.rejects(writeFragment(directory, manifest.fragments[0]), { reason: 'reused_fragment' });
});
test('Given an expired attempt, When creating a run, Then creation fails closed', async (t) => {
  const parent = await sandbox(t), { manifest } = sample();
  await assert.rejects(createRun(parent, manifest.identity, new Date(Date.now() - MAX_RUN_AGE_MS - 1).toISOString()), { reason: 'stale_state' });
});
test('Given fresh physical component evidence, When CLI runs outside .omo, Then component PASS never becomes release PASS', async (t) => {
  const directory = await sandbox(t), { manifest, artifact } = sample(new Date().toISOString());
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest)); await writeFile(path.join(directory, 'assertions.json'), artifact);
  const result = cli([path.join(directory, 'manifest.json')], directory);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).releaseEligible, false);
  assert.equal(existsSync(path.join(directory, '.omo')), false);
});
test('Given missing or altered artifacts, When verifying physical evidence, Then hashes cannot be asserted by declaration', async (t) => {
  const directory = await sandbox(t), { manifest } = sample();
  await assert.rejects(verifyArtifacts(directory, manifest), { reason: 'missing_artifact' });
  await writeFile(path.join(directory, 'assertions.json'), 'altered');
  await assert.rejects(verifyArtifacts(directory, manifest), { reason: 'artifact_digest_mismatch' });
});
test('Given identity mismatch, When the CLI runs, Then stdout is empty and stderr contains only the typed reason', async (t) => {
  const directory = await sandbox(t), manifest = fullManifest(); manifest.fragments[0].identity.environmentFingerprint = 'a'.repeat(64);
  const file = path.join(directory, 'manifest.json'); await writeFile(file, JSON.stringify(manifest));
  const result = cli([file]); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), process.platform === 'win32' ? 'receipt_platform_not_release_safe' : 'receipt_authority_unavailable');
});
test('Given a direct component scaffold call, Then execution is forbidden before attempt I/O', async (t) => {
  const parent = await sandbox(t), { manifest } = sample();
  await assert.rejects(runComponent({ parent, identity: manifest.identity, component: 'resources', inputs: operatorInputs() }),
    { reason: 'direct_component_execution_forbidden' });
  assert.equal(existsSync(path.join(parent, manifest.identity.runId)), false);
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
  const requiresJournalIntegration = ['not_run', 'assertion_failed', 'cleanup_failed', 'missing_credentials', 'level_mismatch', 'missing_assertion', 'missing_artifact', 'fixture_not_release_evidence'].includes(reason); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), !manifest.fixture ? process.platform === 'win32' ? 'receipt_platform_not_release_safe' : 'receipt_authority_unavailable'
    : requiresJournalIntegration ? 'missing_binding_journal' : reason);
});
test('Given only committed runtime files, When preflight runs in a copied tree without .omo, Then contract verification succeeds', async (t) => {
  const directory = await sandbox(t);
  for (const relative of ['scripts/production-evidence', 'packages/schemas/src/production-evidence.ts', 'packages/schemas/src/preview.ts', 'packages/schemas/src/resource-lifecycle-evidence.ts', 'test-fixtures/contracts/operator-inputs-v1.json']) {
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

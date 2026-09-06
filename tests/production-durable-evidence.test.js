import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as authority from '../scripts/production-evidence/lib/receipt-authority.mjs';
import { createJournalAuthorityFixtureUnsafe } from '../scripts/production-evidence/lib/journal-authority.mjs';
import { createUnsafeFixtureArtifactWriter } from '../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { createRun } from '../scripts/production-evidence/lib/run.mjs';
import { assembleManifest } from '../scripts/production-evidence/lib/manifest.mjs';
import { digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { STEP_NAMES } from '../scripts/production-evidence/lib/step-contract.mjs';
import { assertDurableReceiptProof, sealProductionEvidence, sealFixtureEvidenceUnsafe, verifyDurableEvidenceFixtureUnsafe } from '../scripts/production-evidence/lib/durable-receipt-authority.mjs';
import capabilities from '../packages/schemas/src/resource-capabilities-v1.json' with { type: 'json' };
import { generated, identity, INPUTS } from './fixtures/receipt-authority-fixture.mjs';

const execFileAsync = promisify(execFile);
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1', publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

async function fixture(t, { complete = true } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-durable-')), runIdentity = identity(), base = Date.now() - 11 * 60_000;
  const startedAt = new Date(base).toISOString(), observedAt = new Date(base + 10 * 60_000).toISOString();
  const runDirectory = await createRun(parent, runIdentity, startedAt);
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: relative => /^[a-z0-9][a-z0-9_./-]*$/.test(relative) });
  t.after(async () => { await writer.close(); await rm(parent, { recursive: true, force: true }); });
  const journalAuthority = await createJournalAuthorityFixtureUnsafe({ runDirectory, identity: runIdentity, genuineSafeWriter: writer });
  const receiptAuthority = await authority.createReceiptAuthorityFixtureUnsafe({ runDirectory, identity: runIdentity, genuineSafeWriter: writer,
    fullOperatorInput: INPUTS, journalAuthority, stateProjector: () => ({ cleanupNamespace: 'fixture-run' }) });
  const result = { parent, runDirectory, runIdentity, writer, journalAuthority, receiptAuthority, startedAt, observedAt, ...pair() };
  if (!complete) return result;
  const steps = [];
  for (const [index, step] of STEP_NAMES.entries()) {
    const stepAt = new Date(base + index * 60_000).toISOString();
    const prepared = await receiptAuthority.prepareStep(step, { startedAt: stepAt, deadlineAt: new Date(Date.parse(stepAt) + 30_000).toISOString() });
    const candidate = await receiptAuthority.executePreparedStep(prepared, async execution => {
      const receipt = generated(execution), artifacts = [];
      for (const [index, artifact] of receipt.artifacts.entries()) artifacts.push(await writer.writeJson(artifact.path,
        { schema: 'raibitserver.production-evidence-observation/v1', step, assertion: receipt.assertions[index].id, status: 'PASS', fixture: true }));
      return { schema: 'raibitserver.production-evidence-step-receipt/v2', step, requestSha256: execution.requestSha256,
        identity: runIdentity, startedAt: execution.request.startedAt, ...receipt, artifacts, redacted: true };
    });
    steps.push(await receiptAuthority.commitCandidate(prepared, candidate));
  }
  const foundations = {};
  for (const component of ['local', 'cluster']) foundations[component] = { assertion: component === 'local' ? 'local_checks' : 'kind_helm_reconciliation', status: 'PASS',
    artifact: await writer.writeJson(`artifacts/${component}/checks.json`, { component, fixture: true, status: 'PASS' }) };
  const componentArtifacts = {};
  for (const component of ['local', 'cluster', 'lifecycle', 'resources', 'operations']) componentArtifacts[component] = await writer.writeJson(`cleanup/${component}.json`,
    { schema: 'raibitserver.production-evidence-component-cleanup/v1', component, identity: runIdentity, startedAt, observedAt, status: 'PASS', reason: null,
      assertions: [{ id: 'component_cleanup', status: 'PASS' }], redacted: true, fixture: true });
  const runArtifact = await writer.writeJson('cleanup/run.json', { schema: 'raibitserver.production-evidence-run-cleanup/v1', identity: runIdentity,
    startedAt, observedAt, status: 'PASS', reason: null, assertions: [{ id: 'run_cleanup', status: 'PASS' }], redacted: true, fixture: true });
  const manifest = assembleManifest({ identity: runIdentity, startedAt, observedAt, fixture: true, foundations, steps,
    preflight: { status: 'PASS', approvedInputSha256: runIdentity.approvedInputSha256, operatorContractDigest: runIdentity.operatorContractDigest, operatorInputFingerprint: runIdentity.operatorInputFingerprint },
    capabilitySnapshot: { schema: 'raibitserver.resource-capability-snapshot/v1', canonicalDigest: digest(capabilities), requiredEngines: capabilities.engines.filter(value => value.runtime === 'dedicated-local').map(value => value.engine) },
    cleanup: { status: 'PASS', componentArtifacts, stepDescriptor: steps.at(-1).descriptor, runArtifact } });
  for (const fragment of manifest.fragments) await writer.writeJson(`${fragment.component}.json`, fragment);
  await writer.writeJson('manifest.json', manifest);
  return { ...result, manifest, manifestPath: path.join(runDirectory, 'manifest.json') };
}

const seal = value => sealFixtureEvidenceUnsafe({ receiptAuthority: value.receiptAuthority, journalAuthority: value.journalAuthority,
  privateKey: value.privateKey, publicKey: value.publicKey, now: Date.now() });
const verifyFixture = (value, overrides = {}) => verifyDurableEvidenceFixtureUnsafe(value.manifestPath,
  { expectedIdentity: value.runIdentity, publicKey: value.publicKey, ...overrides });

test('Given saved caller JSON, When durable sealing scope is requested, Then only genuine receipt authority is accepted', async () => {
  assert.equal(typeof authority.receiptAuthoritySealContext, 'function');
  await assert.rejects(authority.receiptAuthoritySealContext({ snapshot: async () => ({ entryCount: 10 }) }), { reason: 'invalid_receipt_authority' });
});

test('Given incomplete genuine receipts, When sealing is requested, Then completion cannot be fabricated', async t => {
  const value = await fixture(t, { complete: false });
  await assert.rejects(seal(value), { reason: 'incomplete_receipt_authority' });
});

test('Given committed fixture receipts, When sealed and verified in a fresh process, Then physical integrity passes but release eligibility stays false', async t => {
  const value = await fixture(t); await seal(value);
  const config = path.join(value.parent, 'expected.json'); await writeFile(config, JSON.stringify({ expectedIdentity: value.runIdentity, publicKey: value.publicKey }));
  const moduleUrl = new URL('../scripts/production-evidence/lib/durable-receipt-authority.mjs', import.meta.url).href;
  const program = `import { readFile } from 'node:fs/promises'; import { verifyDurableEvidenceFixtureUnsafe } from ${JSON.stringify(moduleUrl)}; const options = JSON.parse(await readFile(process.argv[2], 'utf8')); process.stdout.write(JSON.stringify(await verifyDurableEvidenceFixtureUnsafe(process.argv[1], options)));`;
  const child = await execFileAsync(process.execPath, ['--input-type=module', '--eval', program, value.manifestPath, config], { timeout: 20_000, maxBuffer: 32768, windowsHide: true });
  assert.deepEqual(JSON.parse(child.stdout), { valid: true, releaseEligible: false, reason: 'fixture_not_release_evidence', manifestDigest: digest(value.manifest) });
  await assert.rejects(sealProductionEvidence({ receiptAuthority: value.receiptAuthority, journalAuthority: value.journalAuthority }), { reason: 'fixture_not_release_evidence' });
  assert.throws(() => assertDurableReceiptProof({ manifestDigest: digest(value.manifest) }, value.manifest), { reason: 'invalid_durable_receipt_proof' });
});

for (const mutation of ['artifact', 'saved-self-hash', 'mixed-run', 'stale', 'wrong-root', 'cleanup', 'symlink']) test(`Given a sealed run, When ${mutation} changes its trust or files, Then independent verification rejects`, async t => {
  const value = await fixture(t); await seal(value);
  if (mutation === 'mixed-run') { await assert.rejects(verifyFixture(value, { expectedIdentity: identity() }), { reason: 'identity_mismatch' }); return; }
  if (mutation === 'stale') { await assert.rejects(verifyFixture(value, { now: Date.now() + 5 * 60 * 60_000 }), { reason: 'stale_state' }); return; }
  if (mutation === 'wrong-root') { await assert.rejects(verifyFixture(value, { publicKey: pair().publicKey }), { reason: 'durable_signature_failed' }); return; }
  if (mutation === 'saved-self-hash') {
    const file = path.join(value.runDirectory, 'evidence-seal.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    saved.statement.manifestSha256 = 'f'.repeat(64); await writeFile(file, JSON.stringify(saved));
    await assert.rejects(verifyFixture(value), { reason: 'durable_signature_failed' }); return;
  }
  if (mutation === 'artifact') await writeFile(path.join(value.runDirectory, 'artifacts/local/checks.json'), JSON.stringify({ component: 'local', status: 'FAIL', fixture: true }));
  if (mutation === 'cleanup') await rm(path.join(value.runDirectory, 'cleanup/run.json'));
  if (mutation === 'symlink') {
    const saved = path.join(value.parent, 'saved-artifacts'); await rename(path.join(value.runDirectory, 'artifacts'), saved);
    await symlink(saved, path.join(value.runDirectory, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await assert.rejects(verifyFixture(value));
});

test('Given genuine completed authority, When saved last receipt and journal hashes are rewritten, Then the in-process commit pin rejects resealing', async t => {
  const value = await fixture(t), receiptPath = path.join(value.runDirectory, 'cleanup/cleanup.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); receipt.observedAt = new Date(Date.parse(receipt.observedAt) + 1).toISOString();
  const receiptBytes = `${JSON.stringify(receipt)}\n`; await writeFile(receiptPath, receiptBytes);
  const relative = `receipts/${String(STEP_NAMES.length).padStart(6, '0')}--cleanup.json`, entryPath = path.join(value.runDirectory, relative);
  const entry = JSON.parse(await readFile(entryPath, 'utf8')); entry.receiptSha256 = digest(receiptBytes); delete entry.entrySha256; entry.entrySha256 = digest(entry);
  const entryBytes = `${JSON.stringify(entry)}\n`; await writeFile(entryPath, entryBytes);
  for (const suffix of ['pending', 'commit']) await writeFile(`${entryPath}.${suffix}`, `${JSON.stringify({ schema: `raibitserver.production-evidence-journal-${suffix}/v1`, path: relative, sha256: digest(entryBytes) })}\n`);
  await assert.rejects(seal(value), { reason: 'receipt_authority_mutated' });
});

test('Given completed receipts, When a late journal binding is appended, Then completion scope cannot be extended before signing', async t => {
  const value = await fixture(t);
  await value.journalAuthority.appendBinding({ role: 'identity', bindingId: 'late', createdAt: new Date().toISOString(),
    payload: { kind: 'organization-membership', organizationId: 'late-org', membershipId: 'late-member', userId: 'late-user', role: 'OWNER' } });
  await assert.rejects(seal(value), { reason: 'receipt_authority_mutated' });
});

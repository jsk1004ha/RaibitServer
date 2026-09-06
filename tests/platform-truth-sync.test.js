import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import catalog from '../docs/platform-expansion-completion.json' with { type: 'json' };
import { parseCatalog, parseCompletionAttempt, parseTaskReceipt } from '../scripts/completion-matrix-contract.mjs';
import { assertCatalogDigest, verifyCatalogReferences, verifyCompletionGate } from '../scripts/verify-completion-matrix.mjs';
import { EvidenceError, digest } from '../scripts/production-evidence/lib/operator-inputs.mjs';
import { completionAttempt, descriptor, FINAL_SHA, identity, taskReceipt, TREE_SHA } from './fixtures/completion-matrix.mjs';

const rejects = (operation, reason) => assert.throws(operation, (error) => error instanceof EvidenceError && error.reason === reason);
test('Given the capability catalog, parsing keeps references separate from completion claims', () => {
  const result = parseCatalog(catalog);
  assert.equal(result.tasks.length, 50);
  assert.deepEqual(result.components, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  assert.equal(result.claim, 'capability-references-only');
  assert.equal(Object.hasOwn(result, 'releaseEligible'), false);
});
test('Given complete runtime shapes, parsing exact 1-50 and final 1-51 grants no release authority', () => {
  for (const final of [false, true]) {
    const input = completionAttempt(final);
    delete input.gateA.ciExecution;
    if (input.gateB) delete input.gateB.ciExecution;
    const matrix = parseCompletionAttempt(input, { final });
    assert.equal(matrix.tasks.length, final ? 51 : 50);
    assert.equal(Object.hasOwn(matrix.gateA, 'ciExecution'), false);
    assert.equal(Object.hasOwn(matrix, 'releaseEligible'), false);
  }
});
test('platform truth drift mutation matrix rejects unsupported catalog claims', () => {
  const cases = [
    ['completion_route_tenant_drift', (m) => { m.truth.generatedRouteTenant = 'userSlug'; }],
    ['completion_unsupported_engine', (m) => { m.truth.tenantEngines.push('qdrant'); }],
    ['level_mismatch', (m) => { m.truth.clusterLevel = 'L3'; }],
    ['completion_capability_digest_drift', (m) => { m.truth.resourceCapabilityDigest = '0'.repeat(64); }],
    ['approved_input_digest_mismatch', (m) => { m.approvedInputSha256 = '0'.repeat(64); }],
    ['completion_role_drift', (m) => { m.truth.grantableRoles.push('BILLING_MANAGER'); }],
    ['completion_missing_task', (m) => { m.tasks.pop(); }],
    ['completion_duplicate_task', (m) => { m.tasks.push(m.tasks[0]); }],
    ['completion_unsupported_task', (m) => { m.tasks[49].id = 51; }],
    ['completion_component_mismatch', (m) => { m.tasks[0].components = ['C6']; }],
    ['completion_slice_mismatch', (m) => { m.tasks[1].prSlice = 'B3'; }],
    ['completion_missing_reference', (m) => { m.tasks[1].tests = []; }],
    ['completion_evidence_mapping_mismatch', (m) => { m.tasks[27].evidence = ['command-receipts']; }],
    ['completion_invalid_schema', (m) => { m.releaseEligible = true; }],
    ['completion_invalid_schema', (m) => { m.tasks[1].code = ['../private.ts']; }],
    ['redaction', (m) => { m.password = 'fixture-credential'; }],
  ];
  for (const [reason, mutate] of cases) {
    const value = structuredClone(catalog);
    mutate(value);
    rejects(() => parseCatalog(value), reason);
  }
});
test('platform truth drift mutation matrix rejects incomplete reused and mixed final receipts', () => {
  const cases = [
    ['completion_missing_task', (m) => { m.tasks.pop(); }],
    ['completion_duplicate_task', (m) => { m.tasks.push(m.tasks[0]); }],
    ['completion_component_mismatch', (m) => { m.components.pop(); }],
    ['completion_component_mismatch', (m) => { m.tasks[50].components = ['C6']; }],
    ['completion_slice_mismatch', (m) => { m.prSlices.reverse(); }],
    ['completion_unresolved_live_criteria', (m) => { m.unresolvedLiveCriteria = ['database_not_run']; }],
    ['fixture_not_release_evidence', (m) => { m.fixture = true; }],
    ['completion_reused_receipt', (m) => { m.tasks[1].receipt = m.tasks[0].receipt; }],
    ['completion_missing_gate_b', (m) => { delete m.gateB; }],
    ['completion_mixed_sha', (m) => { m.gateB.identity.sourceCommitSha = 'f'.repeat(40); }],
    ['completion_gate_a_source_mismatch', (m) => { m.gateA.identity.sourceCommitSha = FINAL_SHA; }],
    ['completion_final_source_mismatch', (m) => { m.sourceCommitSha = 'f'.repeat(40); }],
    ['completion_reused_gate', (m) => { m.gateB.identity.runId = m.gateA.identity.runId; }],
    ['completion_reused_gate', (m) => { m.gateB.identity.runId = m.domainEvidence.identity.runId; }],
    ['completion_reused_gate', (m) => { m.gateB.manifestDigest = m.gateA.manifestDigest; }],
    ['completion_reused_gate', (m) => { m.gateB.artifact = m.gateA.artifact; }],
    ['completion_invalid_schema', (m) => { m.prSlices[0].number = 999999; }],
    ['completion_invalid_schema', (m) => { m.gateB.ciExecution = { ...m.gateB.ciExecution, trusted: true }; }],
  ];
  for (const [reason, mutate] of cases) {
    const value = completionAttempt();
    mutate(value);
    rejects(() => parseCompletionAttempt(value, { final: true }), reason);
  }
  rejects(() => parseCompletionAttempt(completionAttempt()), 'completion_unsupported_task');
  const future = completionAttempt(false);
  future.gateB = completionAttempt().gateB;
  rejects(() => parseCompletionAttempt(future), 'completion_future_gate_b');
  const stale = completionAttempt();
  stale.catalogSha256 = '0'.repeat(64);
  rejects(() => assertCatalogDigest(stale, JSON.stringify(catalog)), 'completion_catalog_digest_mismatch');
});
test('Given task command receipts, missing assertions cleanup or exact-source evidence is rejected', () => {
  const expected = { taskId: 1, sourceCommitSha: FINAL_SHA, sourceTreeSha: TREE_SHA };
  assert.equal(parseTaskReceipt(taskReceipt(), expected).commands.length, 1);
  const cases = [
    ['not_run', (r) => { r.status = 'NOT_RUN'; }],
    ['fixture_not_release_evidence', (r) => { r.fixture = true; }],
    ['completion_receipt_task_mismatch', (r) => { r.taskId = 2; }],
    ['completion_mixed_sha', (r) => { r.sourceCommitSha = 'a'.repeat(40); }],
    ['completion_command_failed', (r) => { r.commands[0].exitCode = 1; }],
    ['completion_command_failed', (r) => { r.commands[0].assertionCount = 0; }],
    ['completion_command_failed', (r) => { r.commands[0].skippedCount = 1; }],
    ['cleanup_failed', (r) => { r.cleanup.status = 'FAIL'; }],
    ['missing_artifact', (r) => { r.commands[0].artifact = descriptor('phantom.json'); }],
  ];
  for (const [reason, mutate] of cases) {
    const value = taskReceipt();
    mutate(value);
    rejects(() => parseTaskReceipt(value, expected), reason);
  }
});
test('Given a phantom source reference, committed-source verification rejects it', async () => {
  const value = structuredClone(catalog);
  value.tasks[1].code = ['packages/core/src/completion-phantom.ts'];
  await assert.rejects(verifyCatalogReferences(value), { reason: 'completion_missing_reference' });
});
test('Given optional CI expectations, the gate still requires durable authority and rejects malformed or wrong-source CI', async (t) => {
  // Given: a physical unsigned final manifest and independently supplied CI projections.
  const root = path.resolve(process.env.RAIBITSERVER_TEST_OUTPUT_DIR ?? tmpdir());
  const directory = await mkdtemp(path.join(root, 'completion-optional-ci-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await rm(directory, { recursive: true }); });
  const observedAt = new Date().toISOString();
  const manifest = { profile: 'final', identity: identity(2), startedAt: observedAt, observedAt, fixture: false };
  const bytes = JSON.stringify(manifest);
  await writeFile(path.join(directory, 'manifest.json'), bytes);
  const reference = { artifact: { path: 'manifest.json', sha256: digest(bytes), redacted: true }, identity: manifest.identity, manifestDigest: digest(manifest) };
  const ci = (sourceCommitSha) => {
    const repository = 'jsk1004ha/RaibitServer';
    const ref = `refs/tags/raibit-gate-b-${sourceCommitSha}-00000000-0000-4000-8000-000000000002`;
    return { repository, ref, sourceCommitSha, runId: '123', runAttempt: 1,
      workflowRef: `${repository}/.github/workflows/production-evidence.yml@${ref}`, workflowSha: sourceCommitSha, event: 'push' };
  };
  const unsigned = process.platform === 'win32' ? 'receipt_platform_not_release_safe' : 'receipt_authority_unavailable';
  for (const [projection, reason] of [[undefined, unsigned], [ci(FINAL_SHA), unsigned], [{ ...ci(FINAL_SHA), trusted: true }, 'ci_identity_mismatch'], [ci('a'.repeat(40)), 'completion_mixed_sha']]) {
    const ciBytes = JSON.stringify(projection);
    if (ciBytes) await writeFile(path.join(directory, 'ci.json'), ciBytes);
    // When / Then: caller expectations cannot replace authority or broaden the strict CI schema.
    await assert.rejects(verifyCompletionGate(directory, { ...reference,
      ...(ciBytes ? { ciExecution: { path: 'ci.json', sha256: digest(ciBytes), redacted: true } } : {}) }, 'gate-b'), { reason });
  }
});
test('Given physical final manifests, stale digest fixture and stale clock cannot pass the real verifier', async (t) => {
  const root = path.resolve(process.env.RAIBITSERVER_TEST_OUTPUT_DIR ?? tmpdir());
  const directory = await mkdtemp(path.join(root, 'completion-contract-'));
  t.after(async () => { assert.equal(path.dirname(directory), root); await rm(directory, { recursive: true }); });
  const file = path.join(directory, 'manifest.json');
  const observedAt = new Date().toISOString();
  const base = { profile: 'final', identity: identity(2), startedAt: observedAt, observedAt, fixture: false };
  const cases = [
    ['artifact_digest_mismatch', (r) => { r.artifact.sha256 = '0'.repeat(64); }, () => {}],
    ['completion_gate_digest_mismatch', (r) => { r.manifestDigest = '0'.repeat(64); }, () => {}],
    ['fixture_not_release_evidence', () => {}, (m) => { m.fixture = true; }],
    ['completion_gate_profile_mismatch', () => {}, (m) => { m.profile = 'train-a'; }],
    ['stale_state', () => {}, (m) => { m.startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); }],
  ];
  for (const [reason, mutateRef, mutateManifest] of cases) {
    const manifest = structuredClone(base);
    mutateManifest(manifest);
    const bytes = JSON.stringify(manifest);
    await writeFile(file, bytes);
    const reference = { artifact: { path: 'manifest.json', sha256: digest(bytes), redacted: true },
      identity: manifest.identity, manifestDigest: digest(manifest) };
    mutateRef(reference);
    await assert.rejects(verifyCompletionGate(directory, reference, 'gate-b'), { reason });
    assert.equal(await readFile(file, 'utf8'), bytes);
  }
  const cliInput = completionAttempt();
  cliInput.fixture = true;
  await writeFile(file, JSON.stringify(cliInput));
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/verify-completion-matrix.mjs', '--final', file], {
    cwd: path.resolve(import.meta.dirname, '..'), timeout: 10_000,
  }), (error) => error.code === 1 && error.stderr.trim() === 'fixture_not_release_evidence');
});

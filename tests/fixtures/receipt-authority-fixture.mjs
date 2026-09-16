import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, digest, loadOperatorContract } from '../../scripts/production-evidence/lib/operator-inputs.mjs';
import { createRun } from '../../scripts/production-evidence/lib/run.mjs';
import { createUnsafeFixtureArtifactWriter } from '../../scripts/production-evidence/lib/safe-artifact-writer.mjs';
import { STEP_ASSERTIONS } from '../../scripts/production-evidence/lib/step-contract.mjs';

export const TEST_STARTED_AT = new Date().toISOString();

const contract = await loadOperatorContract();
const selectorValues = ['cluster', 'fixture-prefix', 'fixture.example', 'registry.example/fixture', 'fixture/repository', '123', 'https://backup.example', 'fixture-backups'];
export const INPUTS = Object.freeze({ schema: 'raibitserver.operator-input-values/v1', approvedInputSha256: APPROVED_INPUT_SHA256,
  operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
  selectors: Object.freeze(Object.fromEntries(contract.selectors.map(({ name }, index) => [name, selectorValues[index]]))),
  secretRefs: Object.freeze(contract.secretBindings.map(({ role, binding, kind, keyFields }) => kind === 'helm-existingSecret'
    ? Object.freeze({ role, binding, kind, namespace: 'fixture-system', existingSecret: `fixture-${role}`,
      keys: Object.freeze(Object.values(keyFields).length ? Object.values(keyFields) : ['fixture-key']) })
    : Object.freeze({ role, binding, kind, namespace: 'fixture-system',
      secretKeyRef: Object.freeze({ name: `fixture-${role}`, key: 'fixture-key', optional: false }) }))),
});

export function identity(runId = randomUUID()) {
  return Object.freeze({ runId, environmentFingerprint: 'a'.repeat(64), sourceCommitSha: 'b'.repeat(40),
    migrationDigest: 'c'.repeat(64), approvedInputSha256: APPROVED_INPUT_SHA256,
    operatorContractDigest: OPERATOR_CONTRACT_DIGEST, operatorInputFingerprint: digest(INPUTS) });
}

export function request(step, runDirectory, runIdentity, index = 0) {
  const startedAt = new Date(Date.parse(TEST_STARTED_AT) + index * 60_000).toISOString();
  return { schema: 'raibitserver.production-evidence-step-request/v1', step, identity: runIdentity,
    startedAt, deadlineAt: new Date(Date.parse(startedAt) + 30_000).toISOString(), runDirectory,
    selectors: { ...INPUTS.selectors }, secretRefs: [], state: { cleanupNamespace: 'evidence-run' } };
}

export function generated(prepared, status = 'PASS') {
  const artifacts = STEP_ASSERTIONS[prepared.step].map((id) => {
    const component = ['provision', 'attach_query', 'backup_checksum', 'isolated_restore', 'resource_delete'].includes(id) ? 'resources'
      : ['usage_quota_audit', 'trusted_proxy', 'metrics', 'rollback', 'component_cleanup', 'run_cleanup'].includes(id) ? 'operations' : 'lifecycle';
    const artifactPath = prepared.step === 'cleanup' ? `cleanup/${prepared.step}-${id}-observation.json`
      : `artifacts/${component}/${prepared.step}-${id}-observation.json`;
    return { path: artifactPath, sha256: 'e'.repeat(64), redacted: true };
  });
  return { observedAt: new Date(Date.parse(prepared.request.startedAt) + 1_000).toISOString(), status,
    reason: status === 'PASS' ? null : status === 'FAIL' ? 'step_failed' : 'dependency_failed',
    assertions: STEP_ASSERTIONS[prepared.step].map((id, index) => ({ id, status, artifactPaths: [artifacts[index].path] })),
    artifacts, cleanupInventory: [], fixture: true };
}

export async function sandbox(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'raibit-receipt-authority-'));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const runIdentity = identity();
  const runDirectory = await createRun(parent, runIdentity, TEST_STARTED_AT);
  await mkdir(path.join(runDirectory, 'work'));
  const allowed = (value) => /^(?:bindings|cleanup-intents)\/[a-z0-9.-]+$/.test(value) || /^(?:artifacts\/(?:lifecycle|resources|operations)\/(?:auth-source|supply-chain|runtime|observability|resources|backup-sql|backup-nosql|preview|rollback)(?:-[a-z_-]+-observation)?\.json|cleanup\/(?:cleanup|cleanup-[a-z_-]+-observation)\.json|receipt-requests\/\d{6}--[a-z-]+\.json(?:\.pending|\.commit)?|receipts\/\d{6}--[a-z-]+\.json(?:\.pending|\.commit)?)$/.test(value);
  const writer = await createUnsafeFixtureArtifactWriter({ runDirectory, allowedPaths: allowed });
  t.after(async () => writer.close());
  return { parent, runDirectory, runIdentity, writer, startedAt: TEST_STARTED_AT };
}

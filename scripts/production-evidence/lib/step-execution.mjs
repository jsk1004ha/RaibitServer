import { STEP_ASSERTIONS } from './step-contract.mjs';

export const STEP_BUDGET_MS = Object.freeze({
  'auth-source': 60_000, 'supply-chain': 45 * 60_000, runtime: 13 * 60_000, observability: 5 * 60_000,
  resources: 30 * 60_000, 'backup-sql': 30 * 60_000, 'backup-nosql': 30 * 60_000,
  preview: 10 * 60_000, rollback: 10 * 60_000, cleanup: 30_000,
});

export async function failedStepReceipt(execution, context, { reason, fixture, status = 'FAIL' }) {
  const { request, requestSha256 } = execution;
  const artifacts = [];
  const assertions = [];
  for (const id of STEP_ASSERTIONS[request.step]) {
    const component = request.step === 'cleanup' ? 'cleanup'
      : ['provision', 'attach_query', 'backup_checksum', 'isolated_restore', 'resource_delete'].includes(id) ? 'resources'
        : ['usage_quota_audit', 'trusted_proxy', 'metrics', 'rollback'].includes(id) ? 'operations' : 'lifecycle';
    const artifact = await context.writeArtifact(component, `${request.step}-${id}-observation.json`,
      { schema: 'raibitserver.production-evidence-step-failure/v1', step: request.step, status, reason, redacted: true });
    artifacts.push(artifact); assertions.push({ id, status, artifactPaths: [artifact.path] });
  }
  return { schema: 'raibitserver.production-evidence-step-receipt/v2', step: request.step, requestSha256,
    identity: request.identity, startedAt: request.startedAt, observedAt: context.now(), status, reason,
    assertions, artifacts, cleanupInventory: [], redacted: true, fixture };
}

export async function executeProductionStep(authority, step, timing) {
  const prepared = await authority.prepareStep(step, timing);
  const candidate = await authority.executePreparedStep(prepared);
  return authority.commitCandidate(prepared, candidate);
}

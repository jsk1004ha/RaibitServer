import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STEP_COMPONENT } from './manifest.mjs';
import { digest, EvidenceError, readJson } from './operator-inputs.mjs';
import { immutableJson } from './orchestrator-io.mjs';
import { assertStepReceiptTimeBounds, parseStepReceipt, parseStepResult, STEP_ASSERTIONS } from './step-contract.mjs';

export const STEP_BUDGET_MS = Object.freeze({
  'auth-source': 60_000, 'supply-chain': 45 * 60_000, runtime: 13 * 60_000, observability: 5 * 60_000,
  resources: 30 * 60_000, 'backup-sql': 30 * 60_000, 'backup-nosql': 30 * 60_000,
  preview: 10 * 60_000, rollback: 10 * 60_000, cleanup: 30_000,
});
const ASSERTION_COMPONENT = Object.freeze({
  github_source: 'lifecycle', image_digest: 'lifecycle', scan_policy: 'lifecycle', signature: 'lifecycle', rollout: 'lifecycle',
  https: 'lifecycle', functional_write_read: 'lifecycle', runtime_logs: 'lifecycle', preview_cleanup: 'lifecycle', provision: 'resources',
  attach_query: 'resources', backup_checksum: 'resources', isolated_restore: 'resources', resource_delete: 'resources',
  usage_quota_audit: 'operations', trusted_proxy: 'operations', metrics: 'operations', rollback: 'operations',
});

async function failedStepReceipt(request, context, status, reason, fixture) {
  const artifacts = [];
  for (const component of new Set(STEP_ASSERTIONS[request.step].map((id) => ASSERTION_COMPONENT[id] ?? STEP_COMPONENT[request.step]))) {
    artifacts.push(await context.writeArtifact(component, `${request.step}-failure.json`, { schema: 'raibitserver.production-evidence-step-failure/v1', step: request.step, status, reason, redacted: true }));
  }
  return { schema: 'raibitserver.production-evidence-step-receipt/v1', step: request.step, identity: request.identity,
    startedAt: request.startedAt, observedAt: context.now(), status, reason,
    assertions: STEP_ASSERTIONS[request.step].map((id) => ({ id, status, artifactPaths: [artifacts.find(({ path: artifactPath }) => artifactPath.includes(`/${ASSERTION_COMPONENT[id] ?? STEP_COMPONENT[request.step]}/`))?.path ?? artifacts[0].path] })),
    artifacts, cleanupInventory: [], redacted: true, fixture };
}

export async function skippedStep(request, context, fixture) {
  return await failedStepReceipt(request, context, 'NOT_RUN', 'dependency_failed', fixture);
}

export async function executeProductionStep({ step, request, context, injected, fixture, runDirectory, root }) {
  const receiptPath = step === 'cleanup' ? 'cleanup/cleanup.json' : `artifacts/${STEP_COMPONENT[step]}/${step}.json`;
  if (injected) {
    try {
      const result = parseStepResult(await injected(request, context), step, request);
      const receipt = { schema: 'raibitserver.production-evidence-step-receipt/v1', step, identity: request.identity,
        startedAt: request.startedAt, observedAt: context.now(), ...result, redacted: true, fixture: true };
      const descriptor = await immutableJson(runDirectory, receiptPath, receipt);
      return { receipt: parseStepReceipt(receipt), descriptor };
    } catch (error) {
      const reason = error instanceof EvidenceError ? error.reason : 'step_execution_failed';
      const receipt = await failedStepReceipt(request, context, 'FAIL', reason, true);
      return { receipt, descriptor: await immutableJson(runDirectory, receiptPath, receipt) };
    }
  }
  const requestPath = path.join(runDirectory, 'work', `${step}.request.json`);
  const outputPath = path.join(runDirectory, ...receiptPath.split('/'));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(requestPath, 0o600);
  try {
    const wrapper = path.join(root, 'scripts', 'production-evidence', `${step}.sh`);
    const result = await context.executeFile('bash', [wrapper, '--request', requestPath, '--output', outputPath], { cwd: root, timeoutMs: STEP_BUDGET_MS[step] });
    const receipt = parseStepReceipt(await readJson(outputPath, 'missing_step_receipt'));
    assertStepReceiptTimeBounds(receipt, request.deadlineAt);
    if (digest(receipt.identity) !== digest(request.identity) || receipt.fixture) throw new EvidenceError('identity_mismatch');
    if ((result.exitCode === 0) !== (receipt.status === 'PASS')) throw new EvidenceError('step_exit_mismatch');
    const bytes = await readFile(outputPath);
    return { receipt, descriptor: { path: receiptPath, sha256: digest(bytes), redacted: true } };
  } catch (error) {
    await rm(outputPath, { force: true });
    const reason = error instanceof EvidenceError ? error.reason : 'step_execution_failed';
    const receipt = await failedStepReceipt(request, context, 'FAIL', reason, false);
    return { receipt, descriptor: await immutableJson(runDirectory, receiptPath, receipt) };
  } finally {
    await rm(requestPath, { force: true });
  }
}

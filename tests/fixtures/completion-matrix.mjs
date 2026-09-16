import catalog from '../../docs/platform-expansion-completion.json' with { type: 'json' };
import { COMPONENTS, PR_SLICES, componentsForTask, sliceForTask } from '../../scripts/completion-matrix-contract.mjs';
import { APPROVED_INPUT_SHA256, OPERATOR_CONTRACT_DIGEST, digest } from '../../scripts/production-evidence/lib/operator-inputs.mjs';

export const FINAL_SHA = 'b'.repeat(40);
export const TREE_SHA = 'c'.repeat(40);
export const descriptor = (file) => ({ path: file, sha256: digest(file), redacted: true });
export const identity = (suffix, sourceCommitSha = FINAL_SHA) => ({
  runId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
  sourceCommitSha, environmentFingerprint: 'd'.repeat(64), migrationDigest: 'e'.repeat(64),
  approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
  operatorInputFingerprint: 'f'.repeat(64),
});
export function completionAttempt(final = true) {
  // Structural test input only. It has no physical receipts or release authority.
  const gate = (name, id, sha = FINAL_SHA) => ({
    artifact: descriptor(`${name}/manifest.json`), ...(name === 'domain' ? {} : { ciExecution: descriptor(`${name}/ci-execution.json`) }),
    identity: identity(id, sha), manifestDigest: digest(name),
  });
  return {
    schema: 'raibitserver.platform-completion-attempt/v1', sourceCommitSha: FINAL_SHA, sourceTreeSha: TREE_SHA,
    approvedInputSha256: APPROVED_INPUT_SHA256, operatorContractDigest: OPERATOR_CONTRACT_DIGEST,
    catalogSha256: digest(JSON.stringify(catalog, null, 2) + '\n'), components: [...COMPONENTS], fixture: false,
    unresolvedLiveCriteria: [],
    tasks: Array.from({ length: final ? 51 : 50 }, (_, index) => ({ id: index + 1, components: componentsForTask(index + 1),
      prSlice: sliceForTask(index + 1), receipt: descriptor(`tasks/${index + 1}.json`) })),
    prSlices: PR_SLICES.map((id) => ({ id, baseCommitSha: 'a'.repeat(40), headCommitSha: 'a'.repeat(40),
      mergedCommitSha: id === 'B3' ? FINAL_SHA : 'a'.repeat(40), artifact: descriptor(`slices/${id}.json`) })),
    gateA: gate('gate-a', 1, 'a'.repeat(40)), domainEvidence: gate('domain', 3),
    ...(final ? { gateB: gate('gate-b', 2) } : {}),
  };
}
export function taskReceipt() {
  const artifact = descriptor('tasks/1-command.json');
  return {
    schema: 'raibitserver.platform-task-receipt/v1', taskId: 1, sourceCommitSha: FINAL_SHA, sourceTreeSha: TREE_SHA,
    status: 'PASS', fixture: false,
    commands: [{ command: 'node --test tests/platform-truth-sync.test.js', exitCode: 0, assertionCount: 1, skippedCount: 0, artifact }],
    artifacts: [artifact],
    cleanup: { status: 'PASS', assertions: [{ id: 'task_cleanup', status: 'PASS', artifactPaths: [artifact.path] }] },
  };
}

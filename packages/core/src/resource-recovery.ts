import { RecoveryError } from './resource-recovery-provenance.ts';
import { createRecovery, recoveryAuthorized } from './resource-recovery-state.ts';
import { claimRecovery, mutateRecovery } from './resource-recovery-worker.ts';
import { cancelRecoveryRestore, expireRecoveryBackup, claimRecoveryCleanup, finishRecoveryCleanup } from './resource-recovery-cleanup.ts';
import type { RecoveryTransaction, RecoveryQuotaPolicy, RecoveryKind, RecoveryRequest, RecoveryScope, RecoveryClaim, RecoveryFence, RecoveryMutation, RecoveryCleanupFence, RecoveryBackup, RecoveryRestore } from './resource-recovery-types.ts';

export class ResourceRecoveryRepository {
  readonly transaction: RecoveryTransaction;
  readonly enforceQuota: RecoveryQuotaPolicy;
  constructor(transaction: RecoveryTransaction, enforceQuota: RecoveryQuotaPolicy) {
    if (typeof enforceQuota !== 'function') throw new RecoveryError('RECOVERY_QUOTA_POLICY_REQUIRED');
    this.transaction = transaction; this.enforceQuota = enforceQuota;
  }
  createBackup(request: RecoveryRequest) { return this.create(request, 'backup'); }
  createRestore(request: RecoveryRequest) { return this.create(request, 'restore'); }
  private create(request: RecoveryRequest, kind: RecoveryKind) {
    return this.transaction.run(request.organizationId, async state => {
      const before = structuredClone(state);
      const result = createRecovery(state, request, kind);
      if (!result.replay) await this.enforceQuota(before, request, kind);
      return structuredClone(result);
    });
  }
  getBackup(scope: RecoveryScope, id: string) {
    return this.transaction.run(scope.organizationId, state => {
      recoveryAuthorized(state, scope, false);
      const backup = state.backups.find(row => row.id === id && row.organizationId === scope.organizationId);
      if (backup) return publicRecovery(backup);
      const legacy = state.legacyBackups.find(row => row.id === id && state.resources.some(resource => resource.id === row.resourceId && state.projects.some(project => project.id === resource.projectId && project.organizationId === scope.organizationId)));
      if (legacy) return { id: legacy.id, resourceId: legacy.resourceId, status: 'FAILED', errorCode: 'LEGACY_BACKUP_UNVERIFIED', recoverable: false };
      throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
    });
  }
  claim(input: RecoveryClaim) { return this.transaction.run(input.organizationId, state => structuredClone(claimRecovery(state, input))); }
  mutate(input: RecoveryFence, mutation: RecoveryMutation) { return this.transaction.run(input.organizationId, state => structuredClone(mutateRecovery(state, input, mutation))); }
  cancelRestore(input: RecoveryScope & { readonly operationId: string; readonly now?: string }) { return this.transaction.run(input.organizationId, state => structuredClone(cancelRecoveryRestore(state, input))); }
  expireBackup(input: { readonly organizationId: string; readonly operationId: string; readonly now?: string }) { return this.transaction.run(input.organizationId, state => structuredClone(expireRecoveryBackup(state, input))); }
  claimCleanup(input: RecoveryClaim) { return this.transaction.run(input.organizationId, state => structuredClone(claimRecoveryCleanup(state, input))); }
  finishCleanup(input: RecoveryCleanupFence) { return this.transaction.run(input.organizationId, state => structuredClone(finishRecoveryCleanup(state, input))); }
}

export function publicRecovery(operation: RecoveryBackup | RecoveryRestore) {
  const common = { id: operation.id, organizationId: operation.organizationId, projectId: operation.projectId, engine: operation.engine,
    status: operation.status, createdAt: operation.createdAt, readyAt: operation.readyAt, errorCode: operation.errorCode };
  if ('resourceId' in operation) return { ...common, resourceId: operation.resourceId, size: operation.artifactSize, expiresAt: operation.expiresAt, recoverable: operation.status === 'READY' };
  return { ...common, backupId: operation.backupId, sourceResourceId: operation.sourceResourceId, targetResourceId: operation.targetResourceId };
}
export * from './resource-recovery-types.ts';
export { RecoveryError, captureRecoveryProvenance, recoveryBody, recoveryObjectKey } from './resource-recovery-provenance.ts';

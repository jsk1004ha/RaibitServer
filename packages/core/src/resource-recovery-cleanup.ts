import crypto from 'node:crypto';
import { RecoveryError } from './resource-recovery-provenance.ts';
import { recoveryAuthorized, recoveryBackup, recoveryJob, recoveryNow, recoveryMillis, recoverySet, recoveryTransition } from './resource-recovery-state.ts';
import { recoveryOperation } from './resource-recovery-worker.ts';
import type { RecoveryState, RecoveryScope, RecoveryClaim, RecoveryCleanupFence } from './resource-recovery-types.ts';

export function cancelRecoveryRestore(state: RecoveryState, request: RecoveryScope & { readonly operationId: string; readonly now?: string }) {
  const operation = state.restores.find(row => row.id === request.operationId && row.organizationId === request.organizationId);
  if (!operation) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  recoveryAuthorized(state, request, 'backup:restore');
  recoveryTransition('restore', operation.status, 'CANCELLED');
  const now = recoveryNow(request.now);
  const job = recoveryJob(state, operation.id);
  const next = { ...operation, status: 'CANCELLED' as const, updatedAt: now };
  recoverySet(state, next, { ...job, status: 'cancelled', lockedAt: null, lockedBy: null, updatedAt: now });
  return next;
}
export function expireRecoveryBackup(state: RecoveryState, input: { readonly organizationId: string; readonly operationId: string; readonly now?: string }) {
  const backup = recoveryBackup(state, input.operationId, input.organizationId);
  const now = recoveryNow(input.now);
  if (!backup.expiresAt || recoveryMillis(backup.expiresAt) > Date.parse(now)) throw new RecoveryError('RECOVERY_NOT_EXPIRED');
  recoveryTransition('backup', backup.status, 'EXPIRED');
  const next = { ...backup, status: 'EXPIRED' as const, updatedAt: now };
  recoverySet(state, next);
  return next;
}
export function claimRecoveryCleanup(state: RecoveryState, input: RecoveryClaim) {
  const operation = recoveryOperation(state, input);
  const now = recoveryNow(input.now);
  const job = recoveryJob(state, operation.id);
  if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) throw new RecoveryError('RECOVERY_PUBLICATION_UNFENCED');
  if (operation.cleanupLeaseUntil && recoveryMillis(operation.cleanupLeaseUntil) > Date.parse(now)) throw new RecoveryError('RECOVERY_LEASE_BUSY');
  if (!input.workerId || input.workerId.length > 128) throw new RecoveryError('RECOVERY_WORKER_INVALID');
  let next = { ...operation, cleanupToken: crypto.randomUUID(), cleanupWorker: input.workerId, cleanupLeaseUntil: new Date(Date.parse(now) + 60_000).toISOString(), updatedAt: now };
  if ('resourceId' in next) {
    if (state.pins.some(pin => pin.backupId === next.id && pin.kind === 'RESTORE_TARGET')) throw new RecoveryError('RECOVERY_RESTORE_PINNED');
    if (!['FAILED', 'EXPIRED', 'DELETING'].includes(next.status)) throw new RecoveryError('RECOVERY_CLEANUP_INELIGIBLE');
    if (next.status !== 'DELETING') recoveryTransition('backup', next.status, 'DELETING');
    next = { ...next, status: 'DELETING' };
  } else if (!['FAILED', 'CANCELLED'].includes(next.status)) throw new RecoveryError('RECOVERY_CLEANUP_INELIGIBLE');
  recoverySet(state, next);
  return { operation: next, attempts: state.attempts.filter(row => row.backupId === next.id) };
}
export function finishRecoveryCleanup(state: RecoveryState, input: RecoveryCleanupFence) {
  const operation = recoveryOperation(state, input);
  const now = recoveryNow(input.now);
  if (operation.cleanupToken !== input.token || operation.cleanupWorker !== input.workerId || !operation.cleanupLeaseUntil || recoveryMillis(operation.cleanupLeaseUntil) <= Date.parse(now)) throw new RecoveryError('RECOVERY_LEASE_LOST');
  const job = recoveryJob(state, operation.id);
  if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) throw new RecoveryError('RECOVERY_PUBLICATION_UNFENCED');
  const clearLease = { cleanupToken: null, cleanupWorker: null, cleanupLeaseUntil: null, updatedAt: now };
  if ('resourceId' in operation) {
    if (state.pins.some(row => row.backupId === operation.id && row.kind === 'RESTORE_TARGET')) throw new RecoveryError('RECOVERY_RESTORE_PINNED');
    recoveryTransition('backup', operation.status, 'DELETED');
    // Trusted cleanup acknowledgement covers ALL recorded attempt keys/upload IDs.
    state.attempts = state.attempts.map(row => row.backupId === operation.id ? { ...row, state: 'CLEANED', cleanupPending: false, updatedAt: now } : row);
    const next = { ...operation, ...clearLease, status: 'DELETED' as const };
    recoverySet(state, next);
    state.pins = state.pins.filter(row => row.backupId !== operation.id);
    return next;
  }
  if (!['FAILED', 'CANCELLED'].includes(operation.status)) throw new RecoveryError('RECOVERY_CLEANUP_INELIGIBLE');
  const next = { ...operation, ...clearLease, targetCleanedAt: now };
  recoverySet(state, next);
  state.resources = state.resources.map(row => row.id === operation.targetResourceId ? { ...row, status: 'DELETED', deletionRequestedAt: now } : row);
  state.pins = state.pins.filter(row => row.restoreId !== operation.id);
  return next;
}

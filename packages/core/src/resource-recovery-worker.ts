import { captureRecoveryProvenance, recoveryObjectKey, RecoveryError } from './resource-recovery-provenance.ts';
import { activeRecoveryResource, recoveryBackup, recoveryJob, recoveryNow, recoveryMillis, recoverySet, recoveryTransition } from './resource-recovery-state.ts';
import type { RecoveryState, RecoveryClaim, RecoveryFence, RecoveryMutation, RecoveryBackup, RecoveryRestore, RecoveryJob } from './resource-recovery-types.ts';

export function recoveryOperation(state: RecoveryState, input: RecoveryClaim): RecoveryBackup | RecoveryRestore {
  if (input.kind === 'backup') return recoveryBackup(state, input.operationId, input.organizationId);
  const restore = state.restores.find(row => row.id === input.operationId && row.organizationId === input.organizationId);
  if (!restore) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  return restore;
}
export function currentRecoverySource(state: RecoveryState, operation: RecoveryBackup | RecoveryRestore): void {
  const sourceId = 'resourceId' in operation ? operation.resourceId : operation.sourceResourceId;
  const resource = activeRecoveryResource(state, sourceId, operation.organizationId);
  if (resource.status !== 'READY' || captureRecoveryProvenance(resource).sourceGeneration !== operation.sourceGeneration) throw new RecoveryError('SOURCE_CHANGED');
  if ('targetResourceId' in operation) {
    const backup = recoveryBackup(state, operation.backupId, operation.organizationId);
    if (!['READY', 'EXPIRED'].includes(backup.status)) throw new RecoveryError('BACKUP_NOT_RECOVERABLE');
    const target = activeRecoveryResource(state, operation.targetResourceId, operation.organizationId);
    if (target.projectId !== operation.projectId || target.engine !== operation.engine || target.desiredState.recoveryRestoreId !== operation.id || target.desiredState.recoveryPublicationBlocked !== true) throw new RecoveryError('RESTORE_TARGET_INVALID');
  }
}
export function fenceRecovery(state: RecoveryState, input: RecoveryFence) {
  const operation = recoveryOperation(state, input);
  const job = recoveryJob(state, operation.id);
  const now = recoveryNow(input.now);
  if (job.status !== 'running' || job.lockedBy !== input.workerId || job.attempts !== input.attempt || !job.lockedAt ||
    recoveryMillis(job.lockedAt) + 60_000 <= Date.parse(now) || !operation.deadlineAt || recoveryMillis(operation.deadlineAt) <= Date.parse(now) ||
    !['RUNNING', 'VERIFYING'].includes(operation.status)) throw new RecoveryError('RECOVERY_LEASE_LOST');
  currentRecoverySource(state, operation);
  return { operation, job, now };
}
export function claimRecovery(state: RecoveryState, input: RecoveryClaim) {
  const operation = recoveryOperation(state, input);
  const job = recoveryJob(state, operation.id);
  const now = recoveryNow(input.now);
  if (!input.workerId || input.workerId.length > 128) throw new RecoveryError('RECOVERY_WORKER_INVALID', 400);
  if (!['QUEUED', 'RUNNING', 'VERIFYING'].includes(operation.status) || !['queued', 'running'].includes(job.status)) throw new RecoveryError('RECOVERY_TERMINAL');
  if (recoveryMillis(job.runAfter) > Date.parse(now) || (job.lockedAt && recoveryMillis(job.lockedAt) + 60_000 > Date.parse(now))) throw new RecoveryError('RECOVERY_LEASE_BUSY');
  let sourceFailure = false;
  try { currentRecoverySource(state, operation); }
  catch (error) { if (error instanceof RecoveryError) sourceFailure = true; else throw error; }
  if (sourceFailure || job.attempts >= 3 || (operation.deadlineAt && recoveryMillis(operation.deadlineAt) <= Date.parse(now))) {
    const failed = { ...operation, status: 'FAILED' as const, errorCode: sourceFailure ? 'SOURCE_CHANGED' : 'DEADLINE_EXCEEDED', updatedAt: now };
    const failedJob = { ...job, status: 'failed' as const, lockedBy: null, lockedAt: null, updatedAt: now };
    recoverySet(state, failed, failedJob);
    return { operation: failed, job: failedJob };
  }
  if (operation.status !== 'QUEUED' && operation.status !== 'RUNNING' && operation.status !== 'VERIFYING') throw new RecoveryError('RECOVERY_TERMINAL');
  const next = { ...operation, status: operation.status === 'QUEUED' ? 'RUNNING' as const : operation.status,
    startedAt: operation.startedAt ?? now, deadlineAt: operation.deadlineAt ?? new Date(Date.parse(now) + 1_800_000).toISOString(), updatedAt: now };
  const nextJob: RecoveryJob = { ...job, status: 'running', attempts: job.attempts + 1, lockedBy: input.workerId, lockedAt: now, updatedAt: now };
  recoverySet(state, next, nextJob);
  return { operation: next, job: nextJob };
}
export function mutateRecovery(state: RecoveryState, input: RecoveryFence, mutation: RecoveryMutation) {
  const { operation, job, now } = fenceRecovery(state, input);
  let next = operation;
  let nextJob = job;
  const attempt = state.attempts.find(row => row.backupId === operation.id && row.attempt === input.attempt);
  switch (mutation.action) {
    case 'heartbeat': nextJob = { ...job, lockedAt: now, updatedAt: now }; break;
    case 'retry':
      if (job.attempts >= 3) throw new RecoveryError('RECOVERY_ATTEMPTS_EXHAUSTED');
      nextJob = { ...job, status: 'queued', lockedBy: null, lockedAt: null, updatedAt: now }; break;
    case 'fail':
      recoveryTransition(input.kind, operation.status, 'FAILED');
      next = { ...operation, status: 'FAILED', errorCode: mutation.code, updatedAt: now };
      nextJob = { ...job, status: 'failed', lockedBy: null, lockedAt: null, updatedAt: now }; break;
    case 'intent':
      if (!('resourceId' in operation)) throw new RecoveryError('RECOVERY_KIND_INVALID');
      if (!operation.startedAt || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(mutation.keyVersion) || (attempt && attempt.keyVersion !== mutation.keyVersion)) throw new RecoveryError('RECOVERY_ATTEMPT_INVALID');
      if (!attempt) state.attempts.push({ backupId: operation.id, attempt: input.attempt, objectKey: recoveryObjectKey(operation, input.attempt), uploadId: null, keyVersion: mutation.keyVersion, firstClaimAt: operation.startedAt, candidateStoredBytes: null, candidatePlaintextBytes: null, candidateChecksum: null, state: 'INTENT', cleanupPending: true, createdAt: now, updatedAt: now });
      break;
    case 'upload':
      if (!attempt || (attempt.uploadId !== null && attempt.uploadId !== mutation.uploadId) || !['INTENT', 'UPLOADING'].includes(attempt.state) || mutation.uploadId.length < 1 || mutation.uploadId.length > 2048) throw new RecoveryError('RECOVERY_UPLOAD_INVALID');
      state.attempts = state.attempts.map(row => row === attempt ? { ...row, uploadId: mutation.uploadId, state: 'UPLOADING', updatedAt: now } : row); break;
    case 'candidate':
      if (!attempt || !['UPLOADING', 'PREPARED'].includes(attempt.state) || !/^[1-9][0-9]{0,10}$/.test(mutation.storedBytes) || !/^(0|[1-9][0-9]{0,10})$/.test(mutation.plaintextBytes) ||
        BigInt(mutation.storedBytes) > 10_737_418_240n || BigInt(mutation.plaintextBytes) > 10_737_418_240n || !/^[0-9a-f]{64}$/.test(mutation.checksum) ||
        (attempt.candidateStoredBytes !== null && (attempt.candidateStoredBytes !== mutation.storedBytes || attempt.candidatePlaintextBytes !== mutation.plaintextBytes || attempt.candidateChecksum !== mutation.checksum))) throw new RecoveryError('RECOVERY_CANDIDATE_INVALID');
      state.attempts = state.attempts.map(row => row === attempt ? { ...row, state: 'PREPARED', candidateStoredBytes: mutation.storedBytes, candidatePlaintextBytes: mutation.plaintextBytes, candidateChecksum: mutation.checksum, updatedAt: now } : row); break;
    case 'complete':
      if (!attempt || !attempt.uploadId || attempt.state !== 'PREPARED') throw new RecoveryError('RECOVERY_UPLOAD_INVALID');
      state.attempts = state.attempts.map(row => row === attempt ? { ...row, state: 'COMPLETE', updatedAt: now } : row); break;
    case 'verify':
      recoveryTransition(input.kind, operation.status, 'VERIFYING');
      if ('resourceId' in operation && (!attempt || attempt.state !== 'COMPLETE')) throw new RecoveryError('RECOVERY_ARTIFACT_UNVERIFIED');
      next = { ...operation, status: 'VERIFYING', updatedAt: now }; break;
    case 'ready': {
      recoveryTransition(input.kind, operation.status, 'READY');
      if ('resourceId' in operation) {
        const artifact = mutation.artifact;
        if (!attempt || attempt.state !== 'COMPLETE' || !artifact || attempt.candidateChecksum !== artifact.checksum || attempt.candidateStoredBytes !== artifact.size || attempt.keyVersion !== artifact.keyVersion) throw new RecoveryError('RECOVERY_ARTIFACT_UNVERIFIED');
        next = { ...operation, status: 'READY', artifactKey: attempt.objectKey, artifactChecksum: artifact.checksum, artifactSize: artifact.size, encryptionKeyVersion: artifact.keyVersion,
          winningAttempt: input.attempt, readyAt: now, expiresAt: new Date(Date.parse(now) + 30 * 86_400_000).toISOString(), updatedAt: now };
        state.attempts = state.attempts.map(row => row === attempt ? { ...row, state: 'VERIFIED', updatedAt: now } : row);
      } else {
        next = { ...operation, status: 'READY', readyAt: now, updatedAt: now };
        state.resources = state.resources.map(row => row.id === operation.targetResourceId ? { ...row, status: 'READY', desiredState: { ...row.desiredState, recoveryPublicationBlocked: false } } : row);
        state.pins = state.pins.filter(row => row.restoreId !== operation.id);
      }
      nextJob = { ...job, status: 'succeeded', lockedBy: null, lockedAt: null, updatedAt: now }; break;
    }
    default: return assertRecoveryNever(mutation);
  }
  recoverySet(state, next, nextJob);
  return { operation: next, job: nextJob };
}
function assertRecoveryNever(value: never): never { throw new RecoveryError('RECOVERY_MUTATION_INVALID', 400); }

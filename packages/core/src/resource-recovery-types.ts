import type { LIFECYCLE_CONTRACT } from './lifecycle.ts';

export type BackupStatus = keyof typeof LIFECYCLE_CONTRACT.machines.backup.states;
export type RestoreStatus = keyof typeof LIFECYCLE_CONTRACT.machines.restore.states;
export type RecoveryKind = 'backup' | 'restore';
export type RecoveryJson = null | boolean | number | string | readonly RecoveryJson[] | { readonly [key: string]: RecoveryJson };
export type RecoverySpec = { readonly [key: string]: RecoveryJson };
export type RecoveryScope = { readonly organizationId: string; readonly actorUserId: string };
export type RecoveryBody = { readonly requestIdempotencyKey: string; readonly formatVersion: 1; readonly name?: string };
export type RecoveryRequest = RecoveryScope & { readonly sourceId: string; readonly body: unknown; readonly now?: string };
export type RecoveryImage = {
  readonly schema: 'raibitserver.provider-image/v1'; readonly image: string;
  readonly workloadUid: string; readonly workloadGeneration: number; readonly observedAt: string;
};
export type RecoveryProvenance = {
  readonly providerImageProvenance: RecoveryImage;
  readonly providerIdentity: { readonly namespace: string; readonly name: string };
  readonly credentialSecretUID: string; readonly credentialSecretGeneration: string;
};
export type RecoveryResource = {
  readonly id: string; readonly projectId: string; readonly name: string; readonly slug: string;
  readonly type: string; readonly engine: string; readonly provider: string; readonly plan: string;
  readonly region: string; readonly version?: string | null; readonly status: string;
  readonly deletionRequestedAt?: string | null; readonly desiredSpec: RecoverySpec;
  readonly desiredState: RecoverySpec; readonly connectionSecretName?: string | null;
};
export type RecoveryProject = { readonly id: string; readonly organizationId: string; readonly status: string; readonly deletionRequestedAt?: string | null };
export type RecoveryMember = { readonly organizationId: string; readonly userId: string; readonly role: string };
export type CleanupLease = { readonly cleanupToken: string | null; readonly cleanupWorker: string | null; readonly cleanupLeaseUntil: string | null };
export type RecoveryBase = CleanupLease & {
  readonly id: string; readonly formatVersion: 1; readonly organizationId: string; readonly projectId: string;
  readonly engine: string; readonly provider: string; readonly sourceGeneration: string;
  readonly requestedByUserId: string; readonly requestIdempotencyKey: string; readonly requestFingerprint: string;
  readonly createdAt: string; readonly updatedAt: string; readonly startedAt: string | null;
  readonly deadlineAt: string | null; readonly readyAt: string | null; readonly errorCode: string | null;
};
export type RecoveryBackup = RecoveryBase & {
  readonly resourceId: string; readonly status: BackupStatus; readonly sourceProvenance: RecoveryProvenance;
  readonly sourceSpec: RecoverySpec; readonly artifactKey: string | null; readonly artifactChecksum: string | null;
  readonly artifactSize: string | null; readonly encryptionKeyVersion: string | null;
  readonly winningAttempt: number | null; readonly expiresAt: string | null;
};
export type RecoveryRestore = RecoveryBase & {
  readonly backupId: string; readonly sourceResourceId: string; readonly targetResourceId: string;
  readonly status: RestoreStatus; readonly targetCleanedAt: string | null;
};
export type RecoveryPin = {
  readonly id: string; readonly kind: 'ARTIFACT_SOURCE' | 'RESTORE_TARGET'; readonly resourceId: string;
  readonly backupId: string; readonly restoreId: string | null; readonly createdAt: string;
};
export type RecoveryAttempt = {
  readonly backupId: string; readonly attempt: number; readonly objectKey: string; readonly uploadId: string | null;
  readonly keyVersion: string; readonly firstClaimAt: string;
  readonly candidateStoredBytes: string | null; readonly candidatePlaintextBytes: string | null; readonly candidateChecksum: string | null;
  readonly state: 'INTENT' | 'UPLOADING' | 'PREPARED' | 'COMPLETE' | 'VERIFIED' | 'CLEANED';
  readonly cleanupPending: boolean; readonly createdAt: string; readonly updatedAt: string;
};
export type RecoveryJob = {
  readonly id: string; readonly type: 'resource.backup' | 'resource.restore'; readonly targetType: 'resource-backup' | 'resource-restore';
  readonly targetId: string; readonly payload: { readonly version: 1; readonly operationId: string };
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly attempts: number; readonly maxAttempts: number; readonly lockedBy: string | null; readonly lockedAt: string | null;
  readonly createdAt: string; readonly updatedAt: string; readonly runAfter: string;
};
// A transaction owns these mutable collections; returned records remain readonly.
export type RecoveryState = {
  organizations: { readonly id: string }[]; projects: RecoveryProject[]; resources: RecoveryResource[];
  members: RecoveryMember[]; backups: RecoveryBackup[]; restores: RecoveryRestore[];
  pins: RecoveryPin[]; attempts: RecoveryAttempt[]; jobs: RecoveryJob[];
  legacyBackups: { readonly id: string; readonly resourceId: string }[];
};
export type RecoveryFence = {
  readonly organizationId: string; readonly kind: RecoveryKind; readonly operationId: string;
  readonly workerId: string; readonly attempt: number; readonly now?: string;
};
export type RecoveryClaim = Omit<RecoveryFence, 'attempt'>;
export type RecoveryCleanupFence = RecoveryClaim & { readonly token: string };
export type RecoveryArtifact = { readonly checksum: string; readonly size: string; readonly keyVersion: string };
export type RecoveryMutation =
  | { readonly action: 'heartbeat' }
  | { readonly action: 'verify' }
  | { readonly action: 'ready'; readonly artifact?: RecoveryArtifact }
  | { readonly action: 'fail'; readonly code: 'RECOVERY_EXECUTION_FAILED' | 'SOURCE_CHANGED' | 'DEADLINE_EXCEEDED' }
  | { readonly action: 'retry' }
  | { readonly action: 'intent'; readonly keyVersion: string }
  | { readonly action: 'candidate'; readonly storedBytes: string; readonly plaintextBytes: string; readonly checksum: string }
  | { readonly action: 'upload'; readonly uploadId: string }
  | { readonly action: 'complete' };
export type RecoveryResult = { readonly operation: RecoveryBackup | RecoveryRestore; readonly job: RecoveryJob };
export interface RecoveryTransaction {
  run<T>(organizationId: string, work: (state: RecoveryState) => T | Promise<T>): Promise<T>;
}
export type RecoveryQuotaPolicy = (state: Readonly<RecoveryState>, request: RecoveryRequest, kind: RecoveryKind) => void | Promise<void>;

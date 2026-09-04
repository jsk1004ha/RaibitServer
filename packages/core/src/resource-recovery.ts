import { RecoveryError, recoveryRecord } from './resource-recovery-provenance.ts';
import { createRecovery, recoveryAuthorized, recoveryMillis, recoveryNow, recoverySet, recoveryTransition } from './resource-recovery-state.ts';
import { claimRecovery, mutateRecovery } from './resource-recovery-worker.ts';
import { cancelRecoveryRestore, expireRecoveryBackup, claimRecoveryCleanup, finishRecoveryCleanup } from './resource-recovery-cleanup.ts';
import type { RecoveryTransaction, RecoveryQuotaPolicy, RecoveryKind, RecoveryRequest, RecoveryScope, RecoveryClaim, RecoveryFence, RecoveryMutation, RecoveryCleanupFence, RecoveryBackup, RecoveryRestore, RecoveryState, ResourceBackupView, ResourceRestoreView } from './resource-recovery-types.ts';

type BackupListOptions = { readonly limit?: number; readonly cursor?: string | null; readonly now?: string };
type BackupCursor = { readonly v: 1; readonly at: string; readonly id: string };
const PUBLIC_RECOVERY_ERROR_CODES: ReadonlySet<string> = new Set(['RECOVERY_EXECUTION_FAILED', 'SOURCE_CHANGED', 'DEADLINE_EXCEEDED']);

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
      const backup = state.backups.find(row => row.id === id && row.organizationId === scope.organizationId);
      if (backup) {
        recoveryAuthorized(state, scope, 'backup:manage');
        return publicBackup(backup);
      }
      const legacy = state.legacyBackups.find(row => row.id === id && state.resources.some(resource => resource.id === row.resourceId && state.projects.some(project => project.id === resource.projectId && project.organizationId === scope.organizationId)));
      if (legacy) {
        recoveryAuthorized(state, scope, 'backup:manage');
        return { id: legacy.id, resourceId: legacy.resourceId, status: 'FAILED', errorCode: 'LEGACY_BACKUP_UNVERIFIED', recoverable: false };
      }
      throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
    });
  }
  listBackups(scope: RecoveryScope, resourceId: string, options: BackupListOptions = {}): Promise<{ readonly backups: readonly ResourceBackupView[]; readonly nextCursor: string | null }> {
    return this.transaction.run(scope.organizationId, state => {
      requireResourceOwner(state, resourceId, scope.organizationId);
      recoveryAuthorized(state, scope, 'backup:manage');
      const limit = options.limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RecoveryError('RECOVERY_LIMIT_INVALID', 400);
      const cursor = options.cursor ? decodeBackupCursor(options.cursor) : null;
      const rows = state.backups
        .filter(row => row.formatVersion === 1 && row.resourceId === resourceId && row.organizationId === scope.organizationId)
        .filter(row => !cursor || row.createdAt < cursor.at || (row.createdAt === cursor.at && row.id < cursor.id))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .slice(0, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { backups: page.map(row => publicBackup(row, options.now)), nextCursor: rows.length > limit && last ? encodeBackupCursor(last) : null };
    });
  }
  getRestore(scope: RecoveryScope, id: string): Promise<ResourceRestoreView> {
    return this.transaction.run(scope.organizationId, state => {
      const restore = state.restores.find(row => row.id === id && row.organizationId === scope.organizationId);
      if (!restore) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
      recoveryAuthorized(state, scope, 'backup:restore');
      return publicRestore(restore);
    });
  }
  requestBackupDeletion(scope: RecoveryScope, id: string, input: unknown, now?: string): Promise<ResourceBackupView> {
    return this.transaction.run(scope.organizationId, state => {
      const backup = state.backups.find(row => row.id === id && row.organizationId === scope.organizationId);
      if (!backup) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
      recoveryAuthorized(state, scope, 'backup:manage');
      requireDeleteConfirmation(input);
      if (backup.status === 'DELETING' || backup.status === 'DELETED') return publicBackup(backup, now);
      if (!['READY', 'FAILED', 'EXPIRED'].includes(backup.status)) throw new RecoveryError('RECOVERY_CLEANUP_INELIGIBLE');
      if (state.pins.some(pin => pin.backupId === backup.id && pin.kind === 'RESTORE_TARGET')) throw new RecoveryError('RECOVERY_RESTORE_PINNED');
      recoveryTransition('backup', backup.status, 'DELETING');
      const at = recoveryNow(now);
      const next = { ...backup, status: 'DELETING' as const, updatedAt: at };
      recoverySet(state, next);
      state.auditEvents.push({ actorUserId: scope.actorUserId, action: 'resource.backup:delete-requested', targetType: 'resource-backup', targetId: next.id,
        metadata: { engine: next.engine, status: next.status }, createdAt: at });
      return publicBackup(next, at);
    });
  }
  claim(input: RecoveryClaim) { return this.transaction.run(input.organizationId, state => structuredClone(claimRecovery(state, input))); }
  mutate(input: RecoveryFence, mutation: RecoveryMutation) { return this.transaction.run(input.organizationId, state => structuredClone(mutateRecovery(state, input, mutation))); }
  cancelRestore(input: RecoveryScope & { readonly operationId: string; readonly now?: string }) { return this.transaction.run(input.organizationId, state => structuredClone(cancelRecoveryRestore(state, input))); }
  expireBackup(input: { readonly organizationId: string; readonly operationId: string; readonly now?: string }) { return this.transaction.run(input.organizationId, state => structuredClone(expireRecoveryBackup(state, input))); }
  claimCleanup(input: RecoveryClaim) { return this.transaction.run(input.organizationId, state => structuredClone(claimRecoveryCleanup(state, input))); }
  finishCleanup(input: RecoveryCleanupFence) { return this.transaction.run(input.organizationId, state => structuredClone(finishRecoveryCleanup(state, input))); }
}

export function publicBackup(operation: RecoveryBackup, now?: string): ResourceBackupView {
  const common = { id: operation.id, organizationId: operation.organizationId, projectId: operation.projectId, engine: operation.engine,
    status: operation.status, createdAt: operation.createdAt, readyAt: operation.readyAt, errorCode: publicRecoveryError(operation.errorCode) };
  const current = Date.parse(recoveryNow(now));
  return { ...common, resourceId: operation.resourceId, size: operation.artifactSize, expiresAt: operation.expiresAt,
    recoverable: operation.status === 'READY' && Boolean(operation.expiresAt) && recoveryMillis(operation.expiresAt ?? '') > current };
}
export function publicRestore(operation: RecoveryRestore): ResourceRestoreView {
  return { id: operation.id, organizationId: operation.organizationId, projectId: operation.projectId, engine: operation.engine,
    status: operation.status, createdAt: operation.createdAt, readyAt: operation.readyAt, errorCode: publicRecoveryError(operation.errorCode),
    backupId: operation.backupId, sourceResourceId: operation.sourceResourceId, targetResourceId: operation.targetResourceId };
}
export function publicRecovery(operation: RecoveryBackup | RecoveryRestore, now?: string): ResourceBackupView | ResourceRestoreView {
  return 'resourceId' in operation ? publicBackup(operation, now) : publicRestore(operation);
}
function publicRecoveryError(code: string | null): string | null {
  return code && PUBLIC_RECOVERY_ERROR_CODES.has(code) ? code : null;
}
function requireResourceOwner(state: RecoveryState, resourceId: string, organizationId: string): void {
  const resource = state.resources.find(row => row.id === resourceId);
  if (!resource || !state.projects.some(project => project.id === resource.projectId && project.organizationId === organizationId)) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
}
function requireDeleteConfirmation(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RecoveryError('RECOVERY_INPUT_INVALID', 400);
  const keys = Reflect.ownKeys(input).filter(key => Object.prototype.propertyIsEnumerable.call(input, key));
  if (keys.length === 0) throw new RecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 400);
  if (keys.length !== 1 || keys[0] !== 'confirmed') throw new RecoveryError('RECOVERY_INPUT_INVALID', 400);
  const confirmed = Reflect.get(input, 'confirmed');
  if (confirmed === false) throw new RecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 400);
  if (confirmed !== true) throw new RecoveryError('RECOVERY_INPUT_INVALID', 400);
}
function encodeBackupCursor(row: Pick<RecoveryBackup, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ v: 1, at: row.createdAt, id: row.id } satisfies BackupCursor)).toString('base64url');
}
function decodeBackupCursor(value: string): BackupCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RecoveryError('RECOVERY_CURSOR_INVALID', 400);
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new RecoveryError('RECOVERY_CURSOR_INVALID', 400); throw error; }
  const record = recoveryRecord(decoded);
  if (Object.keys(record).length !== 3 || record.v !== 1 || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || typeof record.id !== 'string' || !record.id) throw new RecoveryError('RECOVERY_CURSOR_INVALID', 400);
  return { v: 1, at: record.at, id: record.id };
}
export * from './resource-recovery-types.ts';
export { RecoveryError, captureRecoveryProvenance, recoveryBody, recoveryObjectKey } from './resource-recovery-provenance.ts';

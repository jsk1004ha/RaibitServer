import crypto from 'node:crypto';
import { can } from './rbac.ts';
import { LIFECYCLE_CONTRACT } from './lifecycle.ts';
import { captureRecoveryProvenance, canonicalRecoveryJson, recoveryBody, recoveryHash, RecoveryError } from './resource-recovery-provenance.ts';
import type { BackupStatus, RestoreStatus, RecoveryState, RecoveryRequest, RecoveryKind, RecoveryBase, RecoveryResource, RecoveryBackup, RecoveryRestore, RecoveryJob, RecoveryScope } from './resource-recovery-types.ts';

export function recoveryNow(value?: string): string {
  const now = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new RecoveryError('RECOVERY_TIME_INVALID', 400);
  return new Date(now).toISOString();
}
export function recoveryMillis(value: string): number {
  // PostgreSQL TIMESTAMP(3) is timezone-less; this contract stores it as UTC.
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value);
}
export function recoveryAuthorized(state: RecoveryState, scope: RecoveryScope, permission: 'backup:manage' | 'backup:restore'): void {
  const member = state.members.find(row => row.organizationId === scope.organizationId && row.userId === scope.actorUserId);
  if (!member || !state.organizations.some(row => row.id === scope.organizationId)) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  if (!can(member.role, permission)) throw new RecoveryError('RECOVERY_FORBIDDEN', 403);
}
export function activeRecoveryResource(state: RecoveryState, id: string, organizationId: string): RecoveryResource {
  const resource = state.resources.find(row => row.id === id);
  const project = state.projects.find(row => row.id === resource?.projectId && row.organizationId === organizationId);
  if (!resource || !project) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  if (project.status !== 'ACTIVE' || project.deletionRequestedAt || resource.deletionRequestedAt || ['DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(resource.status)) throw new RecoveryError('RECOVERY_PARENT_DELETING');
  return resource;
}
export function recoveryBackup(state: RecoveryState, id: string, organizationId: string): RecoveryBackup {
  const backup = state.backups.find(row => row.id === id && row.organizationId === organizationId);
  if (!backup) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  if (backup.formatVersion !== 1 || !backup.sourceProvenance) throw new RecoveryError('LEGACY_BACKUP_UNVERIFIED');
  return backup;
}
export function recoveryJob(state: RecoveryState, operationId: string): RecoveryJob {
  const job = state.jobs.find(row => row.targetId === operationId);
  if (!job) throw new RecoveryError('RECOVERY_JOB_MISSING');
  return job;
}
export function recoveryTransition(kind: RecoveryKind, from: BackupStatus | RestoreStatus, to: BackupStatus | RestoreStatus): void {
  const states: Readonly<Record<string, { readonly next: readonly string[] }>> = LIFECYCLE_CONTRACT.machines[kind].states;
  if (from === to || !states[from]?.next.includes(to)) throw new RecoveryError('RECOVERY_TRANSITION_INVALID');
}
export function recoverySet(state: RecoveryState, operation: RecoveryBackup | RecoveryRestore, job?: RecoveryJob): void {
  if ('resourceId' in operation) state.backups = state.backups.map(row => row.id === operation.id ? operation : row);
  else state.restores = state.restores.map(row => row.id === operation.id ? operation : row);
  if (job) state.jobs = state.jobs.map(row => row.id === job.id ? job : row);
}
export function createRecovery(state: RecoveryState, request: RecoveryRequest, kind: RecoveryKind) {
  const body = recoveryBody(request.body, kind === 'restore');
  const now = recoveryNow(request.now);
  const fingerprint = recoveryHash(canonicalRecoveryJson({ formatVersion: body.formatVersion, sourceId: request.sourceId, name: body.name ?? null, kind }));
  const existing = kind === 'backup'
    ? state.backups.find(row => row.resourceId === request.sourceId && row.organizationId === request.organizationId && row.requestIdempotencyKey === body.requestIdempotencyKey)
    : state.restores.find(row => row.backupId === request.sourceId && row.organizationId === request.organizationId && row.requestIdempotencyKey === body.requestIdempotencyKey);
  if (existing) {
    recoveryAuthorized(state, request, kind === 'restore' ? 'backup:restore' : 'backup:manage');
    if (existing.requestFingerprint !== fingerprint) throw new RecoveryError('IDEMPOTENCY_CONFLICT');
    return { operation: existing, job: recoveryJob(state, existing.id), replay: true };
  }
  if (kind === 'backup') {
    const resource = state.resources.find(row => row.id === request.sourceId);
    if (!resource || !state.projects.some(project => project.id === resource.projectId && project.organizationId === request.organizationId)) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  } else if (!state.backups.some(row => row.id === request.sourceId && row.organizationId === request.organizationId)) {
    throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  }
  recoveryAuthorized(state, request, kind === 'restore' ? 'backup:restore' : 'backup:manage');
  const sourceBackup = kind === 'restore' ? recoveryBackup(state, request.sourceId, request.organizationId) : null;
  const source = activeRecoveryResource(state, sourceBackup?.resourceId ?? request.sourceId, request.organizationId);
  if (source.status !== 'READY') throw new RecoveryError('SOURCE_NOT_READY');
  if (!['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey'].includes(source.engine)) throw new RecoveryError('RECOVERY_ENGINE_UNSUPPORTED');
  const provenance = captureRecoveryProvenance(source);
  if (sourceBackup && (sourceBackup.status !== 'READY' || !sourceBackup.expiresAt || recoveryMillis(sourceBackup.expiresAt) <= Date.parse(now) || !sourceBackup.artifactKey || !sourceBackup.artifactChecksum || !sourceBackup.artifactSize || !sourceBackup.encryptionKeyVersion)) throw new RecoveryError('BACKUP_NOT_RECOVERABLE');
  if (sourceBackup && sourceBackup.sourceGeneration !== provenance.sourceGeneration) throw new RecoveryError('SOURCE_CHANGED');
  const base: RecoveryBase = {
    id: `${kind}_${crypto.randomUUID()}`, formatVersion: 1, organizationId: request.organizationId, projectId: source.projectId,
    engine: source.engine, provider: source.provider, sourceGeneration: provenance.sourceGeneration,
    requestedByUserId: request.actorUserId, requestIdempotencyKey: body.requestIdempotencyKey, requestFingerprint: fingerprint,
    createdAt: now, updatedAt: now, startedAt: null, deadlineAt: null, readyAt: null, errorCode: null,
    cleanupToken: null, cleanupWorker: null, cleanupLeaseUntil: null,
  };
  let operation: RecoveryBackup | RecoveryRestore;
  if (sourceBackup) {
    const name = body.name ?? '';
    if (state.resources.some(row => row.projectId === source.projectId && (row.name === name || row.slug === name))) throw new RecoveryError('RESTORE_TARGET_EXISTS');
    const targetId = `res_${crypto.randomUUID()}`;
    const desiredSpec = sourceBackup.sourceSpec.desiredSpec;
    if (!desiredSpec || typeof desiredSpec !== 'object' || Array.isArray(desiredSpec)) throw new RecoveryError('SOURCE_PROVENANCE_UNAVAILABLE');
    state.resources.push({ id: targetId, projectId: source.projectId, name, slug: name, type: source.type, engine: source.engine,
      provider: source.provider, plan: source.plan, region: source.region, version: source.version ?? null,
      status: 'PROVISIONING', deletionRequestedAt: null, connectionSecretName: null, desiredSpec: Object.fromEntries(Object.entries(desiredSpec)),
      desiredState: { recoveryRestoreId: base.id, recoveryPublicationBlocked: true } });
    operation = { ...base, status: 'QUEUED', backupId: sourceBackup.id, sourceResourceId: source.id, targetResourceId: targetId, targetCleanedAt: null };
    state.restores.push(operation);
    state.pins.push({ id: `pin_${crypto.randomUUID()}`, kind: 'RESTORE_TARGET', resourceId: targetId, backupId: sourceBackup.id, restoreId: base.id, createdAt: now });
  } else {
    operation = { ...base, ...provenance, resourceId: source.id, status: 'QUEUED', artifactKey: null, artifactChecksum: null, artifactSize: null, encryptionKeyVersion: null, winningAttempt: null, expiresAt: null };
    state.backups.push(operation);
    state.pins.push({ id: `pin_${crypto.randomUUID()}`, kind: 'ARTIFACT_SOURCE', resourceId: source.id, backupId: base.id, restoreId: null, createdAt: now });
  }
  const type = kind === 'backup' ? 'resource.backup' : 'resource.restore';
  const job: RecoveryJob = { id: `job_${recoveryHash(`${type}\0${base.id}`)}`, type, targetType: kind === 'backup' ? 'resource-backup' : 'resource-restore', targetId: base.id,
    payload: { version: 1, operationId: base.id }, status: 'queued', attempts: 0, maxAttempts: 3, lockedBy: null, lockedAt: null, createdAt: now, updatedAt: now, runAfter: now };
  state.jobs.push(job);
  state.auditEvents.push({ actorUserId: request.actorUserId, action: kind === 'backup' ? 'resource.backup:requested' : 'resource.restore:requested',
    targetType: kind === 'backup' ? 'resource-backup' : 'resource-restore', targetId: base.id,
    metadata: { engine: base.engine, status: operation.status }, createdAt: now });
  return { operation, job, replay: false };
}

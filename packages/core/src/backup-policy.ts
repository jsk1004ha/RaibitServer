import crypto from 'node:crypto';
import { ScheduledRecoveryWriterIntentSchema, type ScheduledRecoveryWriterIntent } from '@raibitserver/schemas/operational';

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const SUPPORTED_ENGINES: ReadonlySet<string> = new Set(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);

export type BackupOrigin = 'manual' | 'scheduled';
export type BackupPolicyRecord = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly resourceId: string;
  readonly createdByUserId: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly timezone: 'Asia/Seoul';
  readonly localMinute: number;
  readonly nextRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type BackupPolicyContext = {
  readonly dbNow: string;
  readonly actorRole: string;
  readonly resourceStatus: string;
  readonly engine: string;
  readonly localBackupCapability: boolean;
  readonly quotaAvailable: boolean;
  readonly operatorRecoveryReady: boolean;
  readonly writerProtocolReady: boolean;
  readonly policy: BackupPolicyRecord;
};
export type BackupPolicySnapshot = Readonly<{
  requiredProtocolVersion: 2;
  resourceId: string;
  environmentId: string;
  environmentKind: 'prod' | 'dev';
  enabled: true;
  timezone: 'Asia/Seoul';
  localMinute: number;
  origin: 'scheduled';
  retention: Readonly<{ mode: 'success-count'; count: 7 }>;
  expectedVersion: number;
}>;
export type BackupRunStatus = 'DUE' | 'SKIPPED' | 'RUNNING' | 'READY' | 'FAILED';
export type BackupRunSkipReason = 'MISSED_WINDOW' | 'OVERLAPPING_BACKUP' | 'POLICY_DISABLED' | 'SOURCE_NOT_READY' | 'ENGINE_UNSUPPORTED' | 'CAPABILITY_UNAVAILABLE' | 'QUOTA_EXCEEDED' | 'OPERATOR_RECOVERY_NOT_READY';
export type BackupRunRecord = {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly resourceId: string;
  readonly environmentId: string;
  readonly scheduledAtUtc: string;
  readonly origin: 'scheduled';
  readonly status: BackupRunStatus;
  readonly skipReason: BackupRunSkipReason | null;
  readonly backupId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly policySnapshot: BackupPolicySnapshot;
};
export type ScheduledBackupCandidate = {
  readonly id: string;
  readonly origin: BackupOrigin;
  readonly status: string;
  readonly readyAt: string | null;
  readonly pinned: boolean;
};
export type BackupPolicyErrorCode =
  | 'BACKUP_POLICY_INPUT_INVALID'
  | 'BACKUP_POLICY_FORBIDDEN'
  | 'BACKUP_POLICY_VERSION_CONFLICT'
  | 'BACKUP_POLICY_SOURCE_NOT_READY'
  | 'BACKUP_POLICY_ENGINE_UNSUPPORTED'
  | 'BACKUP_POLICY_CAPABILITY_UNAVAILABLE'
  | 'BACKUP_POLICY_QUOTA_EXCEEDED'
  | 'BACKUP_POLICY_OPERATOR_NOT_READY'
  | 'BACKUP_POLICY_WRITER_NOT_READY'
  | 'BACKUP_POLICY_NOT_FOUND';

export class BackupPolicyError extends Error {
  readonly name = 'BackupPolicyError';
  readonly code: BackupPolicyErrorCode;
  readonly statusCode: number;
  constructor(code: BackupPolicyErrorCode, statusCode: number) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function nextDailyKstRun(dbNow: string, localMinute = 180): string {
  const now = parsedTime(dbNow);
  if (!Number.isInteger(localMinute) || localMinute < 0 || localMinute > 1439) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  const local = new Date(now + KST_OFFSET_MS);
  const candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Math.floor(localMinute / 60), localMinute % 60) - KST_OFFSET_MS;
  return new Date(candidate <= now ? candidate + DAY_MS : candidate).toISOString();
}

export function occurrenceKey(policyId: string, scheduledAtUtc: string): string {
  const scheduled = new Date(parsedTime(scheduledAtUtc)).toISOString();
  return crypto.createHash('sha256').update(`${policyId}:${scheduled}`).digest('hex');
}

export function applyBackupPolicyMutation(context: BackupPolicyContext, input: unknown): BackupPolicyRecord {
  const parsed = ScheduledRecoveryWriterIntentSchema.safeParse(input);
  if (!parsed.success) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  const intent = parsed.data;
  const policy = context.policy;
  if (intent.resourceId !== policy.resourceId || intent.environmentId !== policy.environmentId) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  if (context.actorRole !== 'OWNER' && context.actorRole !== 'ADMIN') throw new BackupPolicyError('BACKUP_POLICY_FORBIDDEN', 403);
  if (intent.expectedVersion !== policy.version) throw new BackupPolicyError('BACKUP_POLICY_VERSION_CONFLICT', 409);
  if (intent.enabled) assertAdmission(context);
  const updatedAt = new Date(parsedTime(context.dbNow)).toISOString();
  return Object.freeze({
    ...policy,
    version: policy.version + 1,
    enabled: intent.enabled,
    timezone: intent.timezone,
    localMinute: intent.localMinute,
    nextRunAt: intent.enabled ? nextDailyKstRun(updatedAt, intent.localMinute) : null,
    updatedAt,
  });
}

export function scheduledPolicySnapshot(policy: BackupPolicyRecord, environmentKind: 'prod' | 'dev' = 'prod'): BackupPolicySnapshot {
  if (!policy.enabled) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  const parsed = parseScheduledRecoveryIntent({
    requiredProtocolVersion: 2,
    resourceId: policy.resourceId,
    environmentId: policy.environmentId,
    environmentKind,
    enabled: true,
    timezone: 'Asia/Seoul',
    localMinute: policy.localMinute,
    origin: 'scheduled',
    retention: Object.freeze({ mode: 'success-count', count: 7 }),
    expectedVersion: policy.version,
  });
  if (!parsed.retention) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  return Object.freeze({ ...parsed, enabled: true, retention: parsed.retention });
}

export function coalesceDailyKstOccurrences(input: Readonly<{ policyId: string; nextRunAt: string; dbNow: string; localMinute: number }>): Readonly<{
  due: Readonly<{ policyId: string; scheduledAtUtc: string; key: string }> | null;
  skippedOlderCount: number;
  skippedOlder: Readonly<{ status: 'SKIPPED'; reason: 'MISSED_WINDOW'; firstScheduledAtUtc: string; lastScheduledAtUtc: string; count: number }> | null;
}> {
  const now = parsedTime(input.dbNow);
  const firstDue = parsedTime(input.nextRunAt);
  const next = parsedTime(nextDailyKstRun(new Date(now - DAY_MS).toISOString(), input.localMinute));
  const latestDue = next > now ? next - DAY_MS : next;
  if (firstDue > latestDue || now - latestDue >= DAY_MS) return Object.freeze({ due: null, skippedOlderCount: 0, skippedOlder: null });
  const scheduledAtUtc = new Date(latestDue).toISOString();
  const skippedOlderCount = Math.max(0, Math.floor((latestDue - firstDue) / DAY_MS));
  return Object.freeze({
    due: Object.freeze({ policyId: input.policyId, scheduledAtUtc, key: occurrenceKey(input.policyId, scheduledAtUtc) }),
    skippedOlderCount,
    skippedOlder: skippedOlderCount === 0 ? null : Object.freeze({
      status: 'SKIPPED', reason: 'MISSED_WINDOW', firstScheduledAtUtc: new Date(firstDue).toISOString(),
      lastScheduledAtUtc: new Date(latestDue - DAY_MS).toISOString(), count: skippedOlderCount,
    }),
  });
}

export function scheduledRetentionDecision(backups: readonly ScheduledBackupCandidate[], policyEnabled: boolean): Readonly<{
  retainedIds: readonly string[];
  deleteIds: readonly string[];
}> {
  const successes = [...backups]
    .filter(backup => backup.origin === 'scheduled' && backup.status === 'READY' && backup.readyAt !== null)
    .sort((left, right) => (right.readyAt ?? '').localeCompare(left.readyAt ?? '') || right.id.localeCompare(left.id));
  if (!policyEnabled) return Object.freeze({ retainedIds: Object.freeze(successes.map(backup => backup.id)), deleteIds: Object.freeze([]) });
  const retained = successes.filter((backup, index) => index < 7 || backup.pinned).map(backup => backup.id);
  const deleting = successes.filter((backup, index) => index >= 7 && !backup.pinned).map(backup => backup.id);
  return Object.freeze({ retainedIds: Object.freeze(retained), deleteIds: Object.freeze(deleting) });
}

export function backupExpiryForOrigin(origin: BackupOrigin, readyAt: string): string | null {
  const ready = parsedTime(readyAt);
  return origin === 'manual' ? new Date(ready + 30 * DAY_MS).toISOString() : null;
}

function assertAdmission(context: BackupPolicyContext): void {
  if (context.resourceStatus !== 'READY') throw new BackupPolicyError('BACKUP_POLICY_SOURCE_NOT_READY', 409);
  if (!SUPPORTED_ENGINES.has(context.engine)) throw new BackupPolicyError('BACKUP_POLICY_ENGINE_UNSUPPORTED', 400);
  if (!context.localBackupCapability) throw new BackupPolicyError('BACKUP_POLICY_CAPABILITY_UNAVAILABLE', 409);
  if (!context.quotaAvailable) throw new BackupPolicyError('BACKUP_POLICY_QUOTA_EXCEEDED', 409);
  if (!context.operatorRecoveryReady) throw new BackupPolicyError('BACKUP_POLICY_OPERATOR_NOT_READY', 409);
  if (!context.writerProtocolReady) throw new BackupPolicyError('BACKUP_POLICY_WRITER_NOT_READY', 409);
}

function parsedTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  return parsed;
}

export function parseScheduledRecoveryIntent(input: unknown): ScheduledRecoveryWriterIntent {
  const parsed = ScheduledRecoveryWriterIntentSchema.safeParse(input);
  if (!parsed.success) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  return parsed.data;
}

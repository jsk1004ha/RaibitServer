import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { BackupPolicyError, applyBackupPolicyMutation, parseScheduledRecoveryIntent, type BackupPolicyContext, type BackupPolicyRecord, type BackupRunRecord, type BackupRunSkipReason } from './backup-policy.ts';

type PolicySubject = Readonly<Record<string, unknown>>;
type ScopeRow = {
  readonly dbNow: Date;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly resourceId: string;
  readonly resourceStatus: string;
  readonly engine: string;
  readonly actorRole: string;
  readonly approvalStatus: string;
  readonly quotaLimit: number | null;
};
type PolicyRow = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly resourceId: string;
  readonly createdByUserId: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly timezone: string;
  readonly localMinute: number;
  readonly nextRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};
type RunRow = {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly resourceId: string;
  readonly environmentId: string;
  readonly scheduledAtUtc: Date;
  readonly policySnapshot: unknown;
  readonly status: string;
  readonly skipReason: string | null;
  readonly backupId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
};

export class PrismaBackupPolicyPersistence {
  private readonly prisma: PrismaClient;
  private readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(prisma: PrismaClient, environment: Readonly<Record<string, string | undefined>> = process.env) {
    this.prisma = prisma;
    this.environment = environment;
  }

  getBackupPolicyContext(input: Readonly<{ resourceId: string; subject: PolicySubject }>): Promise<BackupPolicyContext> {
    return this.prisma.$transaction(async transaction => {
      await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
      return this.context(transaction, input, false);
    });
  }

  updateBackupPolicy(input: Readonly<{ resourceId: string; subject: PolicySubject; input: unknown }>): Promise<BackupPolicyRecord> {
    return this.prisma.$transaction(async transaction => {
      await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
      const context = await this.context(transaction, input, true);
      const next = applyBackupPolicyMutation(context, input.input);
      const rows = await transaction.$queryRawUnsafe<PolicyRow[]>(
        `UPDATE "BackupPolicy" SET "enabled"=$2,"timezone"=$3,"localMinute"=$4,"nextRunAt"=$5,"version"="version"+1,"updatedAt"=$6
         WHERE "id"=$1 AND "version"=$7 RETURNING *`,
        next.id, next.enabled, next.timezone, next.localMinute, next.nextRunAt ? new Date(next.nextRunAt) : null, new Date(next.updatedAt), context.policy.version,
      );
      const updated = rows[0];
      if (!updated) throw new BackupPolicyError('BACKUP_POLICY_VERSION_CONFLICT', 409);
      await transaction.auditLog.create({ data: {
        actorUserId: actorId(input.subject), action: next.enabled ? 'resource.backup-policy:enabled' : 'resource.backup-policy:disabled',
        targetType: 'backup-policy', targetId: next.id, metadata: { resourceId: next.resourceId, environmentId: next.environmentId, version: next.version },
      } });
      return policyRecord(updated);
    }, { isolationLevel: 'Serializable' });
  }

  listBackupPolicyRuns(input: Readonly<{ resourceId: string; subject: PolicySubject; query: Readonly<Record<string, unknown>> }>): Promise<Readonly<{ runs: readonly BackupRunRecord[]; nextCursor: string | null }>> {
    return this.prisma.$transaction(async transaction => {
      await transaction.$executeRawUnsafe("SET LOCAL raibitserver.operational_protocol = '2'");
      const context = await this.context(transaction, input, false);
      const page = runPage(input.query);
      const rows = await transaction.$queryRawUnsafe<RunRow[]>(
        `SELECT r.* FROM "BackupPolicyRun" r WHERE r."policyId"=$1
         AND ($2::timestamptz IS NULL OR (r."scheduledAtUtc",r."id") < ($2::timestamptz,$3::text))
         ORDER BY r."scheduledAtUtc" DESC,r."id" DESC LIMIT $4`,
        context.policy.id, page.at, page.id, page.limit + 1,
      );
      const visible = rows.slice(0, page.limit).map(runRecord);
      const last = visible.at(-1);
      return Object.freeze({ runs: Object.freeze(visible), nextCursor: rows.length > page.limit && last ? encodeCursor(last.scheduledAtUtc, last.id) : null });
    });
  }

  private async context(transaction: Prisma.TransactionClient, input: Readonly<{ resourceId: string; subject: PolicySubject }>, lock: boolean): Promise<BackupPolicyContext> {
    const userId = actorId(input.subject);
    const lockSql = lock ? 'FOR UPDATE OF o,p,r,e' : '';
    const rows = await transaction.$queryRawUnsafe<ScopeRow[]>(
      `SELECT clock_timestamp() AS "dbNow",o.id AS "organizationId",p.id AS "projectId",e.id AS "environmentId",r.id AS "resourceId",
        r.status AS "resourceStatus",r.engine,m.role AS "actorRole",u."approvalStatus",
        (SELECT q."maxDbStorageMb" FROM "Quota" q WHERE q."userId"=u.id ORDER BY q."updatedAt" DESC LIMIT 1) AS "quotaLimit"
       FROM "Resource" r JOIN "Project" p ON p.id=r."projectId" JOIN "Organization" o ON o.id=p."organizationId"
       JOIN "EnvironmentResource" er ON er."resourceId"=r.id AND er."projectId"=p.id
       JOIN "Environment" e ON e.id=er."environmentId" AND e."projectId"=p.id
       JOIN "Membership" m ON m."organizationId"=o.id AND m."userId"=$2 JOIN "User" u ON u.id=m."userId"
       WHERE r.id=$1 AND p.status='ACTIVE' AND p."deletionRequestedAt" IS NULL AND r."deletionRequestedAt" IS NULL AND e.status='active' ${lockSql}`,
      input.resourceId, userId,
    );
    const scope = rows[0];
    if (!scope || !subjectAllowsOrganization(input.subject, scope.organizationId)) throw new BackupPolicyError('BACKUP_POLICY_NOT_FOUND', 404);
    const policy = await this.policy(transaction, scope, userId);
    const image = this.environment[`RAIBITSERVER_RECOVERY_TOOL_${scope.engine.toUpperCase()}_IMAGE`];
    const imageReady = typeof image === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image);
    const operatorRecoveryReady = this.environment.RAIBITSERVER_PROVISIONER_BACKUP_ENABLED === '1'
      && Boolean(this.environment.RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT)
      && Boolean(this.environment.RAIBITSERVER_PROVISIONER_BACKUP_BUCKET)
      && Boolean(this.environment.RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE);
    return Object.freeze({
      dbNow: scope.dbNow.toISOString(), actorRole: scope.actorRole, resourceStatus: scope.resourceStatus, engine: scope.engine,
      localBackupCapability: this.environment.RAIBITSERVER_RESOURCE_ENVIRONMENT === 'local' && imageReady,
      quotaAvailable: scope.approvalStatus === 'APPROVED' && (scope.quotaLimit === null || scope.quotaLimit > 0),
      operatorRecoveryReady,
      writerProtocolReady: this.environment.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED === '1'
        && this.environment.RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE === '1'
        && this.environment.RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION === '2'
        && this.environment.RAIBITSERVER_RELEASE_SOURCE_CLEAN === '1'
        && /^[a-f0-9]{40}$/.test(this.environment.RAIBITSERVER_RELEASE_REVISION ?? '')
        && /^[a-f0-9]{64}$/.test(this.environment.RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST ?? ''),
      policy,
    });
  }

  private async policy(transaction: Prisma.TransactionClient, scope: ScopeRow, creator: string): Promise<BackupPolicyRecord> {
    const existing = await transaction.$queryRawUnsafe<PolicyRow[]>('SELECT * FROM "BackupPolicy" WHERE "resourceId"=$1 AND "environmentId"=$2', scope.resourceId, scope.environmentId);
    const row = existing[0];
    if (row) return policyRecord(row);
    const id = `backup_policy_${crypto.createHash('sha256').update(`${scope.resourceId}:${scope.environmentId}`).digest('hex').slice(0, 32)}`;
    const inserted = await transaction.$queryRawUnsafe<PolicyRow[]>(
      `INSERT INTO "BackupPolicy" (id,"organizationId","projectId","environmentId","resourceId","createdByUserId",enabled,version,timezone,"localMinute","nextRunAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,1,'Asia/Seoul',180,NULL,$7,$7) ON CONFLICT ("resourceId","environmentId") DO NOTHING RETURNING *`,
      id, scope.organizationId, scope.projectId, scope.environmentId, scope.resourceId, creator, scope.dbNow,
    );
    const created = inserted[0];
    if (created) return policyRecord(created);
    const winner = await transaction.$queryRawUnsafe<PolicyRow[]>('SELECT * FROM "BackupPolicy" WHERE "resourceId"=$1 AND "environmentId"=$2', scope.resourceId, scope.environmentId);
    if (!winner[0]) throw new BackupPolicyError('BACKUP_POLICY_NOT_FOUND', 404);
    return policyRecord(winner[0]);
  }
}

function policyRecord(row: PolicyRow): BackupPolicyRecord {
  if (row.timezone !== 'Asia/Seoul') throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  return Object.freeze({ ...row, timezone: 'Asia/Seoul', nextRunAt: row.nextRunAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}

function runRecord(row: RunRow): BackupRunRecord {
  const snapshot = parseScheduledRecoveryIntent(row.policySnapshot);
  const status = backupRunStatus(row.status);
  if (!snapshot.enabled || !snapshot.retention) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  const skipReason = backupRunSkipReason(row.skipReason);
  if ((status === 'SKIPPED') !== (skipReason !== null)) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  return Object.freeze({
    id: row.id, policyId: row.policyId, policyVersion: row.policyVersion, resourceId: row.resourceId, environmentId: row.environmentId,
    scheduledAtUtc: row.scheduledAtUtc.toISOString(), origin: 'scheduled', status, skipReason, backupId: row.backupId,
    startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    policySnapshot: Object.freeze({ ...snapshot, enabled: true, retention: snapshot.retention }),
  });
}

function backupRunStatus(value: string): BackupRunRecord['status'] {
  switch (value) {
    case 'DUE': return 'DUE';
    case 'SKIPPED': return 'SKIPPED';
    case 'RUNNING': return 'RUNNING';
    case 'READY': return 'READY';
    case 'FAILED': return 'FAILED';
    default: throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  }
}

function backupRunSkipReason(value: string | null): BackupRunSkipReason | null {
  switch (value) {
    case null: return null;
    case 'MISSED_WINDOW': return 'MISSED_WINDOW';
    case 'OVERLAPPING_BACKUP': return 'OVERLAPPING_BACKUP';
    case 'POLICY_DISABLED': return 'POLICY_DISABLED';
    case 'SOURCE_NOT_READY': return 'SOURCE_NOT_READY';
    case 'ENGINE_UNSUPPORTED': return 'ENGINE_UNSUPPORTED';
    case 'CAPABILITY_UNAVAILABLE': return 'CAPABILITY_UNAVAILABLE';
    case 'QUOTA_EXCEEDED': return 'QUOTA_EXCEEDED';
    case 'OPERATOR_RECOVERY_NOT_READY': return 'OPERATOR_RECOVERY_NOT_READY';
    default: throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  }
}

function actorId(subject: PolicySubject): string {
  if (typeof subject.id !== 'string' || !subject.id) throw new BackupPolicyError('BACKUP_POLICY_NOT_FOUND', 404);
  return subject.id;
}

function subjectAllowsOrganization(subject: PolicySubject, organizationId: string): boolean {
  if (subject.global === true) return true;
  const ids = [subject.organizationId, ...(Array.isArray(subject.organizationIds) ? subject.organizationIds : [])];
  return ids.some(value => typeof value === 'string' && value === organizationId);
}

function runPage(query: Readonly<Record<string, unknown>>): Readonly<{ limit: number; at: Date | null; id: string | null }> {
  if (Object.keys(query).some(key => key !== 'limit' && key !== 'cursor')) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  if (query.cursor === undefined) return Object.freeze({ limit, at: null, id: null });
  if (typeof query.cursor !== 'string') throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
    const at = Reflect.get(parsed, 'at');
    const id = Reflect.get(parsed, 'id');
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof id !== 'string' || !id) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
    return Object.freeze({ limit, at: new Date(at), id });
  } catch (error) {
    if (error instanceof BackupPolicyError) throw error;
    if (error instanceof SyntaxError) throw new BackupPolicyError('BACKUP_POLICY_INPUT_INVALID', 400);
    throw error;
  }
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

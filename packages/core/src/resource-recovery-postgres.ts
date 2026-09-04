import type { RecoveryState, RecoveryTransaction } from './resource-recovery-types.ts';
import { RecoveryError } from './resource-recovery-provenance.ts';

export interface RecoverySql {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface RecoverySqlClient extends RecoverySql {
  $transaction<T>(work: (tx: RecoverySql) => Promise<T>, options?: { readonly timeout?: number; readonly maxWait?: number }): Promise<T>;
}
type Table = 'Resource' | 'ResourceBackup' | 'ResourceRestore' | 'ResourceRecoveryPin' | 'ResourceRecoveryAttempt' | 'WorkflowJob';

async function recoveryRows<T>(tx: RecoverySql, sql: string, organizationId: string): Promise<T[]> {
  const rows = await tx.$queryRawUnsafe<{ readonly row: T }[]>(sql, organizationId);
  return rows.map(result => result.row);
}
export class PostgresRecoveryTransaction implements RecoveryTransaction {
  readonly client: RecoverySqlClient;
  constructor(client: RecoverySqlClient) { this.client = client; }
  run<T>(organizationId: string, work: (state: RecoveryState) => T | Promise<T>): Promise<T> {
    return this.client.$transaction(async tx => {
      // Org-scoped serialization prevents replay races; all subsequent lock orders are stable.
      const organizations = await recoveryRows<RecoveryState['organizations'][number]>(tx, 'SELECT to_jsonb(o) AS row FROM "Organization" o WHERE id=$1 FOR UPDATE', organizationId);
      const projects = await recoveryRows<RecoveryState['projects'][number]>(tx, 'SELECT to_jsonb(p) AS row FROM "Project" p WHERE "organizationId"=$1 ORDER BY id FOR UPDATE', organizationId);
      const resources = await recoveryRows<RecoveryState['resources'][number]>(tx, 'SELECT to_jsonb(r) AS row FROM "Resource" r WHERE "projectId" IN (SELECT id FROM "Project" WHERE "organizationId"=$1) ORDER BY id FOR UPDATE', organizationId);
      const members = await recoveryRows<RecoveryState['members'][number]>(tx, 'SELECT to_jsonb(m) AS row FROM "Membership" m WHERE "organizationId"=$1', organizationId);
      const backups = await recoveryRows<RecoveryState['backups'][number]>(tx, 'SELECT to_jsonb(b) || jsonb_build_object(\'artifactSize\',b."artifactSize"::text) AS row FROM "ResourceBackup" b WHERE "organizationId"=$1 AND "formatVersion"=1 ORDER BY id FOR UPDATE', organizationId);
      const restores = await recoveryRows<RecoveryState['restores'][number]>(tx, 'SELECT to_jsonb(r) AS row FROM "ResourceRestore" r WHERE "organizationId"=$1 ORDER BY id FOR UPDATE', organizationId);
      const pins = await recoveryRows<RecoveryState['pins'][number]>(tx, 'SELECT to_jsonb(p) AS row FROM "ResourceRecoveryPin" p WHERE "backupId" IN (SELECT id FROM "ResourceBackup" WHERE "organizationId"=$1) ORDER BY id FOR UPDATE', organizationId);
      const attempts = await recoveryRows<RecoveryState['attempts'][number]>(tx, 'SELECT to_jsonb(a) || jsonb_build_object(\'candidateStoredBytes\',a."candidateStoredBytes"::text,\'candidatePlaintextBytes\',a."candidatePlaintextBytes"::text) AS row FROM "ResourceRecoveryAttempt" a WHERE "backupId" IN (SELECT id FROM "ResourceBackup" WHERE "organizationId"=$1) ORDER BY "backupId",attempt FOR UPDATE', organizationId);
      const jobs = await recoveryRows<RecoveryState['jobs'][number]>(tx, 'SELECT to_jsonb(j) AS row FROM "WorkflowJob" j WHERE (type=\'resource.backup\' AND "targetId" IN (SELECT id FROM "ResourceBackup" WHERE "organizationId"=$1)) OR (type=\'resource.restore\' AND "targetId" IN (SELECT id FROM "ResourceRestore" WHERE "organizationId"=$1)) ORDER BY id FOR UPDATE', organizationId);
      const legacyBackups = await recoveryRows<RecoveryState['legacyBackups'][number]>(tx, 'SELECT jsonb_build_object(\'id\',b.id,\'resourceId\',b."resourceId") AS row FROM "ResourceBackup" b JOIN "Resource" r ON r.id=b."resourceId" JOIN "Project" p ON p.id=r."projectId" WHERE p."organizationId"=$1 AND b."formatVersion" IS NULL', organizationId);
      const state: RecoveryState = { organizations, projects, resources, members, backups, restores, pins, attempts, jobs, auditEvents: [], legacyBackups };
      const before = structuredClone(state);
      const result = await work(state);
      await persistRecoveryState(tx, before, state);
      return result;
    }, { timeout: 30_000, maxWait: 30_000 });
  }
}
async function persistRecoveryState(tx: RecoverySql, before: RecoveryState, next: RecoveryState) {
  const sets = [
    { table: 'Resource', before: before.resources, next: next.resources },
    { table: 'ResourceBackup', before: before.backups, next: next.backups },
    { table: 'ResourceRestore', before: before.restores, next: next.restores },
    { table: 'ResourceRecoveryPin', before: before.pins, next: next.pins },
    { table: 'ResourceRecoveryAttempt', before: before.attempts, next: next.attempts },
    { table: 'WorkflowJob', before: before.jobs, next: next.jobs },
  ] as const;
  for (const set of sets) {
    const previous = new Set(set.before.map(row => JSON.stringify(row)));
    for (const row of set.next) if (!previous.has(JSON.stringify(row))) await writeRecoveryRow(tx, set.table, row);
  }
  const remaining = new Set(next.pins.map(row => row.id));
  for (const pin of before.pins) if (!remaining.has(pin.id)) await tx.$executeRawUnsafe('DELETE FROM "ResourceRecoveryPin" WHERE id=$1', pin.id);
  for (const audit of next.auditEvents) await tx.$executeRawUnsafe(
    'INSERT INTO "AuditLog" ("actorUserId",action,"targetType","targetId",metadata,"createdAt") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
    audit.actorUserId, audit.action, audit.targetType, audit.targetId, JSON.stringify(audit.metadata), audit.createdAt,
  );
}
async function writeRecoveryRow(tx: RecoverySql, table: Table, row: object) {
  const data = { ...row, ...(table === 'Resource' ? { updatedAt: new Date().toISOString() } : {}) };
  const keys = Object.keys(data);
  if (keys.some(key => !/^[A-Za-z][A-Za-z0-9]*$/.test(key))) throw new RecoveryError('RECOVERY_COLUMN_INVALID');
  const columns = keys.map(key => `"${key}"`).join(',');
  const conflict = table === 'ResourceRecoveryAttempt' ? '"backupId",attempt' : 'id';
  const updates = keys.filter(key => key !== 'id' && key !== 'createdAt').map(key => `"${key}"=EXCLUDED."${key}"`).join(',');
  // Only typed internal rows reach this adapter; SQL values remain parameterized.
  await tx.$executeRawUnsafe(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}",$1::jsonb) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`, JSON.stringify(data));
}
export async function assertPostgresRecoveryPins(tx: RecoverySql, resourceIds: readonly string[]): Promise<void> {
  const pins = await tx.$queryRawUnsafe<{ readonly id: string }[]>('SELECT id FROM "ResourceRecoveryPin" WHERE "resourceId"=ANY($1::text[]) LIMIT 1', resourceIds);
  if (pins.length) throw new RecoveryError('RESOURCE_RECOVERY_PINNED');
}
export async function assertPostgresRecoveryPublished(tx: RecoverySql, resourceId: string): Promise<void> {
  const pins = await tx.$queryRawUnsafe<{ readonly id: string }[]>('SELECT id FROM "ResourceRecoveryPin" WHERE "resourceId"=$1 AND kind=\'RESTORE_TARGET\' LIMIT 1', resourceId);
  if (pins.length) throw new RecoveryError('RECOVERY_TARGET_UNPUBLISHED');
}

export async function lockRecoveryDeletion(tx: RecoverySql, target: { readonly projectId?: string; readonly resourceId?: string }): Promise<void> {
  const scope = await tx.$queryRawUnsafe<{ readonly organizationId: string; readonly projectId: string }[]>('SELECT p."organizationId",p.id AS "projectId" FROM "Project" p WHERE p.id=$1 OR p.id=(SELECT "projectId" FROM "Resource" WHERE id=$2)', target.projectId ?? null, target.resourceId ?? null);
  const owner = scope[0];
  if (!owner) return;
  await tx.$queryRawUnsafe('SELECT id FROM "Organization" WHERE id=$1 FOR UPDATE', owner.organizationId);
  await tx.$queryRawUnsafe('SELECT id FROM "Project" WHERE id=$1 FOR UPDATE', owner.projectId);
  const resources = await tx.$queryRawUnsafe<{ readonly id: string }[]>('SELECT id FROM "Resource" WHERE "projectId"=$1 AND ($2::text IS NULL OR id=$2) ORDER BY id FOR UPDATE', owner.projectId, target.resourceId ?? null);
  await assertPostgresRecoveryPins(tx, resources.map(row => row.id));
}

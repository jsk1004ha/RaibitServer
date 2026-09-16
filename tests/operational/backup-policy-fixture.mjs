export const operationalBackupEnvironment = () => ({
  RAIBITSERVER_RESOURCE_ENVIRONMENT: 'local',
  RAIBITSERVER_RECOVERY_TOOL_POSTGRESQL_IMAGE: `registry.example.test/recovery@sha256:${'a'.repeat(64)}`,
  RAIBITSERVER_PROVISIONER_BACKUP_ENABLED: '1',
  RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT: 'https://backup.example.test',
  RAIBITSERVER_PROVISIONER_BACKUP_BUCKET: 'fixture-backups',
  RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE: '/fixture/backup.json',
  RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED: '1',
  RAIBITSERVER_OPERATIONAL_IMPLEMENTATION_AVAILABLE: '1',
  RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION: '2',
  RAIBITSERVER_RELEASE_SOURCE_CLEAN: '1',
  RAIBITSERVER_RELEASE_REVISION: 'b'.repeat(40),
  RAIBITSERVER_OPERATIONAL_CONTRACT_DIGEST: 'c'.repeat(64),
});

export class PrismaPolicyFixture {
  constructor(coreContext, runs) {
    this.scope = {
      dbNow: new Date(coreContext.dbNow), organizationId: coreContext.policy.organizationId, projectId: coreContext.policy.projectId,
      environmentId: coreContext.policy.environmentId, resourceId: coreContext.policy.resourceId, resourceStatus: coreContext.resourceStatus,
      engine: coreContext.engine, actorRole: coreContext.actorRole, approvalStatus: 'APPROVED', quotaLimit: null,
    };
    this.policy = {
      ...coreContext.policy, nextRunAt: coreContext.policy.nextRunAt ? new Date(coreContext.policy.nextRunAt) : null,
      createdAt: new Date(coreContext.policy.createdAt), updatedAt: new Date(coreContext.policy.updatedAt),
    };
    this.runs = runs.map(run => ({ ...run, scheduledAtUtc: new Date(run.scheduledAtUtc), createdAt: new Date(run.scheduledAtUtc), startedAt: null, finishedAt: null, skipReason: null, backupId: null, errorCode: null }));
    this.audits = [];
    this.auditLog = { create: async input => { this.audits.push(input.data); return input.data; } };
  }

  async $transaction(work) { return work(this); }
  async $executeRawUnsafe() { return 1; }

  async $queryRawUnsafe(sql, ...values) {
    if (sql.includes('FROM "Resource" r JOIN')) {
      const userId = values[1];
      const actorRole = typeof userId === 'string' && userId.startsWith('fixture-') ? userId.slice('fixture-'.length) : 'OWNER';
      return [{ ...this.scope, actorRole }];
    }
    if (sql.startsWith('SELECT * FROM "BackupPolicy"')) return [this.policy];
    if (sql.startsWith('INSERT INTO "BackupPolicy"')) return [];
    if (sql.startsWith('UPDATE "BackupPolicy"')) {
      const expectedVersion = values[6];
      if (expectedVersion !== this.policy.version) return [];
      this.policy = {
        ...this.policy, enabled: values[1], timezone: values[2], localMinute: values[3], nextRunAt: values[4],
        version: this.policy.version + 1, updatedAt: values[5],
      };
      return [this.policy];
    }
    if (sql.includes('FROM "BackupPolicyRun"')) return this.runs;
    throw new Error(`unhandled fixture SQL: ${sql.slice(0, 40)}`);
  }
}

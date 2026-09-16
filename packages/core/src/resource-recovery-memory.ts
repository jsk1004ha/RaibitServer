import type { ControlPlaneStore } from './store.ts';
import type { RecoveryState, RecoveryTransaction, RecoveryTransactionContext } from './resource-recovery-types.ts';
import { RecoveryError } from './resource-recovery-provenance.ts';
import { productionEnvironmentId } from './operational-persistence.ts';

export function emptyRecoveryState(): RecoveryState {
  return { organizations: [], projects: [], resources: [], members: [], backups: [], restores: [], pins: [], attempts: [], jobs: [], auditEvents: [], legacyBackups: [] };
}
const memoryRecoveryTails = new WeakMap<RecoveryState, Promise<void>>();
export class MemoryRecoveryTransaction implements RecoveryTransaction {
  readonly state: RecoveryState;
  readonly store: ControlPlaneStore | undefined;
  constructor(state: RecoveryState = emptyRecoveryState(), store?: ControlPlaneStore) { this.state = state; this.store = store; }
  async run<T>(_organizationId: string, work: (state: RecoveryState) => T | Promise<T>, _context: RecoveryTransactionContext = {}): Promise<T> {
    const previous = memoryRecoveryTails.get(this.state) ?? Promise.resolve();
    let unlock = () => {};
    memoryRecoveryTails.set(this.state, new Promise<void>(resolve => { unlock = resolve; }));
    await previous;
    try {
      const storeRevision = this.store ? recoveryStoreRevision(this.store) : null;
      const candidate = structuredClone(this.state);
      if (this.store) {
        candidate.organizations = [...this.store.organizations.values()];
        candidate.projects = [...this.store.projects.values()];
        candidate.resources = structuredClone([...this.store.resources.values()].map(resource => {
          const binding = this.store?.environmentResources.get(resource.id);
          const environment = binding ? this.store?.environments.get(binding.environmentId) : null;
          if (binding && (!environment || (environment.kind !== 'prod' && environment.kind !== 'dev'))) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
          return binding && environment
            ? { ...resource, environmentId: binding.environmentId, environmentKind: environment.kind, logicalSlug: binding.logicalSlug, displayName: binding.displayName ?? null }
            : { ...resource, environmentId: productionEnvironmentId(resource.projectId), environmentKind: 'prod', logicalSlug: resource.slug, displayName: resource.name };
        }));
        candidate.members = [...this.store.members];
      }
      const beforeIds = new Set(candidate.resources.map(row => row.id));
      const beforeAuditCount = candidate.auditEvents.length;
      const result = await work(candidate);
      if (this.store && recoveryStoreRevision(this.store) !== storeRevision) throw new RecoveryError('RECOVERY_TRANSACTION_CONFLICT');
      Object.assign(this.state, candidate);
      if (this.store) {
        for (const resource of candidate.resources) {
          if (!beforeIds.has(resource.id)) this.store.environmentResources.set(resource.id, {
            resourceId: resource.id, projectId: resource.projectId, environmentId: resource.environmentId,
            logicalSlug: resource.logicalSlug, displayName: resource.displayName ?? resource.logicalSlug,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
          if (!beforeIds.has(resource.id) || this.store.resources.has(resource.id)) this.store.resources.set(resource.id, structuredClone(recoveryResourceRow(resource)));
        }
        const recoveryIds = new Set(candidate.jobs.map(job => job.id));
        this.store.workflowJobs = [...this.store.workflowJobs.filter(job => !recoveryIds.has(job.id)), ...structuredClone(candidate.jobs)];
        for (const audit of candidate.auditEvents.slice(beforeAuditCount)) this.store.audit(audit.actorUserId, audit.action, audit.targetType, audit.targetId, audit.metadata);
      }
      return result;
    } finally { unlock(); }
  }
}
function recoveryResourceRow(resource: RecoveryState['resources'][number]) {
  const { environmentId: _environmentId, environmentKind: _environmentKind, logicalSlug: _logicalSlug, displayName: _displayName, ...row } = resource;
  return row;
}
function recoveryStoreRevision(store: ControlPlaneStore): string {
  return JSON.stringify({
    organizations: [...store.organizations.values()],
    projects: [...store.projects.values()],
    resources: [...store.resources.values()],
    environments: [...store.environments.values()],
    environmentResources: [...store.environmentResources.values()],
    members: store.members,
  });
}
export function assertRecoveryPins(state: RecoveryState, resourceIds: readonly string[]): void {
  if (state.pins.some(pin => resourceIds.includes(pin.resourceId))) throw new RecoveryError('RESOURCE_RECOVERY_PINNED');
  const retiring = state.backups.filter(backup => resourceIds.includes(backup.resourceId));
  for (const backup of retiring) {
    if (backup.status !== 'DELETED' || state.attempts.some(row => row.backupId === backup.id && (row.cleanupPending || row.state !== 'CLEANED')) ||
      state.restores.some(row => row.backupId === backup.id && !(row.status === 'READY' || (['FAILED', 'CANCELLED'].includes(row.status) && row.targetCleanedAt)))) throw new RecoveryError('RECOVERY_CLEANUP_PENDING');
  }
}
export function retireMemoryRecovery(state: RecoveryState, resourceId: string): void {
  const retiring = new Set(state.backups.filter(row => row.resourceId === resourceId).map(row => row.id));
  state.backups = state.backups.filter(row => !retiring.has(row.id));
  state.restores = state.restores.filter(row => !retiring.has(row.backupId));
  state.attempts = state.attempts.filter(row => !retiring.has(row.backupId));
  state.legacyBackups = state.legacyBackups.filter(row => row.resourceId !== resourceId);
}
export function assertRecoveryTargetPublished(state: RecoveryState, resourceId: string): void {
  if (state.pins.some(pin => pin.resourceId === resourceId && pin.kind === 'RESTORE_TARGET')) throw new RecoveryError('RECOVERY_TARGET_UNPUBLISHED');
}

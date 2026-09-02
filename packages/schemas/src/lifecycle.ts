import { z } from 'zod';
import fixture from '../../../test-fixtures/contracts/lifecycle-v1.json' with { type: 'json' };

// Literal enums keep the public types closed; the exhaustive records below bind
// their membership to the shared fixture without duplicating transition policy.
export const DeploymentStatusSchema = z.enum(['queued', 'BUILDING', 'IMAGE_READY', 'DEPLOYING', 'READY', 'BUILD_FAILED', 'FAILED', 'CANCELLED', 'PREVIEW_CLEANUP_REQUESTED', 'ROLLBACK_REQUESTED', 'CLEANED_UP']);
export const WorkflowStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const ResourceStatusSchema = z.enum(['PROVISIONING', 'RECONCILING', 'READY', 'FAILED', 'DELETE_REQUESTED', 'DELETING', 'DELETED']);
export const BackupStatusSchema = z.enum(['QUEUED', 'RUNNING', 'VERIFYING', 'READY', 'FAILED', 'EXPIRED', 'DELETING', 'DELETED']);
export const RestoreStatusSchema = z.enum(['QUEUED', 'RUNNING', 'VERIFYING', 'READY', 'FAILED', 'CANCELLED']);
export const DomainStatusSchema = z.enum(['PENDING_VERIFICATION', 'VERIFIED', 'ROUTING', 'READY', 'FAILED', 'DELETING']);
export const TlsStatusSchema = z.enum(['PENDING', 'ISSUING', 'READY', 'FAILED']);
export const HealthStatusSchema = z.enum(['UNKNOWN', 'CHECKING', 'HEALTHY', 'DEGRADED']);
export const ResourceHealthStatusSchema = z.enum(['UNKNOWN', 'HEALTHY', 'UNHEALTHY']);

export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;
export type BackupStatus = z.infer<typeof BackupStatusSchema>;
export type RestoreStatus = z.infer<typeof RestoreStatusSchema>;
export type DomainStatus = z.infer<typeof DomainStatusSchema>;
export type TlsStatus = z.infer<typeof TlsStatusSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type ResourceHealthStatus = z.infer<typeof ResourceHealthStatusSchema>;

function machineSchema<T extends z.ZodEnum>(status: T) {
  return z.strictObject({
    initial: status,
    states: z.record(status, z.strictObject({ terminal: z.boolean(), next: z.array(status).readonly() }).readonly()).readonly(),
    aliases: z.record(z.string(), status).readonly(),
  }).readonly();
}

export const LifecycleContractSchema = z.strictObject({
  version: z.literal(1),
  semantics: z.strictObject({ terminal: z.string(), sameState: z.string() }),
  machines: z.strictObject({
    deployment: machineSchema(DeploymentStatusSchema),
    workflow: machineSchema(WorkflowStatusSchema),
    resource: machineSchema(ResourceStatusSchema),
    backup: machineSchema(BackupStatusSchema),
    restore: machineSchema(RestoreStatusSchema),
    domain: machineSchema(DomainStatusSchema),
    tls: machineSchema(TlsStatusSchema),
    health: machineSchema(HealthStatusSchema),
    resourceHealth: machineSchema(ResourceHealthStatusSchema),
  }),
});

export const LIFECYCLE_CONTRACT = LifecycleContractSchema.parse(fixture);

// SQL input boundaries also encounter historical lower/upper case and aliases.
export function terminalLifecycleInputs(
  states: Readonly<Record<string, Readonly<{ terminal: boolean }>>>,
  aliases: Readonly<Record<string, string>>,
): readonly string[] {
  const canonical = Object.entries(states).filter(([, state]) => state.terminal).map(([status]) => status);
  const legacy = Object.entries(aliases).filter(([, status]) => states[status].terminal).map(([alias]) => alias);
  return [...new Set([...canonical, ...legacy].flatMap(status => [status, status.toLowerCase(), status.toUpperCase()]))];
}

export function parseDeploymentStatus(input: unknown): DeploymentStatus {
  const key = String(input ?? LIFECYCLE_CONTRACT.machines.deployment.initial).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias = LIFECYCLE_CONTRACT.machines.deployment.aliases[key];
  return DeploymentStatusSchema.parse(alias ?? (key === 'queued' || key === '' ? 'queued' : key.toUpperCase()));
}

export function parseWorkflowStatus(input: unknown): WorkflowStatus {
  const key = String(input ?? LIFECYCLE_CONTRACT.machines.workflow.initial).trim().toLowerCase();
  return WorkflowStatusSchema.parse(LIFECYCLE_CONTRACT.machines.workflow.aliases[key] ?? (key || 'queued'));
}

import { DeploymentStatusSchema, LIFECYCLE_CONTRACT, parseDeploymentStatus } from '../../schemas/src/lifecycle.ts';
import type { DeploymentStatus } from '../../schemas/src/lifecycle.ts';

export const DEPLOYMENT_STATUSES = Object.freeze({
  QUEUED: DeploymentStatusSchema.enum.queued,
  BUILDING: DeploymentStatusSchema.enum.BUILDING,
  IMAGE_READY: DeploymentStatusSchema.enum.IMAGE_READY,
  DEPLOYING: DeploymentStatusSchema.enum.DEPLOYING,
  READY: DeploymentStatusSchema.enum.READY,
  BUILD_FAILED: DeploymentStatusSchema.enum.BUILD_FAILED,
  FAILED: DeploymentStatusSchema.enum.FAILED,
  CANCELLED: DeploymentStatusSchema.enum.CANCELLED,
  PREVIEW_CLEANUP_REQUESTED: DeploymentStatusSchema.enum.PREVIEW_CLEANUP_REQUESTED,
  ROLLBACK_REQUESTED: DeploymentStatusSchema.enum.ROLLBACK_REQUESTED,
  CLEANED_UP: DeploymentStatusSchema.enum.CLEANED_UP,
});

export const normalizeDeploymentStatus = parseDeploymentStatus;

// Compatibility entrypoints are input boundaries for stored legacy values.
export function canTransitionDeployment(from: unknown, to: unknown): boolean {
  const current = normalizeDeploymentStatus(from);
  const next = normalizeDeploymentStatus(to);
  return current === next || LIFECYCLE_CONTRACT.machines.deployment.states[current].next.includes(next);
}

export class DeploymentTransitionError extends Error {
  readonly from: DeploymentStatus;
  readonly to: DeploymentStatus;
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`invalid deployment status transition: ${from} -> ${to}`);
    this.name = 'DeploymentTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertDeploymentTransition(from: unknown, to: unknown): true {
  const current = normalizeDeploymentStatus(from);
  const next = normalizeDeploymentStatus(to);
  if (canTransitionDeployment(current, next)) return true;
  throw new DeploymentTransitionError(current, next);
}

export function canCancelDeployment(status: unknown): boolean {
  return LIFECYCLE_CONTRACT.machines.deployment.states[normalizeDeploymentStatus(status)].next.includes('CANCELLED');
}

export function isDeploymentTerminal(status: unknown): boolean {
  return LIFECYCLE_CONTRACT.machines.deployment.states[normalizeDeploymentStatus(status)].terminal;
}

import { LIFECYCLE_CONTRACT, parseDeploymentStatus } from './lifecycle.ts';
import type { DeploymentStatus } from './lifecycle.ts';

export const DEPLOYMENT_STATUSES = Object.freeze({
  QUEUED: 'queued',
  BUILDING: 'BUILDING',
  IMAGE_READY: 'IMAGE_READY',
  DEPLOYING: 'DEPLOYING',
  READY: 'READY',
  BUILD_FAILED: 'BUILD_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PREVIEW_CLEANUP_REQUESTED: 'PREVIEW_CLEANUP_REQUESTED',
  ROLLBACK_REQUESTED: 'ROLLBACK_REQUESTED',
  CLEANED_UP: 'CLEANED_UP',
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

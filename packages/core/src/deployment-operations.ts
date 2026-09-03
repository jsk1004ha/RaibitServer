import crypto from 'node:crypto';
import { normalizeDeploymentStatus } from './deployments.ts';
import { maskSecrets } from './secrets.ts';

export type DeploymentOperationBody = { readonly requestIdempotencyKey: string; readonly snapshotVersion: number };
export type DeploymentOperation = DeploymentOperationBody & {
  readonly operation: 'retry' | 'redeploy';
  readonly serviceId: string;
  readonly sourceDeploymentId?: string;
  readonly requestedByUserId: string;
};
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type DesiredSpecSnapshot = { [key: string]: Json };
export type LineageSource = {
  readonly id: string; readonly serviceId: string; readonly projectId: string;
  readonly status: string; readonly snapshotVersion?: number | null;
  readonly desiredSpecSnapshot?: Json; readonly sourceDeploymentId?: string | null;
  readonly commitSha?: string | null; readonly commitHash?: string | null;
  readonly imageUrl?: string | null; readonly imageDigest?: string | null;
  readonly branch?: string; readonly deploymentType?: string;
  readonly pullRequestNumber?: number | null; readonly previewUrl?: string | null;
};
export class DeploymentOperationError extends Error {
  readonly name = 'DeploymentOperationError';
  readonly code: 'INVALID_DEPLOYMENT_OPERATION' | 'DEPLOYMENT_SOURCE_NOT_FOUND' | 'SOURCE_INELIGIBLE' | 'STALE_SNAPSHOT' | 'SNAPSHOT_UNAVAILABLE' | 'ACTIVE_DEPLOYMENT' | 'IDEMPOTENCY_CONFLICT' | 'LINEAGE_JOB_MISSING';
  readonly statusCode: 400 | 404 | 409;
  constructor(code: DeploymentOperationError['code'], statusCode: 400 | 404 | 409 = 409) {
    super(code); this.code = code; this.statusCode = statusCode;
  }
}

// Core ships without sibling schema dependencies; this parser mirrors the public Zod boundary.
export function parseDeploymentOperationBody(value: unknown): DeploymentOperationBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeploymentOperationError('INVALID_DEPLOYMENT_OPERATION', 400);
  const input = Object.fromEntries(Object.entries(value));
  if (Object.keys(input).some(key => !['requestIdempotencyKey', 'snapshotVersion'].includes(key)) ||
      typeof input.requestIdempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestIdempotencyKey) ||
      typeof input.snapshotVersion !== 'number' || !Number.isSafeInteger(input.snapshotVersion) || input.snapshotVersion < 1) {
    throw new DeploymentOperationError('INVALID_DEPLOYMENT_OPERATION', 400);
  }
  return { requestIdempotencyKey: input.requestIdempotencyKey, snapshotVersion: input.snapshotVersion };
}

export function captureDeploymentSnapshot(service: Readonly<Record<string, unknown>>): DesiredSpecSnapshot {
  const desiredState = service.desiredState && typeof service.desiredState === 'object' && !Array.isArray(service.desiredState) ? service.desiredState : {};
  const desiredSpec = service.desiredSpec && typeof service.desiredSpec === 'object' && !Array.isArray(service.desiredSpec) ? service.desiredSpec : {};
  const spec = { ...service, ...desiredState, ...desiredSpec };
  delete spec.desiredState;
  delete spec.desiredSpec;
  // Tenant service writes already enforce secret-reference boundaries. Masking is
  // retained for legacy records; Kubernetes valueFrom references remain structured.
  return structuredClone(maskSecrets(spec));
}

export function operationIdentity(input: DeploymentOperation) {
  return { operation: input.operation, sourceDeploymentId: input.sourceDeploymentId ?? null, snapshotVersion: input.snapshotVersion };
}

export function assertOperationReplay(input: DeploymentOperation, payload: unknown) {
  const identity = payload && typeof payload === 'object' && 'operationRequest' in payload ? payload.operationRequest : null;
  if (!identity || typeof identity !== 'object' || !('operation' in identity) || !('sourceDeploymentId' in identity) || !('snapshotVersion' in identity) ||
      identity.operation !== input.operation || identity.sourceDeploymentId !== (input.sourceDeploymentId ?? null) || identity.snapshotVersion !== input.snapshotVersion) {
    throw new DeploymentOperationError('IDEMPOTENCY_CONFLICT');
  }
}

export function eligibleDeploymentSource(source: LineageSource) {
  return ['BUILD_FAILED', 'FAILED', 'READY'].includes(normalizeDeploymentStatus(source.status));
}

export function deploymentSuccessor(source: LineageSource | null, input: DeploymentOperation) {
  if (!source || source.serviceId !== input.serviceId) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
  const eligible = input.operation === 'retry' ? ['BUILD_FAILED', 'FAILED'].includes(normalizeDeploymentStatus(source.status)) : eligibleDeploymentSource(source);
  if (!eligible) throw new DeploymentOperationError('SOURCE_INELIGIBLE');
  if (!source.snapshotVersion || !source.desiredSpecSnapshot || typeof source.desiredSpecSnapshot !== 'object' || Array.isArray(source.desiredSpecSnapshot)) throw new DeploymentOperationError('SNAPSHOT_UNAVAILABLE');
  if (source.snapshotVersion !== 1 || input.snapshotVersion !== source.snapshotVersion) throw new DeploymentOperationError('STALE_SNAPSHOT');
  return {
    id: `dep_${crypto.randomUUID()}`, serviceId: source.serviceId, projectId: source.projectId,
    status: normalizeDeploymentStatus('QUEUED'), sourceDeploymentId: source.id,
    retryOfDeploymentId: input.operation === 'retry' ? source.id : null,
    requestIdempotencyKey: input.requestIdempotencyKey, requestedByUserId: input.requestedByUserId,
    snapshotVersion: source.snapshotVersion, desiredSpecSnapshot: structuredClone(source.desiredSpecSnapshot),
    commitSha: source.commitSha ?? source.commitHash ?? null, commitHash: source.commitHash ?? source.commitSha ?? null,
    imageUrl: source.imageUrl ?? null, imageDigest: source.imageDigest ?? null,
    branch: source.branch ?? 'main', deploymentType: source.deploymentType ?? 'production', triggerType: input.operation,
    pullRequestNumber: source.pullRequestNumber ?? null, previewUrl: source.previewUrl ?? null,
  };
}

export function successorWorkflow(deployment: ReturnType<typeof deploymentSuccessor>, input: DeploymentOperation) {
  return {
    type: deployment.deploymentType.toLowerCase() === 'preview' ? 'preview-deploy' : 'build-and-deploy',
    targetType: 'deployment', targetId: deployment.id,
    payload: { deploymentId: deployment.id, serviceId: deployment.serviceId, projectId: deployment.projectId,
      sourceDeploymentId: deployment.sourceDeploymentId, commitSha: deployment.commitSha,
      imageUrl: deployment.imageUrl, imageDigest: deployment.imageDigest, branch: deployment.branch,
      desiredSpecSnapshot: deployment.desiredSpecSnapshot, snapshotVersion: deployment.snapshotVersion,
      operationRequest: operationIdentity(input) },
  };
}

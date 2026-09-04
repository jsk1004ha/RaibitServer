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
  readonly previewLineageId?: string | null; readonly previewGeneration?: number | null;
  readonly previewRuntime?: Json;
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

function sourceKind(source: LineageSource, spec: DesiredSpecSnapshot): 'local' | 'image' | 'git' | 'other' {
  const text = (value: Json | undefined) => typeof value === 'string' ? value.trim() : '';
  const repo = text(spec.repoUrl) || text(spec.repositoryUrl);
  const sourceType = text(spec.sourceType).toLowerCase();
  const mode = text(spec.buildMode).toLowerCase().replaceAll('_', '-');
  if (text(spec.localPath)) return 'local';
  if (sourceType === 'image' || ['image', 'prebuilt', 'prebuilt-image'].includes(mode) || (!repo && source.imageUrl?.trim())) return 'image';
  return repo || ['git', 'github'].includes(sourceType) ? 'git' : 'other';
}

function immutableGitCommit(source: LineageSource): string {
  const sha = source.commitSha?.trim().toLowerCase() || '';
  const hash = source.commitHash?.trim().toLowerCase() || '';
  const commit = sha || hash;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || /^0+$/.test(commit) || (sha && hash && sha !== hash)) throw new DeploymentOperationError('SOURCE_INELIGIBLE');
  return commit;
}

function immutableImage(source: LineageSource) {
  const reference = source.imageUrl?.trim() || '';
  const parts = reference.split('@');
  const named = parts[0] || '';
  const tagOffset = named.lastIndexOf(':') > named.lastIndexOf('/') ? named.lastIndexOf(':') : -1;
  const repository = tagOffset < 0 ? named : named.slice(0, tagOffset);
  const tag = tagOffset < 0 ? null : named.slice(tagOffset + 1);
  const embedded = parts.length === 2 ? parts[1].toLowerCase() : '';
  const separate = source.imageDigest?.trim().toLowerCase() || '';
  const validDigest = (value: string) => /^sha256:[0-9a-f]{64}$/.test(value) && !/^sha256:0+$/.test(value);
  const digest = embedded || separate;
  const segments = repository.split('/');
  const registry = segments.length > 1 && /[.:]/.test(segments[0]) ? segments.shift() : null;
  const validRepository = segments.every(segment => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(segment));
  const validRegistry = registry === null || (/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?$/.test(registry) && (!registry.includes(':') || Number(registry.split(':')[1]) <= 65535));
  if (parts.length > 2 || !validRepository || !validRegistry || (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) ||
      !validDigest(digest) || (parts.length === 2 && !validDigest(embedded)) || (separate && !validDigest(separate)) || (embedded && separate && embedded !== separate)) throw new DeploymentOperationError('SOURCE_INELIGIBLE');
  return { imageUrl: `${repository}@${digest}`, imageDigest: digest };
}

export function deploymentSuccessor(source: LineageSource | null, input: DeploymentOperation) {
  if (!source || source.serviceId !== input.serviceId) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
  const eligible = input.operation === 'retry' ? ['BUILD_FAILED', 'FAILED'].includes(normalizeDeploymentStatus(source.status)) : eligibleDeploymentSource(source);
  if (!eligible) throw new DeploymentOperationError('SOURCE_INELIGIBLE');
  if (!source.snapshotVersion || !source.desiredSpecSnapshot || typeof source.desiredSpecSnapshot !== 'object' || Array.isArray(source.desiredSpecSnapshot)) throw new DeploymentOperationError('SNAPSHOT_UNAVAILABLE');
  if (source.snapshotVersion !== 1 || input.snapshotVersion !== source.snapshotVersion) throw new DeploymentOperationError('STALE_SNAPSHOT');
  const kind = sourceKind(source, source.desiredSpecSnapshot);
  const commit = kind === 'git' ? immutableGitCommit(source) : null;
  const image = kind === 'image' ? immutableImage(source) : { imageUrl: source.imageUrl ?? null, imageDigest: source.imageDigest ?? null };
  return {
    id: `dep_${crypto.randomUUID()}`, serviceId: source.serviceId, projectId: source.projectId,
    status: normalizeDeploymentStatus('QUEUED'), sourceDeploymentId: source.id,
    retryOfDeploymentId: input.operation === 'retry' ? source.id : null,
    requestIdempotencyKey: input.requestIdempotencyKey, requestedByUserId: input.requestedByUserId,
    snapshotVersion: source.snapshotVersion, desiredSpecSnapshot: structuredClone(source.desiredSpecSnapshot),
    commitSha: commit ?? source.commitSha ?? source.commitHash ?? null, commitHash: commit ?? source.commitHash ?? source.commitSha ?? null,
    ...image,
    branch: source.branch ?? 'main', deploymentType: source.deploymentType ?? 'production', triggerType: input.operation,
    pullRequestNumber: source.pullRequestNumber ?? null, previewUrl: source.previewUrl ?? null,
    previewLineageId: source.previewLineageId ?? null, previewGeneration: source.previewGeneration ?? null,
    previewRuntime: source.previewRuntime ?? null,
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
      ...(deployment.previewLineageId ? { lineageId: deployment.previewLineageId, lineageVersion: previewLineageVersion(deployment.previewRuntime),
        generation: deployment.previewGeneration, runtime: deployment.previewRuntime } : {}),
      operationRequest: operationIdentity(input) },
  };
}

function previewLineageVersion(value: Json | undefined): number | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.lineageVersion === 'number' ? value.lineageVersion : undefined;
}

export type DeploymentHistoryFilters = Readonly<{
  serviceId: string | null;
  environment: string | null;
  status: string | null;
  trigger: string | null;
  from: string | null;
  to: string | null;
}>;

export type DeploymentHistoryAction = Readonly<{
  type: 'retry' | 'redeploy' | 'cancel' | 'rollback';
  targetId: string;
  href: string;
  method: 'POST';
  confirmationRequired: true;
  snapshotVersion: number | null;
}>;

export type DeploymentHistoryRow = Readonly<{
  id: string;
  projectId: string;
  service: Readonly<{ id: string; name: string | null; slug: string | null }>;
  environment: string;
  status: string;
  trigger: string;
  createdAt: string;
  updatedAt: string;
  source: Readonly<{ commitSha: string | null; imageDigest: string | null; snapshotVersion: number | null }>;
  lineage: Readonly<{
    sourceDeploymentId: string | null;
    retryOfDeploymentId: string | null;
    rollbackOfDeploymentId: string | null;
    previousDeploymentId: string | null;
    previewLineageId: string | null;
    previewGeneration: number | null;
  }>;
  operation: Readonly<{ requestedByUserId: string | null; requestIdempotencyKey: string | null }>;
  health: Readonly<{
    rolloutStatus: string | null;
    publicHealthStatus: string | null;
    healthCheckedAt: string | null;
    healthFailureCode: string | null;
    observedGeneration: number | null;
  }>;
  recovery: Readonly<{ retryable: boolean; reason: string | null }>;
  permissions: Readonly<{ execute: boolean }>;
  eligibleAction: DeploymentHistoryAction | null;
}>;

export type DeploymentHistoryPage = Readonly<{
  deployments: readonly DeploymentHistoryRow[];
  page: Readonly<{ limit: number; nextCursor: string | null }>;
  filters: DeploymentHistoryFilters;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function stringOr(value: unknown, fallback: string): string {
  return text(value) ?? fallback;
}

function isActionType(value: string): value is DeploymentHistoryAction['type'] {
  return ['retry', 'redeploy', 'cancel', 'rollback'].includes(value);
}

function action(value: unknown): DeploymentHistoryAction | null {
  const entry = record(value);
  const type = text(entry?.type);
  const targetId = text(entry?.targetId);
  const href = text(entry?.href);
  if (!entry || !type || !targetId || !href || entry.method !== 'POST' || entry.confirmationRequired !== true) return null;
  if (!isActionType(type)) return null;
  const snapshotVersion = nullableInteger(entry.snapshotVersion);
  return { type, targetId, href, method: 'POST', confirmationRequired: true, snapshotVersion };
}

function row(value: unknown): DeploymentHistoryRow | null {
  const entry = record(value);
  const service = record(entry?.service);
  const source = record(entry?.source);
  const lineage = record(entry?.lineage);
  const operation = record(entry?.operation);
  const health = record(entry?.health);
  const recovery = record(entry?.recovery);
  const permissions = record(entry?.permissions);
  const id = text(entry?.id);
  const projectId = text(entry?.projectId);
  const serviceId = text(service?.id);
  if (!entry || !service || !source || !lineage || !operation || !health || !recovery || !permissions || !id || !projectId || !serviceId || typeof recovery.retryable !== 'boolean' || typeof permissions.execute !== 'boolean') return null;
  return {
    id,
    projectId,
    service: { id: serviceId, name: nullableText(service.name), slug: nullableText(service.slug) },
    environment: stringOr(entry.environment, 'unknown'),
    status: stringOr(entry.status, 'unknown'),
    trigger: stringOr(entry.trigger, 'unknown'),
    createdAt: stringOr(entry.createdAt, ''),
    updatedAt: stringOr(entry.updatedAt, ''),
    source: { commitSha: nullableText(source.commitSha), imageDigest: nullableText(source.imageDigest), snapshotVersion: nullableInteger(source.snapshotVersion) },
    lineage: {
      sourceDeploymentId: nullableText(lineage.sourceDeploymentId), retryOfDeploymentId: nullableText(lineage.retryOfDeploymentId), rollbackOfDeploymentId: nullableText(lineage.rollbackOfDeploymentId), previousDeploymentId: nullableText(lineage.previousDeploymentId), previewLineageId: nullableText(lineage.previewLineageId), previewGeneration: nullableInteger(lineage.previewGeneration),
    },
    operation: { requestedByUserId: nullableText(operation.requestedByUserId), requestIdempotencyKey: nullableText(operation.requestIdempotencyKey) },
    health: {
      rolloutStatus: nullableText(health.rolloutStatus), publicHealthStatus: nullableText(health.publicHealthStatus), healthCheckedAt: nullableText(health.healthCheckedAt), healthFailureCode: nullableText(health.healthFailureCode), observedGeneration: nullableInteger(health.observedGeneration),
    },
    recovery: { retryable: recovery.retryable, reason: nullableText(recovery.reason) },
    permissions: { execute: permissions.execute },
    eligibleAction: action(entry.eligibleAction),
  };
}

function filters(value: unknown): DeploymentHistoryFilters {
  const entry = record(value);
  return {
    serviceId: nullableText(entry?.serviceId),
    environment: nullableText(entry?.environment),
    status: nullableText(entry?.status),
    trigger: nullableText(entry?.trigger),
    from: nullableText(entry?.from),
    to: nullableText(entry?.to),
  };
}

export function deploymentHistoryPage(value: unknown): DeploymentHistoryPage {
  const entry = record(value);
  const page = record(entry?.page);
  const deployments = Array.isArray(entry?.deployments) ? entry.deployments.map(row).filter((value): value is DeploymentHistoryRow => value !== null) : [];
  return {
    deployments,
    page: { limit: integer(page?.limit) ?? 25, nextCursor: nullableText(page?.nextCursor) },
    filters: filters(entry?.filters),
  };
}

export function deploymentHistoryFromDetail(value: unknown): DeploymentHistoryRow | null {
  return row(value);
}

import crypto from 'node:crypto';
import { canCancelDeployment, isDeploymentTerminal, normalizeDeploymentStatus } from './deployments.ts';
import { deploymentSuccessor, DeploymentOperationError, type LineageSource } from './deployment-operations.ts';

export type DeploymentHistoryQuery = {
  readonly serviceId?: string;
  readonly environment?: 'production' | 'preview' | 'manual';
  readonly status?: ReturnType<typeof normalizeDeploymentStatus>;
  readonly trigger?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
};

export type DeploymentHistoryScope = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly cursorSecret: string;
};

export type HistoryDeployment = LineageSource & {
  readonly [key: string]: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
};

export class DeploymentHistoryError extends Error {
  readonly name = 'DeploymentHistoryError';
  readonly code = 'INVALID_DEPLOYMENT_HISTORY_QUERY';
  readonly statusCode = 400;
  constructor() { super('INVALID_DEPLOYMENT_HISTORY_QUERY'); }
}

export function parseDeploymentHistoryQuery(value: unknown): DeploymentHistoryQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeploymentHistoryError();
  const input = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
  const allowed = ['serviceId', 'environment', 'status', 'trigger', 'from', 'to', 'limit', 'cursor'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new DeploymentHistoryError();
  const serviceId = optionalMatch(input.serviceId, /^.{1,512}$/u);
  const environment = optionalEnvironment(input.environment);
  const trigger = optionalMatch(input.trigger, /^[A-Za-z0-9._:-]{1,128}$/);
  const from = optionalTimestamp(input.from);
  const to = optionalTimestamp(input.to);
  const cursor = optionalMatch(input.cursor, /^[A-Za-z0-9_-]{1,2048}$/);
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (from && to && from > to)) throw new DeploymentHistoryError();
  let status: ReturnType<typeof normalizeDeploymentStatus> | undefined;
  try { status = input.status === undefined ? undefined : normalizeDeploymentStatus(input.status); }
  catch (error) { if (error instanceof Error) throw new DeploymentHistoryError(); throw error; }
  return {
    limit,
    ...(serviceId ? { serviceId } : {}), ...(environment ? { environment } : {}), ...(status ? { status } : {}),
    ...(trigger ? { trigger } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(cursor ? { cursor } : {}),
  };
}

export function deploymentHistoryPage(input: {
  readonly deployments: readonly HistoryDeployment[];
  readonly actionDeployments?: readonly HistoryDeployment[];
  readonly services: readonly Record<string, unknown>[];
  readonly query: DeploymentHistoryQuery;
  readonly scope: DeploymentHistoryScope;
  readonly execute: boolean;
}) {
  const cursor = input.query.cursor ? decodeDeploymentHistoryCursor(input.query.cursor, input.scope, input.query) : null;
  const filtered = input.deployments.filter((row) => matchesFilters(row, input.query))
    .filter((row) => !cursor || comparePosition(row, cursor) < 0)
    .sort((left, right) => comparePosition(right, position(left)));
  const selected = filtered.slice(0, input.query.limit + 1);
  const pageRows = selected.slice(0, input.query.limit);
  const serviceById = new Map(input.services.map((service) => [String(service.id), service]));
  return {
    deployments: pageRows.map((deployment) => deploymentHistoryRow({
      deployment, service: serviceById.get(String(deployment.serviceId)) ?? {},
      serviceDeployments: (input.actionDeployments ?? input.deployments).filter((candidate) => candidate.serviceId === deployment.serviceId), execute: input.execute,
    })),
    page: {
      limit: input.query.limit,
      nextCursor: selected.length > input.query.limit && pageRows.length > 0
        ? encodeDeploymentHistoryCursor(position(pageRows[pageRows.length - 1]), input.scope, input.query) : null,
    },
    filters: publicFilters(input.query),
  };
}

export function deploymentHistoryRow(input: {
  readonly deployment: HistoryDeployment;
  readonly service: Record<string, unknown>;
  readonly serviceDeployments: readonly HistoryDeployment[];
  readonly execute: boolean;
}) {
  const row = input.deployment;
  const status = normalizeDeploymentStatus(row.status);
  const snapshotVersion = positiveInteger(row.snapshotVersion);
  const action = eligibleHistoryAction(row, input.serviceDeployments, input.execute, snapshotVersion);
  return {
    id: String(row.id), projectId: String(row.projectId),
    service: { id: String(input.service.id), name: String(input.service.name), slug: String(input.service.slug) },
    environment: environment(row.deploymentType), status, trigger: String(row.triggerType || 'manual'),
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
    source: { commitSha: nullableString(row.commitSha || row.commitHash), imageDigest: nullableString(row.imageDigest), snapshotVersion },
    lineage: {
      sourceDeploymentId: nullableString(row.sourceDeploymentId), retryOfDeploymentId: nullableString(row.retryOfDeploymentId),
      rollbackOfDeploymentId: nullableString(row.rollbackOfDeploymentId), previousDeploymentId: nullableString(row.previousDeploymentId),
      previewLineageId: nullableString(row.previewLineageId), previewGeneration: nonnegativeInteger(row.previewGeneration),
    },
    operation: { requestedByUserId: nullableString(row.requestedByUserId), requestIdempotencyKey: nullableString(row.requestIdempotencyKey) },
    health: {
      rolloutStatus: status, publicHealthStatus: String(row.publicHealthStatus || 'UNKNOWN'), healthCheckedAt: nullableTimestamp(row.healthCheckedAt),
      healthFailureCode: nullableString(row.healthFailureCode), observedGeneration: nonnegativeInteger(row.observedGeneration),
    },
    recovery: { retryable: action?.type === 'retry', reason: retryReason(row, input.serviceDeployments, input.execute) },
    permissions: { execute: input.execute }, eligibleAction: action,
  };
}

export function encodeDeploymentHistoryCursor(positionInput: HistoryPosition, scope: DeploymentHistoryScope, query: DeploymentHistoryQuery): string {
  const payload = { v: 1, o: scope.organizationId, p: scope.projectId, f: filterFingerprint(query), at: positionInput.at, id: positionInput.id };
  const material = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', cursorKey(scope.cursorSecret)).update(material).digest('base64url');
  return Buffer.from(JSON.stringify({ ...payload, h: signature }), 'utf8').toString('base64url');
}

export function decodeDeploymentHistoryCursor(value: string, scope: DeploymentHistoryScope, query: DeploymentHistoryQuery): HistoryPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isCursor(parsed) || parsed.o !== scope.organizationId || parsed.p !== scope.projectId || parsed.f !== filterFingerprint(query)) throw new DeploymentHistoryError();
    const { h, ...payload } = parsed;
    const expected = crypto.createHmac('sha256', cursorKey(scope.cursorSecret)).update(JSON.stringify(payload)).digest();
    const actual = Buffer.from(h, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new DeploymentHistoryError();
    return { at: timestamp(parsed.at), id: parsed.id };
  } catch (error) {
    if (error instanceof DeploymentHistoryError) throw error;
    throw new DeploymentHistoryError();
  }
}

type HistoryPosition = { readonly at: string; readonly id: string };
type HistoryAction = {
  readonly type: 'retry' | 'redeploy' | 'cancel' | 'rollback'; readonly targetId: string; readonly href: string;
  readonly method: 'POST'; readonly confirmationRequired: true; readonly snapshotVersion: number | null;
};

function eligibleHistoryAction(row: HistoryDeployment, serviceRows: readonly HistoryDeployment[], execute: boolean, snapshotVersion: number | null): HistoryAction | null {
  if (!execute) return null;
  const status = normalizeDeploymentStatus(row.status);
  if (canCancelDeployment(status)) return action('cancel', String(row.id), `/deployments/${row.id}/cancel`, null);
  if (['BUILD_FAILED', 'FAILED'].includes(status) && retryReason(row, serviceRows, true) === null) return action('retry', String(row.id), `/deployments/${row.id}/retry`, snapshotVersion);
  if (serviceRows.some((candidate) => candidate.id !== row.id && !isDeploymentTerminal(candidate.status))) return null;
  if (status === 'READY' && previousReady(serviceRows, row)) return action('rollback', String(row.id), `/deployments/${row.id}/rollback`, null);
  const source = [...serviceRows].filter((candidate) => canReplay(candidate, 'redeploy')).sort((left, right) => comparePosition(right, position(left)))[0];
  if (source && ['READY', 'CANCELLED', 'CLEANED_UP'].includes(status)) return action('redeploy', String(row.serviceId), `/services/${row.serviceId}/redeploy`, positiveInteger(source.snapshotVersion));
  return null;
}

function retryReason(row: HistoryDeployment, serviceRows: readonly HistoryDeployment[], execute: boolean): string | null {
  if (!execute) return 'PERMISSION_DENIED';
  if (!['BUILD_FAILED', 'FAILED'].includes(normalizeDeploymentStatus(row.status))) return 'STATUS_NOT_RETRYABLE';
  if (serviceRows.some((candidate) => candidate.id !== row.id && !isDeploymentTerminal(candidate.status))) return 'ACTIVE_DEPLOYMENT';
  if (!canReplay(row, 'retry')) return 'SOURCE_NOT_RETRYABLE';
  return null;
}

function canReplay(source: HistoryDeployment, operation: 'retry' | 'redeploy'): boolean {
  const snapshotVersion = positiveInteger(source.snapshotVersion);
  if (!snapshotVersion) return false;
  try {
    deploymentSuccessor(source, { operation, serviceId: source.serviceId, sourceDeploymentId: source.id, requestedByUserId: 'history', requestIdempotencyKey: 'history', snapshotVersion });
    return true;
  } catch (error) {
    if (error instanceof DeploymentOperationError) return false;
    throw error;
  }
}

function action(type: HistoryAction['type'], targetId: string, href: string, snapshotVersion: number | null): HistoryAction {
  return { type, targetId, href, method: 'POST', confirmationRequired: true, snapshotVersion };
}

function previousReady(rows: readonly HistoryDeployment[], current: HistoryDeployment): HistoryDeployment | null {
  return [...rows].filter((row) => row.id !== current.id && normalizeDeploymentStatus(row.status) === 'READY' && Boolean(row.imageUrl || row.image))
    .filter((row) => comparePosition(row, position(current)) < 0).sort((left, right) => comparePosition(right, position(left)))[0] ?? null;
}

function matchesFilters(row: HistoryDeployment, query: DeploymentHistoryQuery): boolean {
  const createdAt = timestamp(row.createdAt);
  return (!query.serviceId || row.serviceId === query.serviceId) && (!query.environment || environment(row.deploymentType) === query.environment)
    && (!query.status || normalizeDeploymentStatus(row.status) === query.status) && (!query.trigger || String(row.triggerType).toLowerCase() === query.trigger.toLowerCase())
    && (!query.from || createdAt >= query.from) && (!query.to || createdAt <= query.to);
}

function publicFilters(query: DeploymentHistoryQuery) {
  return { serviceId: query.serviceId ?? null, environment: query.environment ?? null, status: query.status ?? null, trigger: query.trigger ?? null, from: query.from ?? null, to: query.to ?? null };
}

function filterFingerprint(query: DeploymentHistoryQuery): string {
  return crypto.createHash('sha256').update(JSON.stringify(publicFilters(query))).digest('base64url');
}

function position(row: HistoryDeployment): HistoryPosition { return { at: timestamp(row.createdAt), id: row.id }; }
function comparePosition(row: HistoryDeployment, cursor: HistoryPosition): number {
  const at = timestamp(row.createdAt).localeCompare(cursor.at);
  return at === 0 ? String(row.id).localeCompare(cursor.id) : at;
}
function environment(value: unknown): 'production' | 'preview' | 'manual' {
  const normalized = String(value || 'production').toLowerCase();
  return normalized === 'preview' || normalized === 'manual' ? normalized : 'production';
}
function cursorKey(value: string): string {
  if (!value) throw new DeploymentHistoryError();
  return `deployment-history-v1\0${value}`;
}
function optionalMatch(value: unknown, pattern: RegExp): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) throw new DeploymentHistoryError();
  return value;
}
function optionalTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new DeploymentHistoryError();
  return new Date(value).toISOString();
}
function optionalEnvironment(value: unknown): DeploymentHistoryQuery['environment'] {
  const parsed = optionalMatch(value, /^(production|preview|manual)$/);
  switch (parsed) {
    case undefined: case 'production': case 'preview': case 'manual': return parsed;
    default: throw new DeploymentHistoryError();
  }
}
function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new DeploymentHistoryError();
  return date.toISOString();
}
function nullableTimestamp(value: unknown): string | null { return value ? timestamp(value) : null; }
function nullableString(value: unknown): string | null { return value === undefined || value === null || value === '' ? null : String(value); }
function positiveInteger(value: unknown): number | null { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null; }
function nonnegativeInteger(value: unknown): number | null { return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null; }
function isCursor(value: unknown): value is { readonly v: 1; readonly o: string; readonly p: string; readonly f: string; readonly at: string; readonly id: string; readonly h: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'at,f,h,id,o,p,v' && Reflect.get(value, 'v') === 1 && ['o', 'p', 'f', 'at', 'id', 'h'].every((key) => typeof Reflect.get(value, key) === 'string');
}

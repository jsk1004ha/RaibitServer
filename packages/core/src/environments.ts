import crypto from 'node:crypto';
import { productionEnvironmentId } from './operational-persistence.ts';

export const ENVIRONMENT_KINDS = ['prod', 'dev'] as const;
export type EnvironmentKind = typeof ENVIRONMENT_KINDS[number];

export type EnvironmentRecord = Readonly<{
  id: string;
  projectId: string;
  kind: EnvironmentKind;
  status: 'active';
  version: 1;
  createdAt: string | Date;
  updatedAt: string | Date;
}>;

export type EnvironmentSelector = Readonly<{ environmentId?: string; kind?: EnvironmentKind }>;
export type RuntimeEnvironmentProjection = Readonly<{
  environment: Readonly<{ id: string; projectId: string; kind: EnvironmentKind }>;
  services: readonly Readonly<{ serviceId: string; logicalSlug: string; physicalSlug: string }>[];
  resources: readonly Readonly<{ resourceId: string; logicalSlug: string; physicalName: string }>[];
}>;

export type EnvironmentErrorCode =
  | 'ENVIRONMENT_INPUT_INVALID'
  | 'ENVIRONMENT_NOT_FOUND'
  | 'ENVIRONMENT_VERSION_CONFLICT'
  | 'ENVIRONMENT_CONFIRMATION_INVALID'
  | 'ENVIRONMENT_NOT_EMPTY'
  | 'ENVIRONMENT_FEATURE_DISABLED';

export class EnvironmentError extends Error {
  readonly name = 'EnvironmentError';
  readonly code: EnvironmentErrorCode;
  readonly statusCode: 400 | 404 | 409;
  constructor(code: EnvironmentErrorCode, statusCode: 400 | 404 | 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function environmentIdForKind(projectId: string, kind: EnvironmentKind): string {
  requireIdentifier(projectId);
  return kind === 'prod' ? productionEnvironmentId(projectId) : `env_dev_${digest(projectId).slice(0, 32)}`;
}

export function environmentPhysicalSlug(kind: EnvironmentKind, environmentId: string, logicalSlug: string): string {
  requireIdentifier(environmentId);
  requireSlug(logicalSlug);
  if (kind === 'prod') return logicalSlug;
  const prefix = `dev-${digest(`${environmentId}:${logicalSlug}`).slice(0, 10)}-`;
  const suffix = logicalSlug.slice(0, 63 - prefix.length).replace(/-+$/u, '') || 'item';
  return `${prefix}${suffix}`;
}

export function environmentNamespace(kind: EnvironmentKind, environmentId: string): string {
  requireIdentifier(environmentId);
  return kind === 'prod' ? '' : `rb-dev-${digest(environmentId).slice(0, 20)}`;
}

export function developmentEnvironmentSubjectId(prefix: 'svc' | 'res', projectId: string, environmentId: string, logicalSlug: string): string {
  requireIdentifier(projectId);
  requireIdentifier(environmentId);
  requireSlug(logicalSlug);
  return `${prefix}-dev-${digest(JSON.stringify([projectId, environmentId, logicalSlug])).slice(0, 54)}`;
}

export function developmentEnvironmentOperationId(prefix: 'dep' | 'job' | 'preview-lineage', environmentId: string, parts: readonly unknown[]): string {
  return `${prefix}-dev-${digest(JSON.stringify([environmentId, ...parts])).slice(0, 63 - prefix.length - 5)}`;
}

export function parseEnvironmentSelector(input: unknown): EnvironmentSelector {
  if (!isRecord(input)) return Object.freeze({});
  let kind: EnvironmentKind | undefined;
  for (const rawKind of [input.kind, input.environmentKind, input.environment]) {
    if (rawKind === undefined) continue;
    if ((rawKind !== 'prod' && rawKind !== 'dev') || (kind !== undefined && kind !== rawKind)) {
      throw new EnvironmentError('ENVIRONMENT_INPUT_INVALID', 400);
    }
    kind = rawKind;
  }
  const rawEnvironmentId = input.environmentId;
  if (rawEnvironmentId !== undefined && (typeof rawEnvironmentId !== 'string' || rawEnvironmentId.length === 0)) {
    throw new EnvironmentError('ENVIRONMENT_INPUT_INVALID', 400);
  }
  const environmentId = typeof rawEnvironmentId === 'string' ? rawEnvironmentId : undefined;
  return Object.freeze({ ...(environmentId === undefined ? {} : { environmentId }), ...(kind === undefined ? {} : { kind }) });
}

export function projectRuntimeEnvironment(input: Readonly<{
  environment: Readonly<{ id: string; projectId: string; kind: EnvironmentKind }>;
  services: readonly Readonly<{ id: string; projectId: string; slug: string; logicalSlug?: string; physicalSlug?: string }>[];
  resources: readonly Readonly<{ id: string; projectId: string; slug: string; logicalSlug?: string; physicalName?: string }>[];
}>): RuntimeEnvironmentProjection {
  const { environment } = input;
  const services = input.services.map((service) => {
    requireProject(environment.projectId, service.projectId);
    const logicalSlug = service.logicalSlug ?? service.slug;
    return Object.freeze({ serviceId: service.id, logicalSlug, physicalSlug: service.physicalSlug ?? environmentPhysicalSlug(environment.kind, environment.id, logicalSlug) });
  });
  const resources = input.resources.map((resource) => {
    requireProject(environment.projectId, resource.projectId);
    const logicalSlug = resource.logicalSlug ?? resource.slug;
    return Object.freeze({ resourceId: resource.id, logicalSlug, physicalName: resource.physicalName ?? environmentPhysicalSlug(environment.kind, environment.id, logicalSlug) });
  });
  return Object.freeze({
    environment: Object.freeze({ id: environment.id, projectId: environment.projectId, kind: environment.kind }),
    services: Object.freeze(services),
    resources: Object.freeze(resources),
  });
}

export function publicEnvironment<T extends Readonly<Record<string, unknown>>>(row: T): T & Readonly<{ version: 1 }> {
  return Object.freeze({ ...row, version: 1 });
}

export function publicEnvironmentSubject<T extends Readonly<Record<string, unknown>>>(
  row: T,
  binding: Readonly<{ environmentId: string; logicalSlug: string; environmentKind: EnvironmentKind; displayName?: string | null }>,
): T & Readonly<{ environmentId: string; environmentKind: EnvironmentKind; logicalSlug: string; slug: string }> {
  return Object.freeze({ ...row, ...binding, ...(binding.displayName ? { name: binding.displayName } : {}), slug: binding.logicalSlug });
}

function digest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function requireIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) throw new EnvironmentError('ENVIRONMENT_INPUT_INVALID', 400);
}
function requireSlug(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value) || value.length > 63) throw new EnvironmentError('ENVIRONMENT_INPUT_INVALID', 400);
}
function requireProject(expected: string, actual: string): void {
  if (expected !== actual) throw new EnvironmentError('ENVIRONMENT_NOT_FOUND', 404);
}

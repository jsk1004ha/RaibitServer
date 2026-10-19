import crypto from 'node:crypto';
import type { EnvironmentKind, RuntimeEnvironmentProjection } from './environments.ts';

export type RuntimeEnvironmentKind = EnvironmentKind;
type RuntimeServiceBinding = Readonly<{ serviceId: string; logicalSlug: string; physicalSlug: string }>;
type RuntimeResourceBinding = Readonly<{ resourceId: string; logicalSlug: string; physicalName: string }>;

type RuntimeSubject = Readonly<{ id?: string; name?: string; slug?: string }>;
type CompilationIdentityInput = Readonly<{
  projectId: string;
  services: readonly RuntimeSubject[];
  resources: readonly RuntimeSubject[];
  projection?: unknown;
}>;

export type RuntimeCompilationIdentity = Readonly<{
  environmentId: string;
  environmentKind: RuntimeEnvironmentKind;
  namespace: (legacyNamespace: string) => string;
  service: (id: string) => RuntimeServiceBinding | undefined;
  resource: (id: string) => RuntimeResourceBinding | undefined;
}>;

export class RuntimeEnvironmentError extends Error {
  readonly name = 'RuntimeEnvironmentError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function runtimeCompilationIdentity(input: CompilationIdentityInput): RuntimeCompilationIdentity {
  if (input.projection === undefined) return legacyProductionIdentity();
  const projection = parseProjection(input.projection);
  if (projection.environment.projectId !== input.projectId) fail('RUNTIME_ENVIRONMENT_PROJECT_MISMATCH');
  const services = serviceBindingMap(projection.services);
  const resources = resourceBindingMap(projection.resources);
  requireBindings(input.services, services, 'RUNTIME_ENVIRONMENT_SERVICE_BINDING_REQUIRED');
  requireBindings(input.resources, resources, 'RUNTIME_ENVIRONMENT_RESOURCE_BINDING_REQUIRED');
  if (services.size !== input.services.length) fail('RUNTIME_ENVIRONMENT_SERVICE_BINDING_REQUIRED');
  if (resources.size !== input.resources.length) fail('RUNTIME_ENVIRONMENT_RESOURCE_BINDING_REQUIRED');
  if (projection.environment.kind === 'prod') return legacyProductionIdentity(projection.environment.id);
  validatePhysicalIdentities(projection);
  return Object.freeze({
    environmentId: projection.environment.id,
    environmentKind: projection.environment.kind,
    namespace: (legacyNamespace: string) => projection.environment.kind === 'prod' ? legacyNamespace : devNamespace(projection.environment.id),
    service: (id: string) => services.get(id),
    resource: (id: string) => resources.get(id),
  });
}

function legacyProductionIdentity(environmentId = ''): RuntimeCompilationIdentity {
  return Object.freeze({
    environmentId,
    environmentKind: 'prod',
    namespace: (legacyNamespace: string) => legacyNamespace,
    service: () => undefined,
    resource: () => undefined,
  });
}

function parseProjection(value: unknown): RuntimeEnvironmentProjection {
  if (!isRecord(value) || !isRecord(value.environment) || !Array.isArray(value.services) || !Array.isArray(value.resources)) fail('RUNTIME_ENVIRONMENT_INVALID');
  const environment = value.environment;
  if (!text(environment.id) || !text(environment.projectId) || (environment.kind !== 'prod' && environment.kind !== 'dev')) fail('RUNTIME_ENVIRONMENT_INVALID');
  return Object.freeze({
    environment: Object.freeze({ id: environment.id, projectId: environment.projectId, kind: environment.kind }),
    services: value.services.map(parseServiceBinding),
    resources: value.resources.map(parseResourceBinding),
  });
}

function parseServiceBinding(value: unknown): RuntimeServiceBinding {
  if (!isRecord(value) || !text(value.serviceId) || !text(value.logicalSlug) || !text(value.physicalSlug)) fail('RUNTIME_ENVIRONMENT_INVALID');
  return Object.freeze({ serviceId: value.serviceId, logicalSlug: value.logicalSlug, physicalSlug: value.physicalSlug });
}

function parseResourceBinding(value: unknown): RuntimeResourceBinding {
  if (!isRecord(value) || !text(value.resourceId) || !text(value.logicalSlug) || !text(value.physicalName)) fail('RUNTIME_ENVIRONMENT_INVALID');
  return Object.freeze({ resourceId: value.resourceId, logicalSlug: value.logicalSlug, physicalName: value.physicalName });
}

function serviceBindingMap(bindings: readonly RuntimeServiceBinding[]): ReadonlyMap<string, RuntimeServiceBinding> {
  const result = new Map<string, RuntimeServiceBinding>();
  for (const binding of bindings) {
    if (result.has(binding.serviceId)) fail('RUNTIME_ENVIRONMENT_DUPLICATE_BINDING');
    result.set(binding.serviceId, binding);
  }
  return result;
}

function resourceBindingMap(bindings: readonly RuntimeResourceBinding[]): ReadonlyMap<string, RuntimeResourceBinding> {
  const result = new Map<string, RuntimeResourceBinding>();
  for (const binding of bindings) {
    if (result.has(binding.resourceId)) fail('RUNTIME_ENVIRONMENT_DUPLICATE_BINDING');
    result.set(binding.resourceId, binding);
  }
  return result;
}

function requireBindings<T>(subjects: readonly RuntimeSubject[], bindings: ReadonlyMap<string, T>, code: string): void {
  if (subjects.some(({ id }) => !text(id) || !bindings.has(id))) fail(code);
}

function validatePhysicalIdentities(projection: RuntimeEnvironmentProjection): void {
  if (projection.environment.kind !== 'dev') return;
  for (const binding of projection.services) if (binding.physicalSlug !== devPhysicalName(projection.environment.id, binding.logicalSlug)) fail('RUNTIME_ENVIRONMENT_INVALID');
  for (const binding of projection.resources) if (binding.physicalName !== devPhysicalName(projection.environment.id, binding.logicalSlug)) fail('RUNTIME_ENVIRONMENT_INVALID');
}

export function devNamespace(environmentId: string): string {
  return `rb-dev-${digest(environmentId, 20)}`;
}

export function devPhysicalName(environmentId: string, logicalSlug: string): string {
  const prefix = `dev-${digest(`${environmentId}:${logicalSlug}`, 10)}-`;
  const suffix = normalize(logicalSlug).slice(0, 63 - prefix.length).replace(/-+$/g, '');
  return `${prefix}${suffix || 'item'}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function digest(value: string, length: number): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(code: string): never {
  throw new RuntimeEnvironmentError(code);
}

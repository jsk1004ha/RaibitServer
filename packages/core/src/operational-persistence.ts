export const OPERATIONAL_PROTOCOL_VERSION: 2 = 2;
export const OPERATIONAL_PROTOCOL_SESSION_SQL = "SET LOCAL raibitserver.operational_protocol = '2'";

export type OperationalPersistenceErrorCode =
  | 'INVALID_BACKFILL_INPUT'
  | 'DUPLICATE_IDENTITY'
  | 'DUPLICATE_LOGICAL_SLUG'
  | 'PROJECT_MISMATCH';

export class OperationalPersistenceError extends Error {
  readonly name = 'OperationalPersistenceError';
  readonly code: OperationalPersistenceErrorCode;
  readonly details: readonly string[];

  constructor(code: OperationalPersistenceErrorCode, details: readonly string[] = []) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export type OperationalBackfillInput = Readonly<{
  projects: readonly Readonly<{ id: string }>[];
  services: readonly Readonly<{ id: string; projectId: string; slug: string }>[];
  resources: readonly Readonly<{ id: string; projectId: string; slug: string }>[];
  backups: readonly Readonly<{ id: string; resourceId: string; expiresAt: string | null }>[];
}>;

export type OperationalBindingScope = Readonly<{
  environmentId: string;
  environmentProjectId: string;
  subjectId: string;
  subjectProjectId: string;
  logicalSlug: string;
}>;

export type OperationalBackfillProjection = Readonly<{
  environments: readonly Readonly<{ id: string; projectId: string; kind: 'prod'; status: 'active' }>[];
  serviceBindings: readonly Readonly<{ environmentId: string; projectId: string; serviceId: string; logicalSlug: string }>[];
  resourceBindings: readonly Readonly<{ environmentId: string; projectId: string; resourceId: string; logicalSlug: string }>[];
  backups: readonly Readonly<{ id: string; origin: 'manual'; expiresAt: string | null }>[];
}>;

export type OperationalSqlExecutor = Readonly<{
  $executeRawUnsafe(sql: string): Promise<number>;
}>;

export function productionEnvironmentId(projectId: string): string {
  if (!isNonemptyString(projectId)) throw new OperationalPersistenceError('INVALID_BACKFILL_INPUT', ['projectId']);
  return `env_prod_${projectId}`;
}

export function assertOperationalBindingScope(input: OperationalBindingScope): OperationalBindingScope {
  for (const [field, value] of Object.entries(input)) {
    if (!isNonemptyString(value)) throw new OperationalPersistenceError('INVALID_BACKFILL_INPUT', [field]);
  }
  if (input.environmentProjectId !== input.subjectProjectId) {
    throw new OperationalPersistenceError('PROJECT_MISMATCH', [input.environmentId, input.subjectId]);
  }
  return Object.freeze({ ...input });
}

export function buildOperationalBackfillProjection(input: unknown): OperationalBackfillProjection {
  const parsed = parseBackfillInput(input);
  const projectIds = uniqueMap(parsed.projects, 'projects', (entry) => entry.id);
  const serviceIds = uniqueMap(parsed.services, 'services', (entry) => entry.id);
  const resourceIds = uniqueMap(parsed.resources, 'resources', (entry) => entry.id);
  uniqueMap(parsed.backups, 'backups', (entry) => entry.id);
  const serviceSlugs = new Set<string>();
  const resourceSlugs = new Set<string>();

  const environments = [...projectIds.keys()].sort().map((projectId) => Object.freeze({
    id: productionEnvironmentId(projectId), projectId, kind: 'prod', status: 'active',
  }));
  const serviceBindings = [...serviceIds.values()].sort(byId).map((service) => {
    requireProject(projectIds, service.projectId, service.id);
    requireLogicalSlug(serviceSlugs, service.projectId, service.slug);
    return Object.freeze({ environmentId: productionEnvironmentId(service.projectId), projectId: service.projectId, serviceId: service.id, logicalSlug: service.slug });
  });
  const resourceBindings = [...resourceIds.values()].sort(byId).map((resource) => {
    requireProject(projectIds, resource.projectId, resource.id);
    requireLogicalSlug(resourceSlugs, resource.projectId, resource.slug);
    return Object.freeze({ environmentId: productionEnvironmentId(resource.projectId), projectId: resource.projectId, resourceId: resource.id, logicalSlug: resource.slug });
  });
  const backups = parsed.backups.map((backup) => {
    if (!resourceIds.has(backup.resourceId)) throw new OperationalPersistenceError('PROJECT_MISMATCH', [backup.id, backup.resourceId]);
    return Object.freeze({ id: backup.id, origin: 'manual', expiresAt: backup.expiresAt });
  });
  return Object.freeze({ environments, serviceBindings, resourceBindings, backups });
}

export async function setOperationalProtocolVersion(transaction: OperationalSqlExecutor): Promise<2> {
  await transaction.$executeRawUnsafe(OPERATIONAL_PROTOCOL_SESSION_SQL);
  return OPERATIONAL_PROTOCOL_VERSION;
}

function parseBackfillInput(input: unknown): OperationalBackfillInput {
  if (!isRecord(input) || !hasExactKeys(input, ['projects', 'services', 'resources', 'backups'])) invalid('root');
  if (!Array.isArray(input.projects) || !Array.isArray(input.services) || !Array.isArray(input.resources) || !Array.isArray(input.backups)) invalid('collections');
  return Object.freeze({
    projects: input.projects.map((entry, index) => parseProject(entry, index)),
    services: input.services.map((entry, index) => parseSubject(entry, `services.${index}`)),
    resources: input.resources.map((entry, index) => parseSubject(entry, `resources.${index}`)),
    backups: input.backups.map((entry, index) => parseBackup(entry, index)),
  });
}

function parseProject(input: unknown, index: number): Readonly<{ id: string }> {
  if (!isRecord(input) || !hasExactKeys(input, ['id']) || !isNonemptyString(input.id)) invalid(`projects.${index}`);
  return Object.freeze({ id: input.id });
}

function parseSubject(input: unknown, path: string): Readonly<{ id: string; projectId: string; slug: string }> {
  if (!isRecord(input) || !hasExactKeys(input, ['id', 'projectId', 'slug']) || !isNonemptyString(input.id) || !isNonemptyString(input.projectId) || !isSlug(input.slug)) invalid(path);
  return Object.freeze({ id: input.id, projectId: input.projectId, slug: input.slug });
}

function parseBackup(input: unknown, index: number): Readonly<{ id: string; resourceId: string; expiresAt: string | null }> {
  if (!isRecord(input) || !hasExactKeys(input, ['id', 'resourceId', 'expiresAt']) || !isNonemptyString(input.id) || !isNonemptyString(input.resourceId)) invalid(`backups.${index}`);
  const expiresAt = input.expiresAt;
  if (expiresAt === null) return Object.freeze({ id: input.id, resourceId: input.resourceId, expiresAt: null });
  if (!isNonemptyString(expiresAt) || Number.isNaN(Date.parse(expiresAt))) invalid(`backups.${index}.expiresAt`);
  return Object.freeze({ id: input.id, resourceId: input.resourceId, expiresAt });
}

function uniqueMap<T>(items: readonly T[], path: string, identity: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = identity(item);
    if (result.has(id)) throw new OperationalPersistenceError('DUPLICATE_IDENTITY', [path, id]);
    result.set(id, item);
  }
  return result;
}

function requireProject(projects: ReadonlyMap<string, Readonly<{ id: string }>>, projectId: string, subjectId: string): void {
  if (!projects.has(projectId)) throw new OperationalPersistenceError('PROJECT_MISMATCH', [projectId, subjectId]);
}

function requireLogicalSlug(seen: Set<string>, projectId: string, slug: string): void {
  const identity = `${projectId}\u0000${slug}`;
  if (seen.has(identity)) throw new OperationalPersistenceError('DUPLICATE_LOGICAL_SLUG', [projectId, slug]);
  seen.add(identity);
}

function hasExactKeys(input: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function isSlug(value: unknown): value is string {
  return isNonemptyString(value) && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function byId(left: Readonly<{ id: string }>, right: Readonly<{ id: string }>): number {
  return left.id.localeCompare(right.id);
}

function invalid(path: string): never {
  throw new OperationalPersistenceError('INVALID_BACKFILL_INPUT', [path]);
}

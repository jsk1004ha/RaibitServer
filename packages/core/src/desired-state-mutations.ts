/** Conservative finite settings fallback when an actor has no configured quota. */
export const SERVICE_SETTINGS_LIMITS = { cpuMillicores: 500, memoryMiB: 512 } as const;
/** Only a server-side caller can hold this token; JSON cannot opt into runtime writes. */
export const INTERNAL_SERVICE_MUTATION = Symbol('internal-service-mutation');
const editable = new Set(['name', 'type', 'branch', 'rootDirectory', 'buildContext', 'dockerfilePath', 'installCommand', 'buildCommand', 'startCommand', 'outputDirectory', 'port', 'healthCheck', 'resources']);
const identity = new Set(['id', 'projectId', 'organizationId', 'organizationSlug', 'slug', 'sourceType', 'repoUrl', 'repositoryUrl', 'image', 'imageUrl', 'githubRepositoryId', 'githubInstallationId', 'githubIntegrationId', 'githubRepository', 'sourceAccess']);
const resourceKeys = new Set(['name', 'type', 'engine', 'provider', 'plan', 'region', 'version', 'storageMb', 'storageGb', 'databaseName', 'database', 'username', 'bucket', 'collection', 'topic', 'backup', 'desiredSpec']);
const resourceSpecKeys = new Set(['storageMb', 'storageGb', 'databaseName', 'database', 'username', 'bucket', 'collection', 'topic', 'schemas', 'tables', 'collections', 'documents', 'keys', 'values', 'ttl', 'buckets', 'objects', 'subjects']);

export class DesiredStateMutationError extends Error {
  readonly name = 'DesiredStateMutationError';
  readonly statusCode: 400 | 409;
  readonly field: string;
  readonly code: 'INVALID_SETTINGS' | 'IMMUTABLE_SETTINGS';
  constructor(field: string, code: 'INVALID_SETTINGS' | 'IMMUTABLE_SETTINGS') {
    super(`${code}: ${field}`);
    this.field = field;
    this.code = code;
    this.statusCode = code === 'IMMUTABLE_SETTINGS' ? 409 : 400;
  }
}
function invalid(field: string): never { throw new DesiredStateMutationError(field, 'INVALID_SETTINGS'); }
function immutable(field: string): never { throw new DesiredStateMutationError(field, 'IMMUTABLE_SETTINGS'); }
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return Object.fromEntries(Object.entries(value));
}
function keys(input: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(input)) if (!allowed.has(key)) {
    if (identity.has(key)) immutable(key);
    invalid(key);
  }
}
function text(value: unknown, field: string, maximum: number, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || (!empty && !value.trim())) invalid(field);
}
export function parseProjectMutation(input: unknown) {
  const parsed = record(input, 'project');
  keys(parsed, new Set(['name', 'description']));
  if (Object.hasOwn(parsed, 'name')) text(parsed.name, 'name', 128);
  if (Object.hasOwn(parsed, 'description')) text(parsed.description, 'description', 4096, true);
  return parsed;
}
export function parseServiceMutation(input: unknown) {
  const parsed = record(input, 'service');
  keys(parsed, editable);
  for (const [key, value] of Object.entries(parsed)) {
    if (['resources', 'healthCheck', 'port'].includes(key)) continue;
    text(value, key, key === 'name' ? 128 : key.endsWith('Command') ? 4096 : 1024, key.endsWith('Command'));
    if (['rootDirectory', 'buildContext', 'dockerfilePath', 'outputDirectory'].includes(key)) {
      const normalized = String(value).replaceAll('\\', '/');
      if (normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').includes('..')) invalid(key);
    }
  }
  if (parsed.type !== undefined && !['web', 'private', 'worker', 'cron', 'job'].includes(String(parsed.type))) invalid('type');
  if (parsed.port !== undefined && (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535)) invalid('port');
  if (parsed.healthCheck !== undefined) {
    const health = record(parsed.healthCheck, 'healthCheck');
    keys(health, new Set(['path']));
    text(health.path, 'healthCheck.path', 1024);
    if (!String(health.path).startsWith('/') || String(health.path).startsWith('//') || /[\\\s?#]/.test(String(health.path))) invalid('healthCheck.path');
    parsed.healthCheck = health;
  }
  if (parsed.resources !== undefined) {
    const resources = record(parsed.resources, 'resources');
    keys(resources, new Set(['requests', 'limits']));
    for (const [kind, values] of Object.entries(resources)) {
      const quantities = record(values, `resources.${kind}`);
      keys(quantities, new Set(['cpu', 'memory']));
      for (const [unit, quantity] of Object.entries(quantities)) settingQuantity(quantity, unit);
      resources[kind] = quantities;
    }
    parsed.resources = resources;
    const requests = optionalRecord(resources.requests);
    const limits = optionalRecord(resources.limits);
    for (const unit of ['cpu', 'memory']) if (requests[unit] !== undefined && limits[unit] !== undefined && settingQuantity(requests[unit], unit) > settingQuantity(limits[unit], unit)) invalid(`resources.requests.${unit}`);
  }
  return parsed;
}
function settingQuantity(value: unknown, unit: string) {
  if (typeof value !== 'string') invalid(`resources.${unit}`);
  const pattern = unit === 'cpu' ? /^(?:\d+(?:\.\d{1,3})?|\d+m)$/ : /^\d+(?:Mi|Gi)$/;
  if (!pattern.test(value)) invalid(`resources.${unit}`);
  const quantity = unit === 'cpu' ? (value.endsWith('m') ? Number(value.slice(0, -1)) : Number(value) * 1000) : Number(value.slice(0, -2)) * (value.endsWith('Gi') ? 1024 : 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1) invalid(`resources.${unit}`);
  return quantity;
}
export function serviceMutationState(current: Record<string, unknown>, updates: Record<string, unknown>, context: { readonly deployed: boolean; readonly quota?: Record<string, unknown> }) {
  if (context.deployed) for (const field of ['name', 'type']) if (Object.hasOwn(updates, field) && updates[field] !== current[field]) immutable(field);
  const desired = { ...optionalRecord(current.desiredSpec), ...optionalRecord(current.desiredState), ...current };
  if (!Object.hasOwn(updates, 'resources')) return updates;
  const previous = optionalRecord(desired.resources);
  const patch = record(updates.resources, 'resources');
  const resources = {
    requests: { cpu: '100m', memory: '128Mi', ...optionalRecord(previous.requests), ...optionalRecord(patch.requests) },
    limits: { cpu: '500m', memory: '512Mi', ...optionalRecord(previous.limits), ...optionalRecord(patch.limits) },
  };
  for (const kind of ['requests', 'limits'] as const) for (const unit of ['cpu', 'memory'] as const) {
    const quota = context.quota?.[unit === 'cpu' ? 'maxCpuMillicores' : 'maxMemoryMb'];
    if (quota !== undefined && (typeof quota !== 'number' || !Number.isSafeInteger(quota) || quota <= 0)) invalid(`quota.${unit}`);
    const ceiling = typeof quota === 'number' ? quota : unit === 'cpu' ? SERVICE_SETTINGS_LIMITS.cpuMillicores : SERVICE_SETTINGS_LIMITS.memoryMiB;
    const next = settingQuantity(resources[kind][unit], unit);
    const retained = optionalRecord(previous[kind])[unit];
    if (retained !== undefined && next <= settingQuantity(retained, unit)) continue;
    if (next > ceiling) invalid(`resources.${kind}.${unit}`);
  }
  for (const unit of ['cpu', 'memory'] as const) if (settingQuantity(resources.requests[unit], unit) > settingQuantity(resources.limits[unit], unit)) invalid(`resources.requests.${unit}`);
  return { ...updates, resources };
}
function optionalRecord(value: unknown): Record<string, unknown> { return value === undefined || value === null ? {} : record(value, 'stored settings'); }
export function assertServiceReplacement(deployed: boolean) { if (deployed) immutable('service replacement requires a new service'); }
export function parseResourceMutation(input: unknown) {
  const parsed = record(input, 'resource');
  keys(parsed, resourceKeys);
  if (parsed.desiredSpec !== undefined) keys(record(parsed.desiredSpec, 'desiredSpec'), resourceSpecKeys);
  return parsed;
}

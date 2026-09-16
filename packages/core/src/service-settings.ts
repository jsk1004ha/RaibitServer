import { resolveBuildStrategy } from './build-strategy.ts';
import { parseServiceMutation, serviceMutationState } from './desired-state-mutations.ts';

const settingFields = [
  'name', 'type', 'sourceType', 'repoUrl', 'image', 'imageUrl', 'branch', 'rootDirectory', 'buildContext',
  'dockerfilePath', 'installCommand', 'buildCommand', 'startCommand', 'outputDirectory', 'port', 'healthCheckPath',
  'livenessPath', 'readinessPath', 'publicHealthPath', 'resources',
] as const;

export class ServiceSettingsError extends Error {
  readonly name = 'ServiceSettingsError';
  readonly code: 'INVALID_SETTINGS' | 'STALE_SERVICE' | 'REPLACEMENT_CONFIRMATION_REQUIRED' | 'REPLACEMENT_REQUIRES_DEPLOYMENT' | 'REPLACEMENT_NAME_CONFLICT';
  readonly statusCode: 400 | 409;

  constructor(code: ServiceSettingsError['code'], statusCode: ServiceSettingsError['statusCode']) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function serviceVersion(service: Record<string, unknown>): string {
  const value = service.updatedAt ?? service.createdAt;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function assertExpectedServiceVersion(service: Record<string, unknown>, expectedUpdatedAt: string): void {
  if (serviceVersion(service) !== expectedUpdatedAt) throw new ServiceSettingsError('STALE_SERVICE', 409);
}

export function serviceSettingsSnapshot(service: Record<string, unknown>, deployed: boolean) {
  const desired = record(service.desiredSpec);
  const state = record(service.desiredState);
  const settings = Object.fromEntries(settingFields.flatMap((field) => {
    const value = service[field] ?? state[field] ?? desired[field];
    return value === undefined || value === null ? [] : [[field, value]];
  }));
  return { serviceId: String(service.id), projectId: String(service.projectId), updatedAt: serviceVersion(service), deployed, settings };
}

export function previewServiceSettings(
  service: Record<string, unknown>,
  input: { readonly expectedUpdatedAt: string; readonly changes: Record<string, unknown>; readonly files?: Record<string, string> },
  context: { readonly deployed: boolean; readonly quota?: Record<string, unknown> },
) {
  assertExpectedServiceVersion(service, input.expectedUpdatedAt);
  const before = serviceSettingsSnapshot(service, context.deployed);
  const changes = serviceMutationState(service, parseServiceMutation(input.changes), context);
  const afterService = { ...service, ...changes, desiredSpec: { ...record(service.desiredSpec), ...changes }, desiredState: { ...record(service.desiredState), ...changes } };
  const after = serviceSettingsSnapshot(afterService, context.deployed);
  const diff = Object.keys(changes).sort().map((field) => ({ field, before: before.settings[field] ?? null, after: after.settings[field] ?? null }));
  return { snapshot: before, settings: after.settings, diff, buildPlan: { before: resolveBuildStrategy(service, input.files), after: resolveBuildStrategy(afterService, input.files) } };
}

export function parseServiceSettingsInput(input: unknown) {
  const parsed = record(input);
  if (Object.keys(parsed).some((key) => !['expectedUpdatedAt', 'changes', 'files'].includes(key)) || typeof parsed.expectedUpdatedAt !== 'string') {
    throw new ServiceSettingsError('INVALID_SETTINGS', 400);
  }
  const fileEntries = Object.entries(record(parsed.files));
  if (fileEntries.length > 500 || fileEntries.some(([path, content]) => path.length > 1024 || typeof content !== 'string' || content.length > 1_048_576)) {
    throw new ServiceSettingsError('INVALID_SETTINGS', 400);
  }
  const files = Object.fromEntries(fileEntries.map(([path, content]) => [path, String(content)]));
  if (Object.values(files).reduce((total, content) => total + content.length, 0) > 1_048_576) throw new ServiceSettingsError('INVALID_SETTINGS', 400);
  return { expectedUpdatedAt: parsed.expectedUpdatedAt, changes: parseServiceMutation(parsed.changes), files };
}

export function parseServiceReplacement(input: unknown) {
  const parsed = record(input);
  const keys = Object.keys(parsed);
  if (keys.some((key) => !['expectedUpdatedAt', 'confirmed', 'name', 'source'].includes(key))) throw new ServiceSettingsError('REPLACEMENT_CONFIRMATION_REQUIRED', 400);
  if (typeof parsed.expectedUpdatedAt !== 'string') throw new ServiceSettingsError('STALE_SERVICE', 409);
  if (parsed.confirmed !== true || typeof parsed.name !== 'string' || !parsed.name.trim() || parsed.name.length > 128) throw new ServiceSettingsError('REPLACEMENT_CONFIRMATION_REQUIRED', 400);
  const sourceInput = record(parsed.source);
  if (Object.keys(sourceInput).some((key) => !['sourceType', 'repoUrl', 'image', 'imageUrl'].includes(key))) throw new ServiceSettingsError('REPLACEMENT_CONFIRMATION_REQUIRED', 400);
  const source = parseServiceMutation(sourceInput);
  if (!Object.hasOwn(source, 'sourceType')) throw new ServiceSettingsError('REPLACEMENT_CONFIRMATION_REQUIRED', 400);
  return { expectedUpdatedAt: parsed.expectedUpdatedAt, confirmed: true as const, name: parsed.name.trim(), source };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

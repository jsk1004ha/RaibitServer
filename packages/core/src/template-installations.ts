import crypto from 'node:crypto';
import { TemplateCatalogSchema, TemplateInstallRequestSchema, TemplateInstallationIntentSchema, type TemplateCatalog, type TemplateInstallationIntent } from '@raibitserver/schemas/templates';
import { parseOperationalRuntimeConfig } from './operational-contract.ts';

export type { TemplateInstallationIntent, TemplateServiceIntent, TemplateResourceIntent, TemplateBuildJobPayload, TemplateSourceDownload } from '@raibitserver/schemas/templates';
export type TemplateInstallationErrorCode =
  | 'TEMPLATE_INPUT_INVALID' | 'TEMPLATE_PROTOCOL_REQUIRED' | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_CATALOG_DIGEST_MISMATCH' | 'TEMPLATE_SOURCE_DIGEST_MISMATCH'
  | 'TEMPLATE_REQUIRED_INPUT_MISSING' | 'TEMPLATE_CAPACITY_EXCEEDED'
  | 'TEMPLATE_SLUG_CONFLICT' | 'TEMPLATE_RESOURCE_UNSUPPORTED'
  | 'TEMPLATE_VERSION_CONFLICT' | 'TEMPLATE_UNAVAILABLE' | 'TEMPLATE_FORBIDDEN';

export class TemplateInstallationError extends Error {
  readonly name = 'TemplateInstallationError';
  readonly code: TemplateInstallationErrorCode;
  readonly statusCode: 400 | 403 | 404 | 409;
  constructor(code: TemplateInstallationErrorCode, statusCode: 400 | 403 | 404 | 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type TemplatePreflightContext = Readonly<{
  actorUserId: string; projectId: string; environmentId: string; environmentKind: 'prod' | 'dev';
  availableServiceSlots: number; availableResourceSlots: number;
  occupiedServiceSlugs: readonly string[]; occupiedResourceSlugs: readonly string[];
  supportedResourceEngines: readonly string[];
}>;

export function templateAvailability(): { enabled: boolean; reasonCode: 'TEMPLATE_UNAVAILABLE' | null } {
  try {
    const config = parseOperationalRuntimeConfig();
    const enabled = config.implementationAvailable && config.productionActivation;
    return { enabled, reasonCode: enabled ? null : 'TEMPLATE_UNAVAILABLE' };
  } catch { return { enabled: false, reasonCode: 'TEMPLATE_UNAVAILABLE' }; }
}

export function templateRequestIdempotencyKey(input: unknown): string { return parseRequest(input).requestIdempotencyKey; }

export function validateTemplateCatalog(input: unknown): TemplateCatalog {
  const parsed = TemplateCatalogSchema.safeParse(input);
  if (!parsed.success) fail('TEMPLATE_INPUT_INVALID', 400);
  const { catalogDigest, ...content } = parsed.data;
  if (digest(stableJson(content)) !== catalogDigest) fail('TEMPLATE_CATALOG_DIGEST_MISMATCH', 409);
  const identities = new Set<string>();
  for (const starter of parsed.data.starters) {
    const identity = `${starter.id}/${starter.version}`;
    if (identities.has(identity)) fail('TEMPLATE_INPUT_INVALID', 400);
    identities.add(identity);
    for (const rows of [starter.graph.services, starter.graph.resources]) {
      if (new Set(rows.map(row => row.logicalSlug)).size !== rows.length) fail('TEMPLATE_INPUT_INVALID', 400);
    }
    if (new Set(starter.inputs.map(row => row.key)).size !== starter.inputs.length) fail('TEMPLATE_INPUT_INVALID', 400);
  }
  return parsed.data;
}

export function templateSecretReference(projectId: string, environmentId: string, requestIdempotencyKey: string, inputKey: string): string {
  return `secret:tmplsec_${hash(stableJson([projectId, environmentId, requestIdempotencyKey, inputKey])).slice(0, 32)}`;
}

/** Recheck the transient input at the transaction boundary before creating encrypted rows. */
export function assertTemplateSecretValues(intent: TemplateInstallationIntent, secretValues: Readonly<Record<string, unknown>> = {}): void {
  const request = parseRequest({ requiredProtocolVersion: 2, catalogId: intent.catalogId, catalogVersion: intent.catalogVersion,
    catalogDigest: intent.catalogDigest, sourceDigest: intent.sourceDigest, requestIdempotencyKey: intent.requestIdempotencyKey, inputs: secretValues });
  if (requestFingerprint(request) !== intent.requestFingerprint || stableJson(Object.keys(intent.inputs).sort()) !== stableJson(Object.keys(request.inputs).sort())) fail('TEMPLATE_VERSION_CONFLICT', 409);
  for (const key of Object.keys(request.inputs)) {
    if (intent.inputs[key] !== templateSecretReference(intent.projectId, intent.environmentId, intent.requestIdempotencyKey, key)) fail('TEMPLATE_INPUT_INVALID', 400);
  }
  if (intent.services.some(service => service.secretRefs.some(reference => !Object.values(intent.inputs).includes(reference.secretRef)))) fail('TEMPLATE_INPUT_INVALID', 400);
}

export function preflightTemplateInstallation(catalogInput: unknown, input: unknown, context: TemplatePreflightContext): TemplateInstallationIntent {
  const catalog = validateTemplateCatalog(catalogInput);
  const request = parseRequest(input);
  const { catalogId, catalogVersion, catalogDigest, sourceDigest, requestIdempotencyKey } = request;
  if (catalogDigest !== catalog.catalogDigest) fail('TEMPLATE_CATALOG_DIGEST_MISMATCH', 409);
  const starter = catalog.starters.find(candidate => candidate.id === catalogId && candidate.version === catalogVersion);
  if (!starter) fail('TEMPLATE_NOT_FOUND', 404);
  if (sourceDigest !== starter.source.digest) fail('TEMPLATE_SOURCE_DIGEST_MISMATCH', 409);
  if (Object.keys(request.inputs).some(key => !starter.inputs.some(definition => definition.key === key))) fail('TEMPLATE_INPUT_INVALID', 400);
  if (starter.inputs.some(definition => definition.required && !request.inputs[definition.key])) fail('TEMPLATE_REQUIRED_INPUT_MISSING', 400);
  if (starter.graph.services.length > context.availableServiceSlots || starter.graph.resources.length > context.availableResourceSlots) fail('TEMPLATE_CAPACITY_EXCEEDED', 409);
  if (starter.graph.services.some(service => context.occupiedServiceSlugs.includes(service.logicalSlug)) || starter.graph.resources.some(resource => context.occupiedResourceSlugs.includes(resource.logicalSlug))) fail('TEMPLATE_SLUG_CONFLICT', 409);
  if (starter.graph.resources.some(resource => !context.supportedResourceEngines.includes(resource.engine))) fail('TEMPLATE_RESOURCE_UNSUPPORTED', 409);
  const inputs = Object.fromEntries(Object.keys(request.inputs).map(key => [key, templateSecretReference(context.projectId, context.environmentId, requestIdempotencyKey, key)]));
  const identity = stableJson([context.projectId, context.environmentId, requestIdempotencyKey]);
  const installationId = `tmpl_${hash(identity).slice(0, 32)}`;
  const installationVersionId = `tmplv_${hash(`${identity}\0version\0${1}`).slice(0, 32)}`;
  const resources = starter.graph.resources.map(resource => ({ ...resource,
    id: `res_${hash(`${identity}\0resource\0${resource.logicalSlug}`).slice(0, 32)}`, projectId: context.projectId, environmentId: context.environmentId }));
  const services = starter.graph.services.map(service => {
    const id = `svc_${hash(`${identity}\0service\0${service.logicalSlug}`).slice(0, 32)}`;
    const deploymentId = `dep_${hash(`${identity}\0deployment\0${service.logicalSlug}`).slice(0, 32)}`;
    const secretRefs: { name: string; secretRef: string }[] = [];
    const resourceDependencies: { name: string; resourceLogicalSlug: string; secretKey: string }[] = [];
    for (const [name, binding] of Object.entries(service.environment)) {
      if ('input' in binding) {
        if (!starter.inputs.some(definition => definition.key === binding.input)) fail('TEMPLATE_INPUT_INVALID', 400);
        if (inputs[binding.input]) secretRefs.push({ name, secretRef: inputs[binding.input] });
      }
      if ('resource' in binding) {
        if (!resources.some(resource => resource.logicalSlug === binding.resource)) fail('TEMPLATE_INPUT_INVALID', 400);
        resourceDependencies.push({ name, resourceLogicalSlug: binding.resource, secretKey: binding.secretKey });
      }
    }
    return { ...service, ...(service.healthCheck ? { healthCheck: { path: service.healthCheck } } : {}),
      id, projectId: context.projectId, environmentId: context.environmentId, deploymentId,
      workflowJobId: `job_${hash(`${identity}\0build\0${service.logicalSlug}`).slice(0, 32)}`,
      source: { type: 'template' as const, catalogId, catalogVersion, catalogDigest, sourceDigest }, secretRefs, resourceDependencies,
      buildJobPayload: { requiredProtocolVersion: 2 as const, projectId: context.projectId, environmentId: context.environmentId,
        installationId, installationVersionId, serviceId: id, deploymentId, sourceType: 'template' as const, catalogId, catalogVersion, catalogDigest, sourceDigest,
        templateResourceIds: resourceDependencies.map(dependency => resources.find(resource => resource.logicalSlug === dependency.resourceLogicalSlug)!.id),
        buildMode: 'dockerfile' as const, dockerfilePath: 'Dockerfile' as const },
    };
  });
  const graph = { services, resources };
  return TemplateInstallationIntentSchema.parse({ requiredProtocolVersion: 2, installationId, installationVersionId, version: 1,
    actorUserId: context.actorUserId, projectId: context.projectId, environmentId: context.environmentId, environmentKind: context.environmentKind,
    catalogId, catalogVersion, catalogDigest, sourceDigest, requestIdempotencyKey, requestFingerprint: requestFingerprint(request), graphDigest: digest(stableJson(graph)),
    inputs, graph, services, resources, provenance: { catalogId, catalogVersion, catalogDigest, sourceDigest, previousVersion: null },
  });
}

export function installationProgress(input: Readonly<{ resourceStates: readonly string[]; buildStates: readonly string[] }>): { status: 'provisioning' | 'building' | 'failed' | 'ready'; completed: number; total: number } {
  const states = [...input.resourceStates, ...input.buildStates].map(state => state.toUpperCase());
  const failed = new Set(['FAILED', 'BUILD_FAILED', 'CANCELED', 'CANCELLED']);
  return { status: states.some(state => failed.has(state)) ? 'failed'
    : states.length > 0 && states.every(state => state === 'READY') ? 'ready'
      : input.resourceStates.some(state => state.toUpperCase() !== 'READY') ? 'provisioning' : 'building',
    completed: states.filter(state => state === 'READY' || failed.has(state)).length, total: states.length };
}

function parseRequest(input: unknown) {
  if (input && typeof input === 'object' && 'requiredProtocolVersion' in input && input.requiredProtocolVersion !== 2) fail('TEMPLATE_PROTOCOL_REQUIRED', 409);
  const parsed = TemplateInstallRequestSchema.safeParse(input);
  if (!parsed.success) fail('TEMPLATE_INPUT_INVALID', 400);
  return parsed.data;
}
function requestFingerprint(request: ReturnType<typeof parseRequest>): string {
  const { requiredProtocolVersion: _protocol, ...content } = request;
  return digest(stableJson(content));
}
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function digest(value: string): string { return `sha256:${hash(value)}`; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function fail(code: TemplateInstallationErrorCode, statusCode: 400 | 403 | 404 | 409): never { throw new TemplateInstallationError(code, statusCode); }

import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const requestKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const secretRef = z.string().regex(/^secret:[A-Za-z0-9_.-]{1,128}$/);
const environmentKind = z.enum(['prod', 'dev']);
const binding = z.union([
  z.strictObject({ input: identifier }),
  z.strictObject({ resource: identifier, secretKey: identifier }),
  z.strictObject({ default: z.string() }),
]);
const catalogService = z.strictObject({
  logicalSlug: identifier, type: z.enum(['web', 'worker', 'private', 'cron', 'job']),
  buildMode: z.literal('dockerfile'), environment: z.record(z.string(), binding), ingress: z.boolean(),
  port: z.number().int().min(1).max(65535).optional(), healthCheck: z.string().startsWith('/').optional(),
});
const catalogResource = z.strictObject({ logicalSlug: identifier, engine: identifier, plan: identifier });
export const TemplateStarterSchema = z.strictObject({
  id: identifier, version: identifier, immutable: z.literal(true),
  inputs: z.array(z.strictObject({ key: identifier, kind: z.literal('secret'), required: z.boolean() })),
  defaults: z.record(z.string(), z.string()),
  graph: z.strictObject({ services: z.array(catalogService).min(1), resources: z.array(catalogResource) }),
  source: z.strictObject({ digest, byteCount: z.number().int().nonnegative(), fileCount: z.number().int().positive(), format: z.literal('canonical-json-v1'), normalization: z.literal('sorted-posix-paths-fixed-modes-no-timestamps') }),
  provenance: z.strictObject({
    baseImages: z.array(z.strictObject({ image: z.string(), indexDigest: digest, linuxAmd64Digest: digest })),
    dependencies: z.array(z.strictObject({ name: z.string(), version: z.string() })),
    dependencyLockDigest: digest, observedBefore: z.iso.datetime(),
  }),
});
export const TemplateCatalogSchema = z.strictObject({
  schema: z.literal('raibitserver.starter-catalog/v1'), immutable: z.literal(true), packagingStatus: z.literal('source-verified'),
  bundleDigest: digest, catalogDigest: digest, starters: z.array(TemplateStarterSchema).min(1),
});
export const TemplateAvailabilitySchema = z.strictObject({ enabled: z.boolean(), reasonCode: z.literal('TEMPLATE_UNAVAILABLE').nullable() });
export const TemplateCatalogResponseSchema = z.strictObject({ catalogDigest: digest, availability: TemplateAvailabilitySchema, starters: z.array(TemplateStarterSchema) });
export const TemplateDetailResponseSchema = z.strictObject({ catalogDigest: digest, availability: TemplateAvailabilitySchema, starter: TemplateStarterSchema });
export const TemplateInstallRequestSchema = z.strictObject({
  requiredProtocolVersion: z.literal(2), catalogId: identifier, catalogVersion: identifier,
  catalogDigest: digest, sourceDigest: digest, requestIdempotencyKey: requestKey,
  inputs: z.record(identifier, z.string().min(1).max(16384).regex(/^[^\u0000\r\n]+$/)).default({}),
});
export const TemplateRetryRequestSchema = z.strictObject({ requiredProtocolVersion: z.literal(2), expectedVersion: z.number().int().positive(), requestIdempotencyKey: requestKey });
export const TemplateSourceIdentitySchema = z.strictObject({ type: z.literal('template'), catalogId: identifier, catalogVersion: identifier, catalogDigest: digest, sourceDigest: digest });
const buildPayload = z.strictObject({
  requiredProtocolVersion: z.literal(2), projectId: identifier, environmentId: identifier,
  installationId: identifier, installationVersionId: identifier, serviceId: identifier, deploymentId: identifier,
  sourceType: z.literal('template'), catalogId: identifier, catalogVersion: identifier, catalogDigest: digest, sourceDigest: digest,
  templateResourceIds: z.array(identifier), buildMode: z.literal('dockerfile'), dockerfilePath: z.literal('Dockerfile'),
});
export const TemplateServiceIntentSchema = catalogService.omit({ healthCheck: true }).extend({
  healthCheck: z.strictObject({ path: z.string().startsWith('/') }).optional(),
  id: identifier, projectId: identifier, environmentId: identifier, deploymentId: identifier, workflowJobId: identifier,
  source: TemplateSourceIdentitySchema, buildJobPayload: buildPayload,
  secretRefs: z.array(z.strictObject({ name: identifier, secretRef })),
  resourceDependencies: z.array(z.strictObject({ name: identifier, resourceLogicalSlug: identifier, secretKey: identifier })),
});
export const TemplateResourceIntentSchema = catalogResource.extend({ id: identifier, projectId: identifier, environmentId: identifier });
export const TemplateInstallationIntentSchema = z.strictObject({
  requiredProtocolVersion: z.literal(2), installationId: identifier, installationVersionId: identifier, version: z.number().int().positive(),
  actorUserId: identifier, projectId: identifier, environmentId: identifier, environmentKind,
  catalogId: identifier, catalogVersion: identifier, catalogDigest: digest, sourceDigest: digest,
  requestIdempotencyKey: requestKey, requestFingerprint: digest, graphDigest: digest,
  inputs: z.record(identifier, secretRef),
  graph: z.strictObject({ services: z.array(TemplateServiceIntentSchema), resources: z.array(TemplateResourceIntentSchema) }),
  services: z.array(TemplateServiceIntentSchema), resources: z.array(TemplateResourceIntentSchema),
  provenance: z.strictObject({ catalogId: identifier, catalogVersion: identifier, catalogDigest: digest, sourceDigest: digest, previousVersion: z.null() }),
});
export const PersistedTemplateVersionSchema = z.strictObject({ intent: TemplateInstallationIntentSchema, ownedHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
export const TemplateProgressSchema = z.strictObject({ status: z.enum(['provisioning', 'building', 'failed', 'ready']), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
const publicService = z.strictObject({ logicalSlug: identifier, type: catalogService.shape.type });
export const TemplatePreflightResponseSchema = z.strictObject({
  projectId: identifier, environmentId: identifier, environmentKind, catalogId: identifier, catalogVersion: identifier,
  services: z.array(publicService), resources: z.array(catalogResource),
});
export const TemplateInstallationResponseSchema = z.strictObject({
  installation: z.strictObject({ id: identifier, projectId: identifier, environmentId: identifier, environmentKind, version: z.number().int().positive(), catalogId: identifier, catalogVersion: identifier }),
  progress: TemplateProgressSchema,
  services: z.array(publicService.extend({ id: identifier, deploymentId: identifier })),
  resources: z.array(catalogResource.extend({ id: identifier })),
});
export const TemplateInstallationListResponseSchema = z.strictObject({ installations: z.array(TemplateInstallationResponseSchema) });
export const TemplateSourceDownloadSchema = z.strictObject({
  contentType: z.literal('application/vnd.raibitserver.starter-source.v1+json'), filename: z.string(),
  catalogId: identifier, catalogVersion: identifier, catalogDigest: digest, sourceDigest: digest,
  source: z.strictObject({ id: identifier, version: identifier, digest, files: z.array(z.strictObject({ path: z.string(), mode: z.enum(['0644', '0755']), size: z.number().int().nonnegative(), digest, contentBase64: z.string() })) }),
});
export type TemplateCatalog = z.infer<typeof TemplateCatalogSchema>;
export type TemplateInstallRequest = z.infer<typeof TemplateInstallRequestSchema>;
export type TemplateRetryRequest = z.infer<typeof TemplateRetryRequestSchema>;
export type TemplateInstallationIntent = z.infer<typeof TemplateInstallationIntentSchema>;
export type TemplateServiceIntent = z.infer<typeof TemplateServiceIntentSchema>;
export type TemplateResourceIntent = z.infer<typeof TemplateResourceIntentSchema>;
export type TemplateBuildJobPayload = z.infer<typeof buildPayload>;
export type TemplateSourceDownload = z.infer<typeof TemplateSourceDownloadSchema>;
export type TemplateCatalogResponse = z.infer<typeof TemplateCatalogResponseSchema>;
export type TemplateDetailResponse = z.infer<typeof TemplateDetailResponseSchema>;
export type TemplatePreflightResponse = z.infer<typeof TemplatePreflightResponseSchema>;
export type TemplateInstallationResponse = z.infer<typeof TemplateInstallationResponseSchema>;
export type TemplateInstallationListResponse = z.infer<typeof TemplateInstallationListResponseSchema>;

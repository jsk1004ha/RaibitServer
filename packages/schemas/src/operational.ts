import { z } from 'zod';
import {
  OPERATIONAL_COMPONENTS,
  OPERATIONAL_PROTOCOL_VERSION,
  OperationalComponentSchema,
  OperationalFeatureStatusFields,
  OperationalIdentifierSchema,
  OperationalSha256Schema,
  OperationalSlugSchema,
  OperationalSourceRevisionSchema,
} from './operational-shared.ts';

export * from './operational-shared.ts';
export * from './operational-writers.ts';

const TemplateCatalogSchema = z.strictObject({
  id: OperationalIdentifierSchema,
  version: z.string().regex(/^v[1-9][0-9]*$/),
  catalogDigest: OperationalSha256Schema,
  sourceDigest: OperationalSha256Schema,
  packagingStatus: z.literal('contract-only'),
  immutable: z.literal(true),
  graph: z.strictObject({
    services: z.array(z.strictObject({ logicalSlug: OperationalSlugSchema, type: z.enum(['web', 'private', 'worker', 'cron', 'job']) }).readonly()).min(1).readonly(),
    resources: z.array(z.strictObject({ logicalSlug: OperationalSlugSchema, engine: z.string().min(1).max(63) }).readonly()).readonly(),
  }).readonly(),
}).readonly();

const NotificationFeatureSchema = z.strictObject({
  ...OperationalFeatureStatusFields,
  defaultEnvironmentKinds: z.tuple([z.literal('prod')]).readonly(),
  defaultEvents: z.tuple([
    z.literal('deployment.failed'), z.literal('runtime.unhealthy'), z.literal('backup.failed'), z.literal('promotion.failed'),
  ]).readonly(),
  optionalEvents: z.tuple([
    z.literal('deployment.ready'), z.literal('runtime.recovered'), z.literal('backup.ready'), z.literal('promotion.ready'),
  ]).readonly(),
  payloadAllowlist: z.tuple([
    z.literal('projectId'), z.literal('environmentId'), z.literal('logicalSubject'), z.literal('eventCode'), z.literal('status'),
    z.literal('safeErrorCode'), z.literal('occurredAt'), z.literal('shortRevision'), z.literal('consoleUrl'),
  ]).readonly(),
  semanticDedupFields: z.tuple([
    z.literal('destinationId'), z.literal('destinationVersion'), z.literal('eventCode'), z.literal('subjectId'),
    z.literal('subjectGenerationOrIncidentSequence'),
  ]).readonly(),
}).readonly();

export const OperationalFeaturesContractSchema = z.strictObject({
  schema: z.literal('raibitserver.operational-features/v1'),
  contractVersion: z.literal(1),
  approvalBaselineRevision: OperationalSourceRevisionSchema,
  protocol: z.strictObject({
    version: z.literal(OPERATIONAL_PROTOCOL_VERSION),
    featureActivationDefault: z.literal(false),
    writerRequiredVersion: z.literal(OPERATIONAL_PROTOCOL_VERSION),
    readinessComponents: z.tuple([
      z.literal('api'), z.literal('operations-worker'), z.literal('builder'), z.literal('orchestrator'), z.literal('provisioner'),
    ]).readonly(),
  }).readonly(),
  ownership: z.strictObject({
    typescript: z.tuple([z.literal('product-api'), z.literal('template-policy'), z.literal('scheduling'), z.literal('discord-delivery')]).readonly(),
    go: z.tuple([z.literal('builds'), z.literal('resource-provisioning'), z.literal('runtime-reconciliation')]).readonly(),
  }).readonly(),
  environment: z.strictObject({
    defaultKind: z.literal('prod'),
    kinds: z.tuple([z.literal('prod'), z.literal('dev')]).readonly(),
    bindingIdentity: z.strictObject({
      environmentId: OperationalIdentifierSchema,
      serviceId: OperationalIdentifierSchema,
      resourceId: OperationalIdentifierSchema,
      logicalServiceSlug: OperationalSlugSchema,
      logicalResourceSlug: OperationalSlugSchema,
    }).refine((value) => value.serviceId !== value.logicalServiceSlug && value.resourceId !== value.logicalResourceSlug, {
      message: 'logical and physical identities must remain distinct',
    }).readonly(),
    legacyProdIdentityUnchanged: z.literal(true),
  }).readonly(),
  features: z.strictObject({
    templates: z.strictObject({ ...OperationalFeatureStatusFields, catalogs: z.array(TemplateCatalogSchema).min(1).readonly() }).readonly(),
    notifications: NotificationFeatureSchema,
    storage: z.strictObject({
      ...OperationalFeatureStatusFields,
      provider: z.literal('dedicated-local'), endpointSource: z.literal('provider-state'), requestSelectableEndpoint: z.literal(false),
      bucketPrivate: z.literal(true), identityKinds: z.tuple([z.literal('provider-admin'), z.literal('tenant-bucket-scoped')]).readonly(),
      signedUrlTtlSeconds: z.literal(300),
    }).readonly(),
    scheduledRecovery: z.strictObject({
      ...OperationalFeatureStatusFields,
      enabledByDefault: z.literal(false), timezone: z.literal('Asia/Seoul'), defaultLocalMinute: z.literal(180),
      scheduledRetention: z.strictObject({ mode: z.literal('success-count'), count: z.literal(7), ageExpiryDays: z.null() }).readonly(),
      manualRetention: z.strictObject({ origin: z.literal('manual'), expiryDays: z.literal(30), unchanged: z.literal(true) }).readonly(),
    }).readonly(),
    environments: z.strictObject({
      ...OperationalFeatureStatusFields,
      promotion: z.strictObject({
        sourceKind: z.literal('dev'), targetKind: z.literal('prod'), immutableImageDigestRequired: z.literal(true),
        copiesData: z.literal(false), copiesSecrets: z.literal(false), copiesProductionQuota: z.literal(false), previewTtlSeconds: z.literal(600),
      }).readonly(),
    }).readonly(),
  }).readonly(),
  mutationPolicy: z.strictObject({ unknownFields: z.literal('reject'), environmentDefault: z.literal('prod'), requiredProtocolVersion: z.literal(2) }).readonly(),
  rbac: z.strictObject({
    environmentAdministration: z.tuple([z.literal('OWNER'), z.literal('ADMIN')]).readonly(),
    promotionApproval: z.tuple([z.literal('OWNER'), z.literal('ADMIN')]).readonly(),
  }).readonly(),
  errors: z.strictObject({ wrongProjectEnvironment: z.literal(404), forbiddenSameScope: z.literal(403), staleMutation: z.literal(409) }).readonly(),
}).readonly();

const OperationalComponentReadinessSchema = z.strictObject({
  component: OperationalComponentSchema,
  protocolVersion: z.literal(OPERATIONAL_PROTOCOL_VERSION),
  contractDigest: OperationalSha256Schema,
  releaseRevision: OperationalSourceRevisionSchema,
  implementationAvailable: z.literal(true),
}).readonly();

export const OperationalReadinessSchema = z.strictObject({
  protocolVersion: z.literal(OPERATIONAL_PROTOCOL_VERSION),
  contractDigest: OperationalSha256Schema,
  components: z.array(OperationalComponentReadinessSchema).length(OPERATIONAL_COMPONENTS.length).superRefine((components, context) => {
    const names = new Set(components.map(({ component }) => component));
    if (names.size !== OPERATIONAL_COMPONENTS.length || OPERATIONAL_COMPONENTS.some((component) => !names.has(component))) {
      context.addIssue({ code: 'custom', message: 'every operational component must report readiness exactly once' });
    }
  }).readonly(),
}).readonly();

export type OperationalFeaturesContract = z.infer<typeof OperationalFeaturesContractSchema>;
export type OperationalReadiness = z.infer<typeof OperationalReadinessSchema>;

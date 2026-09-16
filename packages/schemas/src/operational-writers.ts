import { z } from 'zod';
import {
  OPERATIONAL_PROTOCOL_VERSION,
  OperationalEnvironmentKindSchema,
  OperationalEventSchema,
  OperationalIdentifierSchema,
  OperationalSha256Schema,
  OperationalSlugSchema,
} from './operational-shared.ts';

const RequiredProtocolField = { requiredProtocolVersion: z.literal(OPERATIONAL_PROTOCOL_VERSION) };

export const TemplateWriterIntentSchema = z.strictObject({
  ...RequiredProtocolField,
  catalogId: OperationalIdentifierSchema,
  catalogVersion: z.string().regex(/^v[1-9][0-9]*$/),
  catalogDigest: OperationalSha256Schema,
  environmentId: OperationalIdentifierSchema,
  environmentKind: OperationalEnvironmentKindSchema.default('prod'),
  logicalServiceSlug: OperationalSlugSchema,
  serviceId: OperationalIdentifierSchema,
  requestIdempotencyKey: OperationalIdentifierSchema,
}).refine((value) => value.logicalServiceSlug !== value.serviceId, {
  message: 'logical service slug and physical service id must remain distinct',
});

export const NotificationPayloadSchema = z.strictObject({
  projectId: OperationalIdentifierSchema,
  environmentId: OperationalIdentifierSchema,
  logicalSubject: z.string().min(1).max(160),
  eventCode: OperationalEventSchema,
  status: z.enum(['FAILED', 'READY', 'UNHEALTHY', 'RECOVERED']),
  safeErrorCode: z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/),
  occurredAt: z.iso.datetime(),
  shortRevision: z.string().min(7).max(16).regex(/^[a-f0-9]+$/),
  consoleUrl: z.url({ protocol: /^https$/ }),
}).readonly();

export const NotificationWriterIntentSchema = z.strictObject({
  ...RequiredProtocolField,
  destinationId: OperationalIdentifierSchema,
  destinationVersion: z.number().int().positive(),
  environmentKind: OperationalEnvironmentKindSchema.default('prod'),
  eventCode: OperationalEventSchema,
  subjectId: OperationalIdentifierSchema,
  subjectGenerationOrIncidentSequence: z.number().int().nonnegative(),
  payload: NotificationPayloadSchema,
}).refine((value) => value.eventCode === value.payload.eventCode, {
  message: 'notification event identity must match its safe payload',
});

export const StorageWriterIntentSchema = z.strictObject({
  ...RequiredProtocolField,
  resourceId: OperationalIdentifierSchema,
  environmentId: OperationalIdentifierSchema,
  environmentKind: OperationalEnvironmentKindSchema.default('prod'),
  key: z.string().min(1).max(1024).refine((value) => !value.includes('\0') && !value.split('/').includes('..'), {
    message: 'object key contains a forbidden segment',
  }),
  sizeBytes: z.number().int().nonnegative(),
  checksumSha256: OperationalSha256Schema,
}).readonly();

export const ScheduledRecoveryWriterIntentSchema = z.strictObject({
  ...RequiredProtocolField,
  resourceId: OperationalIdentifierSchema,
  environmentId: OperationalIdentifierSchema,
  environmentKind: OperationalEnvironmentKindSchema.default('prod'),
  enabled: z.boolean().default(false),
  timezone: z.literal('Asia/Seoul'),
  localMinute: z.number().int().min(0).max(1439).default(180),
  origin: z.literal('scheduled'),
  retention: z.strictObject({ mode: z.literal('success-count'), count: z.literal(7) }).readonly(),
  expectedVersion: z.number().int().nonnegative(),
}).readonly();

const EnvironmentBaseFields = {
  ...RequiredProtocolField,
  projectId: OperationalIdentifierSchema,
  expectedVersion: z.number().int().nonnegative(),
};

export const EnvironmentWriterIntentSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...EnvironmentBaseFields, operation: z.literal('create-dev'), environmentKind: z.literal('dev') }).readonly(),
  z.strictObject({ ...EnvironmentBaseFields, operation: z.literal('delete-dev'), environmentKind: z.literal('dev'), confirmation: z.string().min(1).max(256) }).readonly(),
  z.strictObject({
    ...EnvironmentBaseFields,
    operation: z.literal('promote'),
    sourceEnvironmentId: OperationalIdentifierSchema,
    sourceEnvironmentKind: z.literal('dev'),
    targetEnvironmentId: OperationalIdentifierSchema,
    targetEnvironmentKind: z.literal('prod'),
    sourceImageDigest: OperationalSha256Schema,
    previewId: OperationalIdentifierSchema,
    diffHash: OperationalSha256Schema,
    requestIdempotencyKey: OperationalIdentifierSchema,
    copiesData: z.literal(false),
    copiesSecrets: z.literal(false),
    copiesProductionQuota: z.literal(false),
  }).readonly(),
]);

export type TemplateWriterIntent = z.infer<typeof TemplateWriterIntentSchema>;
export type NotificationWriterIntent = z.infer<typeof NotificationWriterIntentSchema>;
export type StorageWriterIntent = z.infer<typeof StorageWriterIntentSchema>;
export type ScheduledRecoveryWriterIntent = z.infer<typeof ScheduledRecoveryWriterIntentSchema>;
export type EnvironmentWriterIntent = z.infer<typeof EnvironmentWriterIntentSchema>;
export type OperationalWriterIntent = TemplateWriterIntent | NotificationWriterIntent | StorageWriterIntent | ScheduledRecoveryWriterIntent | EnvironmentWriterIntent;

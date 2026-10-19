import { z } from 'zod';
import { OperationalEnvironmentKindSchema, OperationalEventSchema, OperationalIdentifierSchema } from './operational-shared.ts';
import { ScheduledRecoveryWriterIntentSchema } from './operational-writers.ts';

const id = z.string().min(1);
const version = z.number().int().positive();
const deliveryStatus = z.enum(['pending', 'sending', 'succeeded', 'failed', 'unknown', 'cancelled']);

export const DiscordConfigurationSchema = z.strictObject({
  webhookUrl: z.string().regex(/^https:\/\/discord\.com(?::443)?\/api\/webhooks\/[1-9][0-9]*\/[A-Za-z0-9._-]{20,}$/),
  expectedVersion: z.number().int().nonnegative(),
  environments: z.array(OperationalEnvironmentKindSchema).min(1).optional(),
  events: z.array(OperationalEventSchema).min(1).optional(),
});
export const DiscordExpectedVersionSchema = z.strictObject({ expectedVersion: version });
export const DiscordTestInputSchema = DiscordExpectedVersionSchema.extend({
  environmentId: OperationalIdentifierSchema,
  environmentKind: OperationalEnvironmentKindSchema.optional(),
});
export const DiscordDeliveryQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const DiscordDestinationSchema = z.strictObject({
  id, projectId: id, version, enabled: z.boolean(),
  environments: z.array(OperationalEnvironmentKindSchema).min(1),
  events: z.array(OperationalEventSchema).min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), webhookConfigured: z.literal(true),
});
export const DiscordDestinationReadSchema = z.union([DiscordDestinationSchema, z.strictObject({ configured: z.literal(false) })]);
export const DiscordDeletedSchema = z.strictObject({ deleted: z.literal(true), version });
export const DiscordTestAcceptedSchema = z.strictObject({
  intentId: id, destinationVersion: version, status: deliveryStatus, queued: z.literal(true), sentInRequest: z.literal(false),
});
export const DiscordDeliveryPageSchema = z.strictObject({
  rows: z.array(z.strictObject({
    id, destinationVersion: version, eventCode: OperationalEventSchema, subjectId: id,
    subjectGenerationOrIncidentSequence: z.number().int().nonnegative(), status: deliveryStatus,
    createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  })),
  nextCursor: z.string().nullable(),
});
export const DiscordErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum([
    'DISCORD_CURSOR_INVALID', 'DISCORD_DESTINATION_NOT_FOUND', 'DISCORD_FORBIDDEN', 'DISCORD_INPUT_INVALID',
    'DISCORD_MENTION_FORBIDDEN', 'DISCORD_PAYLOAD_INVALID', 'DISCORD_PERSISTENCE_UNAVAILABLE', 'DISCORD_STALE_VERSION', 'DISCORD_WEBHOOK_INVALID',
  ]) }),
});

export const BackupPolicyUpdateSchema = ScheduledRecoveryWriterIntentSchema;
export const BackupPolicySchema = z.strictObject({
  id, organizationId: id, projectId: id, environmentId: id, resourceId: id, createdByUserId: id,
  enabled: z.boolean(), version, timezone: z.literal('Asia/Seoul'), localMinute: z.number().int().min(0).max(1439),
  nextRunAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const BackupRunQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional(),
});
const backupRun = z.strictObject({
  id, policyId: id, policyVersion: version, resourceId: id, environmentId: id,
  scheduledAtUtc: z.iso.datetime(), origin: z.literal('scheduled'),
  status: z.enum(['DUE', 'SKIPPED', 'RUNNING', 'READY', 'FAILED']),
  skipReason: z.enum(['MISSED_WINDOW', 'OVERLAPPING_BACKUP', 'POLICY_DISABLED', 'SOURCE_NOT_READY', 'ENGINE_UNSUPPORTED', 'CAPABILITY_UNAVAILABLE', 'QUOTA_EXCEEDED', 'OPERATOR_RECOVERY_NOT_READY']).nullable(),
  backupId: id.nullable(), startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
  errorCode: z.string().nullable(), createdAt: z.iso.datetime(),
  policySnapshot: ScheduledRecoveryWriterIntentSchema.unwrap().extend({
    environmentKind: OperationalEnvironmentKindSchema, enabled: z.literal(true), localMinute: z.number().int().min(0).max(1439),
  }),
}).refine((run) => (run.status === 'SKIPPED') === (run.skipReason !== null), 'skipped runs require a skip reason');
export const BackupRunPageSchema = z.strictObject({ runs: z.array(backupRun), nextCursor: z.string().nullable() });
export const BackupPolicyErrorSchema = z.strictObject({
  statusCode: z.number().int().min(400).max(599),
  code: z.enum([
    'BACKUP_POLICY_INPUT_INVALID', 'BACKUP_POLICY_FORBIDDEN', 'BACKUP_POLICY_VERSION_CONFLICT', 'BACKUP_POLICY_SOURCE_NOT_READY',
    'BACKUP_POLICY_ENGINE_UNSUPPORTED', 'BACKUP_POLICY_CAPABILITY_UNAVAILABLE', 'BACKUP_POLICY_QUOTA_EXCEEDED',
    'BACKUP_POLICY_OPERATOR_NOT_READY', 'BACKUP_POLICY_WRITER_NOT_READY', 'BACKUP_POLICY_NOT_FOUND', 'OPERATIONAL_PERSISTENCE_UNAVAILABLE',
  ]),
});

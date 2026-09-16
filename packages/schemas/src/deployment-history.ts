import { z } from 'zod';
import { DeploymentStatusSchema } from './lifecycle.ts';

const id = z.string().min(1);
const timestamp = z.iso.datetime();
const nullableTimestamp = timestamp.nullable();
const nullableId = id.nullable();
const actionType = z.enum(['retry', 'redeploy', 'cancel', 'rollback']);

export const DeploymentHistoryQuerySchema = z.strictObject({
  serviceId: id.optional(),
  environment: z.enum(['production', 'preview', 'manual']).optional(),
  status: DeploymentStatusSchema.optional(),
  trigger: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/).optional(),
}).refine((query) => !query.from || !query.to || query.from <= query.to, { message: 'deployment_history_date_range_invalid' });

export const DeploymentHistoryActionSchema = z.strictObject({
  type: actionType,
  targetId: id,
  href: z.string().startsWith('/'),
  method: z.literal('POST'),
  confirmationRequired: z.literal(true),
  snapshotVersion: z.number().int().positive().nullable(),
});

export const DeploymentHistoryRowSchema = z.strictObject({
  id,
  projectId: id,
  service: z.strictObject({ id, name: z.string().min(1), slug: z.string().min(1) }),
  environment: z.enum(['production', 'preview', 'manual']),
  status: DeploymentStatusSchema,
  trigger: z.string().min(1),
  createdAt: timestamp,
  updatedAt: timestamp,
  source: z.strictObject({ commitSha: z.string().nullable(), imageDigest: z.string().nullable(), snapshotVersion: z.number().int().positive().nullable() }),
  lineage: z.strictObject({
    sourceDeploymentId: nullableId, retryOfDeploymentId: nullableId, rollbackOfDeploymentId: nullableId,
    previousDeploymentId: nullableId, previewLineageId: nullableId, previewGeneration: z.number().int().nonnegative().nullable(),
  }),
  operation: z.strictObject({ requestedByUserId: nullableId, requestIdempotencyKey: z.string().nullable() }),
  health: z.strictObject({
    rolloutStatus: DeploymentStatusSchema, publicHealthStatus: z.string().min(1), healthCheckedAt: nullableTimestamp,
    healthFailureCode: z.string().nullable(), observedGeneration: z.number().int().nonnegative().nullable(),
  }),
  recovery: z.strictObject({ retryable: z.boolean(), reason: z.string().nullable() }),
  permissions: z.strictObject({ execute: z.boolean() }),
  eligibleAction: DeploymentHistoryActionSchema.nullable(),
});

const filters = z.strictObject({
  serviceId: nullableId, environment: z.enum(['production', 'preview', 'manual']).nullable(), status: DeploymentStatusSchema.nullable(),
  trigger: z.string().nullable(), from: nullableTimestamp, to: nullableTimestamp,
});

export const DeploymentHistoryResponseSchema = z.strictObject({
  deployments: z.array(DeploymentHistoryRowSchema),
  page: z.strictObject({ limit: z.number().int().min(1).max(100), nextCursor: z.string().nullable() }),
  filters,
});

export type DeploymentHistoryQuery = z.infer<typeof DeploymentHistoryQuerySchema>;
export type DeploymentHistoryQueryInput = z.input<typeof DeploymentHistoryQuerySchema>;
export type DeploymentHistoryRow = z.infer<typeof DeploymentHistoryRowSchema>;
export type DeploymentHistoryResponse = z.infer<typeof DeploymentHistoryResponseSchema>;

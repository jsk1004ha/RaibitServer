import { z } from 'zod';

export const DeploymentOperationInputSchema = z.strictObject({
  requestIdempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  snapshotVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type DeploymentOperationInput = z.infer<typeof DeploymentOperationInputSchema>;
export const DeploymentLineageFields = {
  sourceDeploymentId: z.string().nullable().optional(),
  retryOfDeploymentId: z.string().nullable().optional(),
  requestIdempotencyKey: z.string().nullable().optional(),
  desiredSpecSnapshot: z.record(z.string(), z.json()).nullable().optional(),
  requestedByUserId: z.string().nullable().optional(),
  snapshotVersion: z.number().int().positive().nullable().optional(),
};

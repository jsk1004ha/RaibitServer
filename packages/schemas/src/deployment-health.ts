import { z } from 'zod';
import { HEALTH_FAILURE_CODES, HealthPathError, isSafeHealthPath, serviceHealthInput } from '../../core/src/deployment-health.ts';
import { HealthStatusSchema } from './lifecycle.ts';

export const HealthPathSchema = z.string().max(1024).regex(/^\/(?!\/)[^\\\s?#\u0000-\u001f\u007f]*$/).refine(isSafeHealthPath).describe('Safe absolute path, max 1024 UTF-8 bytes; no query, fragment, dot segments or encoded separators/controls');
export const ServiceHealthFields = {
  healthCheckPath: HealthPathSchema.nullable().optional(),
  livenessPath: HealthPathSchema.nullable().optional(),
  readinessPath: HealthPathSchema.nullable().optional(),
  publicHealthPath: HealthPathSchema.nullable().optional(),
  healthCheck: z.object({ path: HealthPathSchema }).strict().nullable().optional(),
};
export const DeploymentHealthFields = {
  publicHealthStatus: HealthStatusSchema.default('UNKNOWN'),
  healthCheckedAt: z.iso.datetime().nullable().default(null),
  healthFailureCode: z.enum(HEALTH_FAILURE_CODES).nullable().default(null),
  observedGeneration: z.number().int().min(1).max(2147483647).nullable().default(null),
};
export type DeploymentHealth = z.infer<z.ZodObject<typeof DeploymentHealthFields>>;
export function refineServiceHealth(input: Readonly<Record<string, unknown>>, context: z.RefinementCtx) {
  try { serviceHealthInput(input); } catch (error) {
    if (!(error instanceof HealthPathError)) throw error;
    context.addIssue({ code: 'custom', path: error.field.split('.'), message: error.code });
  }
}

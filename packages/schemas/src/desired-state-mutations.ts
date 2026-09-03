import { z } from 'zod';
import { DesiredStateMutationError, parseServiceMutation } from '../../core/src/desired-state-mutations.ts';

const label = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const sourcePath = z.string().min(1).max(1024).regex(/^(?![\/\\])(?!.*:)(?!.*(?:^|[\/\\])\.\.(?:[\/\\]|$))[^\u0000-\u001f\u007f]+$/);
const command = z.string().max(4096).regex(/^[^\u0000-\u001f\u007f]*$/);
const quantities = z.object({
  cpu: z.string().regex(/^(?:\d+(?:\.\d{1,3})?|\d+m)$/).describe('Positive CPU quantity; increases require the authenticated actor quota (500m fallback)').optional(),
  memory: z.string().regex(/^\d+(?:Mi|Gi)$/).describe('Positive memory quantity; increases require the authenticated actor quota (512Mi fallback)').optional(),
}).strict();

export const ProjectUpdateSchema = z.object({ name: label.optional(), description: z.string().max(4096).regex(/^[^\u0000-\u001f\u007f]*$/).optional() }).strict();
export const ServiceUpdateSchema = z.object({
  name: label.describe('Editable only before the first deployment').optional(),
  type: z.enum(['web', 'private', 'worker', 'cron', 'job']).describe('Editable only before the first deployment').optional(),
  branch: z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  rootDirectory: sourcePath.optional(), buildContext: sourcePath.optional(), dockerfilePath: sourcePath.optional(), outputDirectory: sourcePath.optional(),
  installCommand: command.optional(), buildCommand: command.optional(), startCommand: command.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  healthCheck: z.object({ path: z.string().min(1).max(1024).regex(/^\/(?!\/)[^\\\s?#\u0000-\u001f\u007f]*$/) }).strict().optional(),
  resources: z.object({ requests: quantities.optional(), limits: quantities.optional() }).strict().optional(),
}).strict().superRefine((input, context) => {
  try { parseServiceMutation(input); } catch (error) {
    if (!(error instanceof DesiredStateMutationError)) throw error;
    context.addIssue({ code: 'custom', path: error.field.split('.'), message: error.code });
  }
});
export const ResourceUpdateSchema = z.object({
  name: label.optional(), type: z.string().optional(), engine: z.string().optional(), provider: z.string().optional(), plan: z.string().optional(), region: z.string().optional(), version: z.string().optional(),
  storageMb: z.number().int().positive().optional(), storageGb: z.number().int().positive().optional(),
  databaseName: label.optional(), database: label.optional(), username: label.optional(), bucket: label.optional(), collection: label.optional(), topic: label.optional(),
  desiredSpec: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
export type ServiceUpdate = z.infer<typeof ServiceUpdateSchema>;
export type ResourceUpdate = z.infer<typeof ResourceUpdateSchema>;

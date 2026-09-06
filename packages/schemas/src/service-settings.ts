import { z } from 'zod';
import { ServiceUpdateSchema } from './desired-state-mutations.ts';

const sourceType = z.enum(['github', 'gitlab', 'zip', 'image', 'local']);
const sourceFields = {
  sourceType: sourceType.optional(),
  repoUrl: z.string().url().or(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional(),
  image: z.string().min(1).max(2048).optional(),
  imageUrl: z.string().min(1).max(2048).optional(),
} as const;
const files = z.record(z.string().max(1024), z.string().max(1_048_576)).refine(
  (entries) => Object.keys(entries).length <= 500 && Object.values(entries).reduce((total, value) => total + value.length, 0) <= 1_048_576,
  'repository file preview exceeds its bounded input limit',
);

export const ServiceSettingsChangesSchema = ServiceUpdateSchema;
export const ServiceSettingsMutationSchema = z.object({
  expectedUpdatedAt: z.iso.datetime(),
  changes: ServiceSettingsChangesSchema,
  files: files.optional(),
}).strict();
export const ServiceSettingsSnapshotSchema = z.object({
  serviceId: z.string().min(1), projectId: z.string().min(1), updatedAt: z.iso.datetime(), deployed: z.boolean(),
  settings: ServiceSettingsChangesSchema,
}).strict();
export const ServiceSettingsDiffEntrySchema = z.object({
  field: z.string().min(1), before: z.json().nullable(), after: z.json().nullable(),
}).strict();
export const ServiceSettingsPreviewSchema = z.object({
  snapshot: ServiceSettingsSnapshotSchema,
  settings: ServiceSettingsChangesSchema,
  diff: z.array(ServiceSettingsDiffEntrySchema),
  buildPlan: z.object({ before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) }).strict(),
}).strict();
export const ServiceReplacementInputSchema = z.object({
  expectedUpdatedAt: z.iso.datetime(), confirmed: z.literal(true), name: z.string().min(1).max(128),
  source: z.object({ sourceType, repoUrl: sourceFields.repoUrl, image: sourceFields.image, imageUrl: sourceFields.imageUrl }).strict(),
}).strict();
export const ServiceReplacementResultSchema = z.object({
  impact: z.literal('old_service_preserved'), oldServiceId: z.string().min(1),
  service: z.object({ id: z.string().min(1), projectId: z.string().min(1), name: z.string(), type: z.string(), sourceType }).catchall(z.json()),
}).strict();

export type ServiceSettingsChanges = z.infer<typeof ServiceSettingsChangesSchema>;
export type ServiceSettingsMutation = z.infer<typeof ServiceSettingsMutationSchema>;
export type ServiceSettingsSnapshot = z.infer<typeof ServiceSettingsSnapshotSchema>;
export type ServiceSettingsPreview = z.infer<typeof ServiceSettingsPreviewSchema>;
export type ServiceReplacementInput = z.infer<typeof ServiceReplacementInputSchema>;
export type ServiceReplacementResult = z.infer<typeof ServiceReplacementResultSchema>;

import { z } from 'zod';

const id = z.string().min(1);
const timestamp = z.iso.datetime();
const name = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const description = z.string().max(4096).regex(/^[^\u0000-\u001f\u007f]*$/);

export const ProjectSettingsUpdateSchema = z.strictObject({
  name: name.optional(),
  description: description.optional(),
  expectedUpdatedAt: timestamp,
}).refine((input) => input.name !== undefined || input.description !== undefined, { message: 'project_settings_change_required' });

export const ProjectDeletionConfirmationSchema = z.strictObject({ confirmed: z.literal(true) });

export const ProjectSettingsViewSchema = z.strictObject({
  project: z.strictObject({
    id,
    organizationId: id,
    name,
    slug: z.string().min(1),
    description,
    status: z.string().min(1),
    updatedAt: timestamp,
    deletionRequestedAt: timestamp.nullable(),
  }),
  snapshot: z.strictObject({ updatedAt: timestamp }),
  deletionImpact: z.strictObject({
    services: z.number().int().nonnegative(),
    resources: z.number().int().nonnegative(),
    previews: z.number().int().nonnegative(),
  }),
});

export const ProjectDeletionScheduledSchema = z.strictObject({
  projectId: id,
  status: z.enum(['DELETE_REQUESTED', 'DELETING']),
  deletionRequestedAt: timestamp,
  scheduled: z.literal(true),
});

export type ProjectSettingsUpdate = z.infer<typeof ProjectSettingsUpdateSchema>;
export type ProjectDeletionConfirmation = z.infer<typeof ProjectDeletionConfirmationSchema>;
export type ProjectSettingsView = z.infer<typeof ProjectSettingsViewSchema>;
export type ProjectDeletionScheduled = z.infer<typeof ProjectDeletionScheduledSchema>;

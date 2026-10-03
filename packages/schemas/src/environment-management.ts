import { z } from 'zod';
import { OperationalEnvironmentKindSchema, OperationalIdentifierSchema } from './operational-shared.ts';

export const EnvironmentSelectorSchema = z.strictObject({
  environmentId: OperationalIdentifierSchema.optional(),
  environment: OperationalEnvironmentKindSchema.optional(),
  environmentKind: OperationalEnvironmentKindSchema.optional(),
}).refine((value) => value.environment === undefined || value.environmentKind === undefined || value.environment === value.environmentKind, {
  message: 'environment selectors disagree',
});

export const EnvironmentCreateSchema = z.strictObject({
  kind: z.literal('dev'),
  expectedVersion: z.literal(0),
});

export const EnvironmentDeleteSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  confirmation: z.string().min(1).max(256),
});

export const EnvironmentViewSchema = z.strictObject({
  id: OperationalIdentifierSchema,
  projectId: OperationalIdentifierSchema,
  kind: OperationalEnvironmentKindSchema,
  status: z.literal('active'),
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const EnvironmentListViewSchema = z.strictObject({ environments: z.array(EnvironmentViewSchema).readonly() });
export const EnvironmentDeletedViewSchema = z.strictObject({ deleted: z.literal(true), environmentId: OperationalIdentifierSchema });

export type EnvironmentSelectorInput = z.input<typeof EnvironmentSelectorSchema>;
export type EnvironmentCreate = z.input<typeof EnvironmentCreateSchema>;
export type EnvironmentDelete = z.input<typeof EnvironmentDeleteSchema>;
export type EnvironmentView = z.output<typeof EnvironmentViewSchema>;

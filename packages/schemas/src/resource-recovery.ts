import { z } from 'zod';
import { BackupStatusSchema, RestoreStatusSchema } from './lifecycle.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const key = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const ResourceBackupCreateSchema = z.strictObject({ requestIdempotencyKey: key, formatVersion: z.literal(1) }).readonly();
export const ResourceBackupDeleteSchema = z.strictObject({ confirmed: z.literal(true) }).readonly();
export const ResourceBackupListSchema = z.strictObject({
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(1024).optional(),
}).readonly();
export const ResourceRestoreCreateSchema = z.strictObject({ requestIdempotencyKey: key, formatVersion: z.literal(1), name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/) }).readonly();
export const ProviderImageProvenanceSchema = z.strictObject({
  schema: z.literal('raibitserver.provider-image/v1'),
  image: z.string().regex(/^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/).refine(value => !/@sha256:0{64}$/.test(value)),
  workloadUid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  workloadGeneration: z.number().int().positive(), observedAt: z.iso.datetime(),
}).readonly();
export const ResourceBackupViewSchema = z.strictObject({
  id, organizationId: id, projectId: id, resourceId: id, engine: z.string(), status: BackupStatusSchema,
  createdAt: z.string(), readyAt: z.string().nullable(), errorCode: z.string().nullable(),
  size: z.string().regex(/^[1-9][0-9]*$/).nullable(), expiresAt: z.string().nullable(), recoverable: z.boolean(),
}).readonly();
export const ResourceRestoreViewSchema = z.strictObject({
  id, organizationId: id, projectId: id, backupId: id, sourceResourceId: id, targetResourceId: id,
  engine: z.string(), status: RestoreStatusSchema, createdAt: z.string(), readyAt: z.string().nullable(), errorCode: z.string().nullable(),
}).readonly();
export const ResourceBackupListViewSchema = z.strictObject({ backups: z.array(ResourceBackupViewSchema).readonly(), nextCursor: z.string().nullable() }).readonly();
export type ResourceBackupCreate = z.infer<typeof ResourceBackupCreateSchema>;
export type ResourceBackupDelete = z.infer<typeof ResourceBackupDeleteSchema>;
export type ResourceBackupList = z.infer<typeof ResourceBackupListSchema>;
export type ResourceRestoreCreate = z.infer<typeof ResourceRestoreCreateSchema>;
export type ResourceBackupView = z.infer<typeof ResourceBackupViewSchema>;
export type ResourceRestoreView = z.infer<typeof ResourceRestoreViewSchema>;
export type ResourceBackupListView = z.infer<typeof ResourceBackupListViewSchema>;

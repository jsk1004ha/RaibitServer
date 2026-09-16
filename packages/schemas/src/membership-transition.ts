import { z } from 'zod';
import { MembershipRoleMutationSchema } from './organization-role.ts';

export const OrganizationMemberViewSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  role: MembershipRoleMutationSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  user: z.object({
    id: z.string().min(1),
    email: z.email(),
    name: z.string().nullable(),
    avatarUrl: z.url().nullable(),
  }),
});

export const OrganizationMemberListSchema = z.object({ members: z.array(OrganizationMemberViewSchema) });
export const OrganizationMembershipRoleChangeSchema = z.object({
  role: MembershipRoleMutationSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export const OrganizationMembershipSnapshotSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const OrganizationMembershipChangedSchema = z.object({ membership: OrganizationMemberViewSchema });
export const OrganizationMembershipRemovedSchema = z.object({ removed: z.literal(true) });
export const OrganizationMembershipLeftSchema = z.object({ left: z.literal(true) });
export const OrganizationInviteRevokedSchema = z.object({ revoked: z.literal(true) });

export type OrganizationMemberView = z.output<typeof OrganizationMemberViewSchema>;
export type OrganizationMembershipRoleChange = z.input<typeof OrganizationMembershipRoleChangeSchema>;
export type OrganizationMembershipSnapshot = z.input<typeof OrganizationMembershipSnapshotSchema>;

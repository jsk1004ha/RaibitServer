import { z } from 'zod';
import { MembershipRoleMutationSchema } from './organization-role.ts';

export const OrganizationInviteCreateSchema = z.object({
  email: z.email(),
  role: MembershipRoleMutationSchema,
}).strict();

export const OrganizationInviteAcceptSchema = z.object({
  token: z.string().min(43).max(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const OrganizationInviteViewSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  email: z.email(),
  role: MembershipRoleMutationSchema,
  tokenVersion: z.number().int().positive(),
  invitedByUserId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const OrganizationInviteIssuedSchema = z.object({
  invite: OrganizationInviteViewSchema,
  delivery: z.object({ accepted: z.literal(true) }),
});

export const OrganizationInviteListSchema = z.object({
  invites: z.array(OrganizationInviteViewSchema),
});

export const OrganizationInviteAcceptanceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), membership: z.object({ organizationId: z.string().min(1), role: MembershipRoleMutationSchema }) }),
  z.object({ status: z.literal('already_member') }),
]);

export type OrganizationInviteCreate = z.input<typeof OrganizationInviteCreateSchema>;
export type OrganizationInviteAccept = z.input<typeof OrganizationInviteAcceptSchema>;
export type OrganizationInviteView = z.output<typeof OrganizationInviteViewSchema>;
export type OrganizationInviteAcceptance = z.output<typeof OrganizationInviteAcceptanceSchema>;

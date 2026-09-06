import { z } from 'zod';
import { OrganizationRouteSlugSchema } from './organization-role.ts';

const organizationName = z.string().trim().min(1).max(128).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 256,
  'organization_name_invalid',
);

export const OrganizationCreateRequestSchema = z.object({
  name: organizationName,
  slug: OrganizationRouteSlugSchema,
}).strict();

export const CreatedOrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: OrganizationRouteSlugSchema,
  plan: z.string().min(1),
  createdAt: z.iso.datetime(),
}).catchall(z.unknown());

export const CreatedOrganizationMembershipSchema = z.object({
  id: z.string().min(1).optional(),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  role: z.literal('OWNER'),
  createdAt: z.iso.datetime(),
}).catchall(z.unknown());

export const OrganizationCreatedSchema = z.object({
  organization: CreatedOrganizationSchema,
  membership: CreatedOrganizationMembershipSchema,
  reauthenticationRequired: z.literal(true),
});

export type OrganizationCreateRequest = z.input<typeof OrganizationCreateRequestSchema>;
export type OrganizationCreated = z.output<typeof OrganizationCreatedSchema>;

import { z } from 'zod';
import { DomainStatusSchema, TlsStatusSchema } from './lifecycle.ts';

const timestamp = z.iso.datetime().nullable();

export const DomainCleanupBarrierSchema = z.object({
  version: z.number().int().positive(),
  certificateAbsentObservedVersion: z.number().int().positive().nullable(),
  routeAbsentObservedVersion: z.number().int().positive().nullable(),
  complete: z.boolean(),
}).strict();

export const CustomDomainSchema = z.object({
  id: z.string().min(1), organizationId: z.string().min(1), projectId: z.string().min(1), serviceId: z.string().min(1),
  hostname: z.string().min(3).max(253), status: DomainStatusSchema, verificationVersion: z.number().int().positive(),
  issuedAt: timestamp, expiresAt: timestamp, verifiedAt: timestamp, verificationRequestedAt: timestamp,
  lastCheckedAt: timestamp, nextCheckAt: timestamp, consecutiveFailures: z.number().int().nonnegative(), tlsStatus: TlsStatusSchema,
  desiredGeneration: z.number().int().positive(), controllerLeaseGeneration: z.number().int().nonnegative(),
  certificateObservedGeneration: z.number().int().nonnegative(), routeObservedGeneration: z.number().int().nonnegative(),
  cleanupBarrier: DomainCleanupBarrierSchema.nullable(), deletionRequestedAt: timestamp, actorUserId: z.string().min(1),
  lastErrorCode: z.string().max(100).nullable(), lastErrorMessage: z.string().max(500).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();

export const CustomDomainCreateSchema = z.object({ serviceId: z.string().min(1), hostname: z.string().min(1).max(1_024) }).strict();
export const CustomDomainMutationSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const CustomDomainRotateSchema = CustomDomainMutationSchema.extend({ confirmed: z.literal(true) }).strict();
export const CustomDomainChallengeSchema = z.object({ domain: CustomDomainSchema, challengeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const CustomDomainListSchema = z.object({ domains: z.array(CustomDomainSchema) }).strict();

export type CustomDomain = z.output<typeof CustomDomainSchema>;
export type CustomDomainCreate = z.input<typeof CustomDomainCreateSchema>;
export type CustomDomainMutation = z.input<typeof CustomDomainMutationSchema>;
export type CustomDomainRotate = z.input<typeof CustomDomainRotateSchema>;
export type CustomDomainChallenge = z.output<typeof CustomDomainChallengeSchema>;

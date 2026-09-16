import { z } from 'zod';
import capabilities from './resource-capabilities-v1.json' with { type: 'json' };

export const SupportedResourceEngineSchema = z.enum(capabilities.engines.filter(entry => entry.local.provision).map(entry => entry.engine));
export const ResourceProvisionInputSchema = z.strictObject({ intent: z.enum(['preview-plan', 'live-provision']) });
export const ResourceAvailabilitySchema = z.object({ environment: z.string(), live: z.boolean(), preview: z.boolean(), reasonCode: z.string(), permitted: z.boolean() });
export type ResourceAvailability = z.infer<typeof ResourceAvailabilitySchema>;
export const ResourceProvisionResultSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('preview-plan'), engine: z.string(), provider: z.string(), status: z.literal('PLAN_ONLY'), dryRun: z.literal(true), plan: z.record(z.string(), z.json()) }),
  z.object({ intent: z.literal('live-provision'), engine: z.string(), provider: z.string(), status: z.literal('PROVISIONING'), dryRun: z.literal(false) }),
]);

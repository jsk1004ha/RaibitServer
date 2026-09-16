import { z } from 'zod';

export const OPERATIONAL_PROTOCOL_VERSION = 2 as const;
export const OPERATIONAL_FEATURES = ['templates', 'notifications', 'storage', 'scheduledRecovery', 'environments'] as const;
export const OPERATIONAL_COMPONENTS = ['api', 'operations-worker', 'builder', 'orchestrator', 'provisioner'] as const;
export const OPERATIONAL_EVENTS = [
  'deployment.failed', 'runtime.unhealthy', 'backup.failed', 'promotion.failed',
  'deployment.ready', 'runtime.recovered', 'backup.ready', 'promotion.ready',
] as const;

export const OperationalFeatureSchema = z.enum(OPERATIONAL_FEATURES);
export const OperationalComponentSchema = z.enum(OPERATIONAL_COMPONENTS);
export const OperationalEventSchema = z.enum(OPERATIONAL_EVENTS);
export const OperationalEnvironmentKindSchema = z.enum(['prod', 'dev']);
export const OperationalIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
export const OperationalSlugSchema = z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const OperationalSha256Schema = z.string().regex(/^[a-f0-9]{64}$/).brand('OperationalSha256');
export const OperationalSourceRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/).brand('OperationalSourceRevision');

export const OperationalFeatureStatusFields = {
  protocolSupport: z.literal(true),
  implementationAvailable: z.literal(false),
  liveCapabilityAvailable: z.literal(false),
  productionActivationDefault: z.literal(false),
};

export type OperationalFeature = z.infer<typeof OperationalFeatureSchema>;
export type OperationalEnvironmentKind = z.infer<typeof OperationalEnvironmentKindSchema>;
export type OperationalEvent = z.infer<typeof OperationalEventSchema>;
export type OperationalSha256 = z.infer<typeof OperationalSha256Schema>;
export type OperationalSourceRevision = z.infer<typeof OperationalSourceRevisionSchema>;

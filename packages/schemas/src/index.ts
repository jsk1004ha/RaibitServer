import { z } from 'zod';
export * from './resource-recovery.ts';
export * from './password-recovery.ts';
export * from './project-settings.ts';
export * from './domain.ts';
import { ServiceHealthFields, refineServiceHealth, type DeploymentHealth } from './deployment-health.ts';
export * from './deployment-health.ts';
export * from './deployment-operation.ts';
export * from './preview.ts';
import type { DeploymentStatus } from './lifecycle.ts';
export * from './lifecycle.ts';
import { OrganizationRouteSlugSchema } from './organization-role.ts';
import { SupportedResourceEngineSchema } from './resource-execution.ts';
export * from './resource-execution.ts';

export {
  LEGACY_ORGANIZATION_ROLE_ALIASES,
  MembershipRoleMutationSchema,
  MembershipRoleReadSchema,
  ORGANIZATION_MEMBERSHIP_ROLES,
  OrganizationRouteSlugSchema,
  normalizeOrganizationRoleForRead,
  parseOrganizationMembershipRoleForMutation,
  parseOrganizationRouteSlug,
} from './organization-role.ts';
export type { OrganizationMembershipReadRole, OrganizationMembershipRole, OrganizationRouteSlugResult } from './organization-role.ts';
export * from './api-contract.ts';
export * from './desired-state-mutations.ts';
export * from './service-settings.ts';
export * from './production-evidence.ts';
export * from './organization-invite.ts';

export const AccountTypeSchema = z.enum(['CLUB_MEMBER', 'NON_CLUB']);
export const ApprovalStatusSchema = z.enum(['APPROVED', 'PENDING', 'REJECTED']);
export const UserRoleSchema = z.enum(['ADMIN', 'USER']);
export const MembershipRoleSchema = z.enum(['OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER']);
export const OrganizationTypeSchema = z.enum(['CLUB', 'PERSONAL', 'SCHOOL']);
export const ServiceTypeSchema = z.enum(['web', 'private', 'worker', 'cron', 'job', 'WEB', 'PRIVATE', 'WORKER', 'CRON', 'JOB']).transform((v) => v.toLowerCase() as ServiceType);
export const SourceTypeSchema = z.enum(['github', 'gitlab', 'zip', 'image', 'local', 'GITHUB', 'GITLAB', 'ZIP', 'IMAGE', 'LOCAL']).transform((v) => v.toLowerCase() as SourceType);
export const BuildModeSchema = z.enum(['auto', 'dockerfile', 'buildpack', 'custom', 'prebuilt-image', 'generated', 'framework', 'AUTO', 'DOCKERFILE', 'BUILDPACK', 'CUSTOM', 'PREBUILT_IMAGE', 'GENERATED', 'FRAMEWORK']).transform((v) => v.toLowerCase().replace('_', '-') as BuildMode);
export const ResourceTypeSchema = z.enum(['database', 'cache', 'storage', 'vector', 'queue', 'DATABASE', 'CACHE', 'STORAGE', 'VECTOR', 'QUEUE']).transform((v) => v.toLowerCase() as ResourceType);
export const ResourceEngineSchema = z.enum([
  'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey', 'sqlite', 'object-storage', 'qdrant', 'weaviate', 'milvus', 'nats', 'rabbitmq', 'kafka', 'redpanda', 'vector-db', 'message-queue',
  'POSTGRESQL', 'MYSQL', 'MARIADB', 'MONGODB', 'REDIS', 'VALKEY', 'SQLITE', 'OBJECT_STORAGE', 'QDRANT', 'WEAVIATE', 'MILVUS', 'NATS', 'RABBITMQ', 'KAFKA', 'REDPANDA', 'VECTOR_DB', 'MESSAGE_QUEUE',
]).transform((v) => v.toLowerCase().replaceAll('_', '-') as ResourceEngine);

export const OrganizationCreateSchema = z.object({
  name: z.string().min(1),
  slug: OrganizationRouteSlugSchema.optional(),
  type: OrganizationTypeSchema.optional(),
  plan: z.enum(['free', 'club', 'pro', 'school', 'enterprise']).optional(),
});

export const ServiceCreateSchema = z.object({
  ...ServiceHealthFields,
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  type: ServiceTypeSchema.default('web'),
  sourceType: SourceTypeSchema.default('github'),
  buildMode: BuildModeSchema.optional(),
  repoUrl: z.string().url().or(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional(),
  branch: z.string().optional(),
  rootDirectory: z.string().optional(),
  buildContext: z.string().optional(),
  dockerfilePath: z.string().optional(),
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  outputDirectory: z.string().optional(),
  image: z.string().optional(),
  imageUrl: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
  domain: z.string().optional(),
  schedule: z.string().optional(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  attachedResources: z.array(z.string()).default([]),
  resources: z.object({ requests: z.record(z.string(), z.string()).optional(), limits: z.record(z.string(), z.string()).optional() }).optional(),
  scaling: z.record(z.string(), z.unknown()).optional(),
  desiredSpec: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine(refineServiceHealth);

export const ResourceCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  type: ResourceTypeSchema.default('database'),
  engine: SupportedResourceEngineSchema,
  provider: z.string().default('local'),
  plan: z.string().default('shared-small'),
  region: z.string().default('local'),
  version: z.string().optional(),
  storageGb: z.coerce.number().positive().optional(),
  desiredSpec: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ProjectCreateSchema = z.object({
  organizationId: z.string().optional(),
  organizationSlug: OrganizationRouteSlugSchema.optional(),
  organization: OrganizationCreateSchema.partial().optional(),
  name: z.string().min(1),
  slug: z.string().optional(),
  description: z.string().optional(),
  baseDomain: z.string().optional(),
  registry: z.string().optional(),
  services: z.array(ServiceCreateSchema).default([]),
  resources: z.array(ResourceCreateSchema).default([]),
  currentUsage: z.record(z.string(), z.number()).optional(),
}).passthrough();

export const DeploymentCreateSchema = z.object({
  deploymentType: z.enum(['production', 'preview', 'manual', 'PRODUCTION', 'PREVIEW', 'MANUAL']).default('production'),
  triggerType: z.enum(['manual', 'push', 'pull_request', 'webhook', 'MANUAL', 'PUSH', 'PULL_REQUEST', 'WEBHOOK']).default('manual'),
  branch: z.string().default('main'),
  commitSha: z.string().optional(),
  pullRequestNumber: z.coerce.number().int().positive().optional(),
  imageUrl: z.string().optional(),
});

export const EnvironmentEntrySchema = z.object({ key: z.string().min(1), value: z.string(), isSecret: z.boolean().optional(), source: z.string().optional() });
export const EnvFileUploadSchema = z.object({ filename: z.string().default('.env'), content: z.string() });
export const DbConsoleQuerySchema = z.object({ query: z.string().min(1), confirmed: z.boolean().default(false), role: z.string().optional(), limit: z.coerce.number().int().positive().max(1000).optional() });
export const QuotaUpdateSchema = z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()]));

export type ServiceType = 'web' | 'private' | 'worker' | 'cron' | 'job';
export type SourceType = 'github' | 'gitlab' | 'zip' | 'image' | 'local';
export type BuildMode = 'auto' | 'dockerfile' | 'buildpack' | 'custom' | 'prebuilt-image' | 'generated' | 'framework';
export type ResourceType = 'database' | 'cache' | 'storage' | 'vector' | 'queue';
export type ResourceEngine = 'postgresql' | 'mysql' | 'mariadb' | 'mongodb' | 'redis' | 'valkey' | 'sqlite' | 'object-storage' | 'qdrant' | 'weaviate' | 'milvus' | 'nats' | 'rabbitmq' | 'kafka' | 'redpanda' | 'vector-db' | 'message-queue';

export type OrganizationCreate = z.input<typeof OrganizationCreateSchema>;
export type ServiceSpec = z.input<typeof ServiceCreateSchema> & { id?: string; projectId?: string };
export type ResourceSpec = z.input<typeof ResourceCreateSchema> & { id?: string; projectId?: string };
export type ProjectSpec = z.input<typeof ProjectCreateSchema> & { id?: string };
export type DeploymentRequest = z.input<typeof DeploymentCreateSchema> & { projectId?: string; serviceId?: string };
export interface DeploymentSpec extends DeploymentRequest, Partial<DeploymentHealth> { id?: string; projectId?: string; serviceId: string; status?: DeploymentStatus; imageDigest?: string | null; errorCode?: string | null; errorMessage?: string | null; previewUrl?: string | null; workflowJob?: Record<string, unknown>; readonly sourceDeploymentId?: string | null; readonly retryOfDeploymentId?: string | null; readonly requestIdempotencyKey?: string | null; readonly requestedByUserId?: string | null; readonly snapshotVersion?: number | null; readonly desiredSpecSnapshot?: Readonly<Record<string, unknown>> | null; }
export interface ProjectListResponse { projects: ProjectSpec[]; nextCursor?: string | null; }
export interface ServiceListResponse { services: ServiceSpec[]; nextCursor?: string | null; }
export interface ResourceListResponse { resources: ResourceSpec[]; nextCursor?: string | null; }
export interface DeploymentListResponse { deployments: DeploymentSpec[]; nextCursor?: string | null; }

export interface ApiEnvelope<T> { data?: T; error?: string; }
export interface UserSession { user: Record<string, unknown>; memberships: Array<Record<string, unknown>>; token: string; }

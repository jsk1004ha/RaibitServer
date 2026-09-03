import { z } from 'zod';
import { DeploymentLineageFields } from './deployment-operation.ts';
import { DeploymentStatusSchema } from './lifecycle.ts';
import { ResourceAvailabilitySchema } from './resource-execution.ts';
// Generated package-local mirror; scripts/generate-resource-capabilities.mjs checks canonical byte parity.
import resourceCapabilities from './resource-capabilities-v1.json' with { type: 'json' };
export { ResourceProvisionInputSchema as ResourceProvisionInput, ResourceProvisionResultSchema as ResourceProvisionResult } from './resource-execution.ts';

const id = z.string().min(1);
export const JsonValue = z.json();
const json = JsonValue;
export const Empty = z.object({}).strict();
export const JsonFields = z.record(z.string(), json);
const quotaLimit = z.number().int().min(0).max(2147483647);
const quotaFields = {
  accountType: z.enum(['CLUB_MEMBER', 'NON_CLUB']),
  maxProjects: quotaLimit, maxServices: quotaLimit, maxDeploymentsPerDay: quotaLimit,
  maxPreviewDeployments: quotaLimit, maxCpuMillicores: quotaLimit, maxMemoryMb: quotaLimit,
  maxDbStorageMb: quotaLimit, maxObjectStorageMb: quotaLimit,
  maxBuildMinutesPerMonth: quotaLimit, maxRuntimeHoursPerMonth: quotaLimit,
};
export const QuotaInput = z.strictObject(quotaFields).partial();
export const Quota = z.strictObject({ ...quotaFields, id, userId: id, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const PageQuery = z.object({ limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().max(1024).optional(), after: z.string().max(1024).optional() }).strict();
export const ErrorBody = z.union([
  z.object({ statusCode: z.number().int().min(400).max(599), message: z.union([z.string(), z.array(z.string())]), error: z.string().optional(), code: z.string().optional(), reasonCode: z.string().optional() }),
  z.object({ message: z.string(), plan: JsonFields }),
]);
export const Project = z.object({ id, name: z.string(), organizationId: id, slug: z.string() }).catchall(json);
export const Service = z.object({ id, projectId: id, name: z.string(), type: z.string(), status: z.string().optional() }).catchall(json);
export const Resource = z.object({ id, projectId: id, name: z.string(), engine: z.string(), status: z.string() }).catchall(json);
export const Deployment = z.object({ id, serviceId: id, status: DeploymentStatusSchema, projectId: id.optional(), imageDigest: z.string().nullable().optional(), errorCode: z.string().nullable().optional(), errorMessage: z.string().nullable().optional(), ...DeploymentLineageFields }).catchall(json);
export const DeploymentOperationResult = z.object({ deployment: Deployment, workflowJob: z.object({ id, targetId: id, targetType: z.literal('deployment'), type: z.string(), status: z.string(), payload: JsonFields }).catchall(json) });
export const User = z.object({ id, email: z.string(), name: z.string().nullable().optional(), role: z.string(), approvalStatus: z.string() }).catchall(json);
export const Membership = z.object({ id: id.optional(), userId: id, organizationId: id, role: z.string() }).catchall(json);
export const Session = z.object({ user: User, memberships: z.array(Membership), token: z.string() });
export const EmailVerification = z.object({ status: z.string() }).catchall(json);
export const Signup = z.object({ emailVerification: EmailVerification, signup: z.object({ status: z.literal('verification_requested') }) });
export const Log = z.object({ id, line: z.string(), timestamp: z.string() }).catchall(json);
export const Event = z.object({ id, timestamp: z.string() }).catchall(json);
export const Projects = z.object({ projects: z.array(Project), nextCursor: z.string().nullable() });
export const Services = z.object({ services: z.array(Service), nextCursor: z.string().nullable() });
export const Resources = z.object({ resources: z.array(Resource), nextCursor: z.string().nullable(), resourceOptions: z.array(ResourceAvailabilitySchema.extend({ engine: z.string() })).optional() });
export const Deployments = z.object({ deployments: z.array(Deployment), nextCursor: z.string().nullable() });
export const Logs = z.object({ logs: z.array(Log), nextCursor: z.string().nullable() });
export const Events = z.object({ events: z.array(Event), nextCursor: z.string().nullable() });
export const StreamConfig = z.object({ retryMs: z.number(), heartbeatMs: z.number(), maxLifetimeMs: z.number(), slowClientTimeoutMs: z.number() });
export const ServiceStream = z.object({ service: Service.nullable(), logs: z.array(Log), serviceCursor: z.string(), logCursor: z.string().nullable(), stream: StreamConfig });
export const DeploymentStream = z.object({ deployment: Deployment.nullable(), logs: z.array(Log), events: z.array(Event), deploymentCursor: z.string(), logCursor: z.string().nullable(), eventCursor: z.string().nullable(), stream: StreamConfig });
export const StreamError = z.object({ error: z.string() });
export const Environment = z.object({ serviceId: id, entries: z.array(z.object({ key: z.string(), value: z.string().nullable(), isSecret: z.boolean(), valueMasked: z.string() }).catchall(json)), plainCount: z.number().int(), secretCount: z.number().int() }).catchall(json);
export const ConsoleResult = z.object({ engine: z.string(), rows: z.array(json).optional(), fields: z.array(json).optional(), rowCount: z.number().optional(), mode: z.string().optional(), warning: z.string().optional() }).catchall(json);
export const Integration = z.object({ id, organizationId: id, verifiedAt: z.string().nullable() }).catchall(json);
export const Repository = z.object({ id, name: z.string().optional() }).catchall(json);
export const AgentPlan = z.object({ version: z.literal('v1'), projectId: id, generatedBy: z.enum(['deterministic', 'external-ai']), summary: z.string(), blocked: z.boolean(), canApply: z.boolean(), deploymentOrder: z.array(id), services: z.array(z.object({ serviceId: id, name: z.string(), type: z.string(), eligible: z.boolean(), findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), code: z.string(), message: z.string(), field: z.string().optional() })) })), security: z.object({ highestSeverity: z.enum(['critical', 'high', 'medium', 'low', 'none']), critical: z.number(), high: z.number(), medium: z.number(), low: z.number() }) });
export const AuthInput = z.object({ email: z.email(), password: z.string().min(1) });
export const SignupInput = AuthInput.extend({ password: z.string().min(8), name: z.string().min(1), studentId: z.string().min(1), clubMemberClaim: z.boolean().optional(), organizationSlug: z.string().optional() });
export const ProjectInput = z.object({ name: z.string().min(1), slug: z.string().optional(), organizationId: id.optional(), organizationSlug: z.string().optional(), description: z.string().optional(), services: z.array(JsonFields).optional(), resources: z.array(JsonFields).optional() }).catchall(json);
export const ServiceInput = z.object({ name: z.string().min(1), type: z.enum(['web', 'private', 'worker', 'cron', 'job']).optional(), image: z.string().optional(), sourceType: z.string().optional(), port: z.number().int().positive().optional() }).catchall(json);
export const LocalResourceEngine = z.enum(resourceCapabilities.engines.filter(entry => entry.local.provision).map(entry => entry.engine));
export const ResourceInput = z.object({ name: z.string().min(1), engine: LocalResourceEngine, provider: z.string().optional(), plan: z.string().optional() }).catchall(json);
export const DeploymentInput = z.object({ deploymentType: z.enum(['production', 'preview', 'manual']).optional(), triggerType: z.string().optional(), branch: z.string().optional(), commitSha: z.string().optional(), pullRequestNumber: z.number().int().positive().optional(), imageUrl: z.string().optional() });
export const StatusInput = z.object({ status: DeploymentStatusSchema, imageUrl: z.string().optional(), imageDigest: z.string().optional(), errorCode: z.string().nullable().optional(), errorMessage: z.string().nullable().optional() });
export const Confirmation = z.object({ confirmed: z.literal(true) });
export const AgentInput = z.object({ serviceIds: z.array(id).max(100).optional(), deploymentType: z.enum(['production', 'preview']).optional(), branch: z.string().optional(), commitSha: z.string().optional() });
export const BrowseInput = z.object({ limit: z.number().int().positive().max(1000).optional(), table: z.string().optional(), collection: z.string().optional(), prefix: z.string().optional(), cursor: z.string().optional() });
export const GithubAttach = z.object({ integrationId: id, repositoryId: id, branch: z.string().optional() }).strict();
export const GithubUrl = z.union([z.object({ provider: z.literal('github'), configured: z.literal(true), installUrl: z.url(), mode: z.literal('github-app-install') }), z.object({ provider: z.literal('github'), authorizationUrl: z.url() }).catchall(json)]);
export const Deletion = z.union([z.object({ deleted: z.literal(true) }).catchall(json), z.object({ deletionRequested: z.literal(true), status: z.string() }).catchall(json)]);

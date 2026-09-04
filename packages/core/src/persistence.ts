import { Prisma, type PrismaClient } from '@prisma/client';
import { ResourceRecoveryRepository, type RecoveryQuotaPolicy } from './resource-recovery.ts';
import { MemoryRecoveryTransaction } from './resource-recovery-memory.ts';
import { PostgresRecoveryTransaction, lockRecoveryDeletion, assertPostgresRecoveryPublished } from './resource-recovery-postgres.ts';
import { HEALTH_PATH_FIELDS, INITIAL_DEPLOYMENT_HEALTH, parseHealthPaths, publicDeploymentHealth } from './deployment-health.ts';
import { assertOperationReplay, captureDeploymentSnapshot, deploymentSuccessor, DeploymentOperationError, eligibleDeploymentSource, successorWorkflow, type DeploymentOperation } from './deployment-operations.ts';
import { oauthAuditData, type OAuthAuditEvent } from './oauth-security.ts';
import type { CreateOAuthTransactionInput, ConsumeOAuthTransactionInput, OAuthCleanupInput } from './oauth-transaction.ts';
import { createPrismaOAuthTransaction, consumePrismaOAuthTransaction, deletePrismaOAuthTransactions } from './prisma-oauth-transaction.ts';
import { LIFECYCLE_CONTRACT, terminalLifecycleInputs } from './lifecycle.ts';
import { AUTH_RETENTION_PRUNE_BATCH_SIZE, ControlPlaneStore } from './store.ts';
import { deepClone, stableId } from './ids.ts';
import { maskSecretValue, maskSecrets } from './secrets.ts';
import { openSecret, sealSecret } from './secret-vault.ts';
import { secretEncryptionConfigured } from './config.ts';
import { runDbConsoleQuery, browseDbConsole, resourceConsoleView } from './db-console.ts';
import { buildResourceProviderPlan, publicResourceProviderPlan } from './resource-providers.ts';
import { completeWorkflowJobRecord, failWorkflowJobRecord, processNextWorkflowJob, WORKFLOW_TYPES } from './workflows.ts';
import { canonicalizeProviderDesiredSpec, providerOwnedSqlitePath, resourceNameFallback, sanitizeTenantResourceInput } from './resource-sanitizer.ts';
import { normalizeResourceEngine } from './catalog.ts';
import { assertNoTenantGitHubBinding, redactDbConsoleStatement, sanitizeLogRecord, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate } from './security.ts';
import { parseResourceIntent, requireResourceExecution } from './resource-execution.ts';
import { assertDeploymentTransition, canCancelDeployment, normalizeDeploymentStatus } from './deployments.ts';
import { previewRuntimePlan } from './preview-deployments.ts';
import { parsePreviewObservation, parsePreviewWebhook, PreviewError } from './preview-contract.ts';
import { applyPreviewObservation, assertPreviewRetry, createPreviewRuntime, PREVIEW_APPLY_JOB, PREVIEW_RESOLVER_JOB, previewCloseIntent, resolverJobId, resolverPayload, transitionPreviewLineage, type PreviewLineageRecord } from './preview-lineage.ts';
import { normalizeAccountType } from './identity.ts';
import { membershipRoleTransition, normalizeOrganizationRoleForRead, parseOrganizationMembershipRoleForMutation, parseOrganizationRouteSlug } from './rbac.ts';
import { parseGitHubRepository } from './github-integration.ts';
import { observationLogSource, persistedRuntimePodUid, type ObservationLogContext } from './observability-projection.ts';
import { INTERNAL_SERVICE_MUTATION, assertServiceReplacement, parseProjectMutation, parseResourceMutation, parseServiceMutation, serviceMutationState } from './desired-state-mutations.ts';
import { normalizePublicSiteLimit, publicSitesFromServices, publicSitesFromSnapshot } from './public-sites.ts';
import {
  activityLimit,
  boundedKeysetRows,
  deploymentBuildMinutesWithin,
  deploymentRuntimeHoursWithin,
  isProviderConnectionSecret,
    kubernetesExternalSecretRef,
    providerConnectionFromEnv,
    providerSecretEnvRefs,
  resourceQuotaMetric,
  resourceStorageMb,
  resourceTypeForEngine,
  prismaKeysetFilter,
  serviceCpuMillicores,
  serviceMemoryMb,
  usageMetricSum,
  utcMonthBounds,
} from './store-helpers.ts';

type QuotaRequirement = { metric: string; increment: number };
type ObservationLogRow = Record<string, unknown>;
export type PemContextSource = {
  readonly requestId: number;
  readonly source: string;
  readonly deploymentId: string;
  readonly timestamp: Date;
  readonly id: string;
} & ({
  readonly kind: 'runtime';
  readonly serviceId: string;
  readonly podUid: string;
  readonly containerName: string;
} | {
  readonly kind: 'build';
  readonly step: string;
});
export type RuntimePemContextSource = Extract<PemContextSource, { readonly kind: 'runtime' }>;
type BuildPemContextSource = Extract<PemContextSource, { readonly kind: 'build' }>;
type PemContextQueryRow = { readonly requestId: number; readonly line: string; readonly truncated: boolean };

export const PEM_CONTEXT_LIMITS = {
  sources: 16,
  rowsPerSource: 4,
  lineCharacters: 256,
  lineBytes: 1_024,
  queryRows: 80,
  queryBytes: 81_920,
} as const;

function combineQuotaRequirements(requirements: QuotaRequirement[]) {
  const combined = new Map<string, number>();
  for (const requirement of requirements) {
    if (!requirement?.metric) continue;
    combined.set(requirement.metric, Number(combined.get(requirement.metric) || 0) + Number(requirement.increment || 0));
  }
  return [...combined.entries()]
    .map(([metric, increment]) => ({ metric, increment }))
    .filter((requirement) => Number.isFinite(requirement.increment) && requirement.increment > 0);
}

function serviceQuotaRequirements(existing: Record<string, any> | null | undefined, requested: Record<string, any>): QuotaRequirement[] {
  return [
    { metric: 'maxServices', increment: existing ? 0 : 1 },
    { metric: 'maxCpuMillicores', increment: serviceCpuMillicores(requested) - serviceCpuMillicores(existing || {}) },
    { metric: 'maxMemoryMb', increment: serviceMemoryMb(requested) - serviceMemoryMb(existing || {}) },
  ];
}

function resourceQuotaRequirements(existing: Record<string, any> | null | undefined, requested: Record<string, any>): QuotaRequirement[] {
  const requestedMetric = resourceQuotaMetric(requested);
  const requestedStorage = resourceStorageMb(requested, { includeDesiredState: true });
  if (!existing) return [{ metric: requestedMetric, increment: requestedStorage }];
  const existingMetric = resourceQuotaMetric(existing);
  const existingStorage = resourceStorageMb(existing, { includeDesiredState: true });
  if (existingMetric === requestedMetric) return [{ metric: requestedMetric, increment: requestedStorage - existingStorage }];
  return [
    { metric: existingMetric, increment: -existingStorage },
    { metric: requestedMetric, increment: requestedStorage },
  ];
}

function deploymentQuotaRequirements(deploymentType: any): QuotaRequirement[] {
  return [
    { metric: 'maxDeploymentsPerDay', increment: 1 },
    ...(String(deploymentType || 'production').toLowerCase() === 'preview' ? [{ metric: 'maxPreviewDeployments', increment: 1 }] : []),
  ];
}

function snapshotInMemoryStore(store: ControlPlaneStore) {
  const snapshot: Record<string, any> = {};
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === 'function') continue;
    snapshot[key] = value instanceof Map
      ? new Map([...value.entries()].map(([entryKey, entryValue]) => [entryKey, deepClone(entryValue)]))
      : deepClone(value);
  }
  return snapshot;
}

function restoreInMemoryStore(store: ControlPlaneStore, snapshot: Record<string, any>) {
  for (const [key, value] of Object.entries(snapshot)) (store as any)[key] = value;
}

export class InMemoryControlPlaneRepository {
  resourceRecovery(enforceQuota: RecoveryQuotaPolicy) { return new ResourceRecoveryRepository(new MemoryRecoveryTransaction(this.store.recoveryState, this.store), enforceQuota); }
  store: ControlPlaneStore;

  constructor(store = new ControlPlaneStore()) {
    this.store = store;
  }

  async createOrganization(input: Record<string, any>) { return this.store.createOrganization(input); }
  async findOrganizationBySlug(slug: string) { return this.store.findOrganizationBySlug(slug); }
  async createUser(input: Record<string, any>) { return this.store.createUser(input); }
  async findUserByEmail(email: string) { return this.store.findUserByEmail(email); }
  async countUsers(limit = 1) { return this.store.countUsers(limit); }
  async findUserById(userId: string) { return this.store.findUserById(userId); }
  async incrementSessionVersion(userId: string) { return this.store.incrementSessionVersion(userId); }
  async createOAuthTransaction(input: CreateOAuthTransactionInput) { return this.store.createOAuthTransaction(input); }
  async consumeOAuthTransaction(input: ConsumeOAuthTransactionInput) { return this.store.consumeOAuthTransaction(input); }
  async deleteExpiredOAuthTransactions(input: OAuthCleanupInput = {}) { return this.store.deleteExpiredOAuthTransactions(input); }
  async recordOAuthAudit(event: OAuthAuditEvent) { return this.store.recordOAuthAudit(event); }
  async consumeAuthRateLimit(input: Record<string, any>) { return this.store.consumeAuthRateLimit(input); }
  async peekAuthRateLimit(input: Record<string, any>) { return this.store.peekAuthRateLimit(input); }
  async resetAuthRateLimit(key: string) { return this.store.resetAuthRateLimit(key); }
  async createEmailVerificationCode(input: Record<string, any>) { return this.store.createEmailVerificationCode(input); }
  async replaceEmailVerificationCode(input: Record<string, any>) { return this.store.replaceEmailVerificationCode(input); }
  async invalidatePendingEmailVerificationCodes(email: string) { return this.store.invalidatePendingEmailVerificationCodes(email); }
  async findPendingEmailVerificationCode(email: string, purpose?: string) { return this.store.findPendingEmailVerificationCode(email, purpose); }
  async incrementEmailVerificationAttempts(id: string) { return this.store.incrementEmailVerificationAttempts(id); }
  async consumeEmailVerificationCode(id: string, consumedAt?: string) { return this.store.consumeEmailVerificationCode(id, consumedAt); }
  async completeSignupEmailVerification(input: Record<string, any>) { return this.store.completeSignupEmailVerification(input); }
  async markUserEmailVerified(userId: string, verifiedAt?: string) { return this.store.markUserEmailVerified(userId, verifiedAt); }
  async recordEmailDelivery(input: Record<string, any>) { return this.store.recordEmailDelivery(input); }
  async findUserByGitHubId(githubId: string) { return this.store.findUserByGitHubId(githubId); }
  async linkGitHubUser(userId: string, input: Record<string, any> = {}) { return this.store.linkGitHubUser(userId, input); }
  async addMember(input: Record<string, any>) { return this.store.addMember(input); }
  async removeMember(input: Record<string, any>) { return this.store.removeMember(input); }
  async listMembershipsForUser(userId: string) { return this.store.listMembershipsForUser(userId); }
  async createProject(input: Record<string, any>) {
    const slug = slugInput(input.slug || input.name);
    const existing = [...this.store.projects.values()].find((project) => String(project.organizationId) === String(input.organizationId) && String(project.slug) === slug);
    return this.runQuotaMutation(input.actorUserId, 'project:create', [{ metric: 'maxProjects', increment: existing ? 0 : 1 }], () => this.store.createProject({ ...input, status: input.actorUserId ? 'ACTIVE' : input.status }));
  }
  async updateProject(projectId: string, updates: Record<string, any>) { return this.store.updateProject(projectId, updates); }
  async deleteProject(projectId: string) { return this.store.deleteProject(projectId); }
  async createService(input: Record<string, any>, options: Record<string, any> = {}) {
    const slug = slugInput(input.slug || input.name);
    const existing = [...this.store.services.values()].find((service) => String(service.projectId) === String(input.projectId) && String(service.slug) === slug);
    return this.runQuotaMutation(input.actorUserId, 'service:create', serviceQuotaRequirements(existing, input), () => this.store.createService(input, options));
  }
  async updateService(serviceId: string, updates: Record<string, any>, options: Record<string, any> = {}) { return this.store.updateService(serviceId, updates, options); }
  async deleteService(serviceId: string) { return this.store.deleteService(serviceId); }
  async createResource(input: Record<string, any>) {
    requireResourceExecution(normalizeResourceEngine(input.engine || input.type));
    const existing = [...this.store.resources.values()].find((resource) => String(resource.projectId) === String(input.projectId) && String(resource.name) === String(input.name));
    return this.runQuotaMutation(input.actorUserId, 'resource:create', resourceQuotaRequirements(existing, input), () => this.store.createResource(input));
  }
  async updateResource(resourceId: string, updates: Record<string, any>) { return this.store.updateResource(resourceId, updates); }
  async deleteResource(resourceId: string) { return this.store.deleteResource(resourceId); }
  async attachProviderConnectionSecret(input: Record<string, any>) { return this.store.attachProviderConnectionSecret(input); }
  async attachProviderConnectionSecrets(input: Record<string, any>) { return this.store.attachProviderConnectionSecrets(input); }
  async provisionResourceProvider(input: Record<string, any>) { return this.store.provisionResourceProvider(input); }
  async createDeployment(input: Record<string, any>) { return this.store.createDeployment(input); }
  async updateDeployment(deploymentId: string, updates: Record<string, any>, options: Record<string, any> = {}) { return this.store.updateDeployment(deploymentId, updates, options); }
  async transitionDeployment(deploymentId: string, status: string, updates: Record<string, any> = {}, options: Record<string, any> = {}) { return this.store.transitionDeployment(deploymentId, status, updates, options); }
  async cancelDeployment(deploymentId: string, input: Record<string, any> = {}) {
    return this.runQuotaMutation(null, 'deployment:cancel', [], () => this.store.cancelDeployment(deploymentId, input));
  }
  async rollbackDeployment(deploymentId: string, input: Record<string, any> = {}) {
    const deployment = this.store.deployments.get(deploymentId);
    return this.runQuotaMutation(input.actorUserId, 'deployment:create', deploymentQuotaRequirements(deployment?.deploymentType), () => this.store.rollbackDeployment(deploymentId, input));
  }
  async requestPreviewCleanup(deploymentId: string, input: Record<string, any> = {}) { return this.store.requestPreviewCleanup(deploymentId, input); }
  async createSecret(input: Record<string, any>) { return this.store.createSecret(input); }
  async createDeploymentOperation(input: DeploymentOperation) {
    const service = this.store.services.get(input.serviceId);
    if (!service) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
    const existing = [...this.store.deployments.values()].find(row => row.serviceId === input.serviceId && row.requestIdempotencyKey === input.requestIdempotencyKey);
    if (existing) {
      const workflowJob = [...this.store.workflowJobs.values()].find(row => row.targetId === existing.id && row.targetType === 'deployment');
      if (!workflowJob) throw new DeploymentOperationError('LINEAGE_JOB_MISSING');
      assertOperationReplay(input, workflowJob.payload);
      return deepClone({ deployment: existing, workflowJob, operationId: workflowJob.id, status: existing.status, streamHref: `/deployments/${existing.id}/stream` });
    }
    const rows = [...this.store.deployments.values()].filter(row => row.serviceId === input.serviceId);
    const source = input.operation === 'retry' ? this.store.deployments.get(input.sourceDeploymentId || '') : rows.filter(eligibleDeploymentSource).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id))[0];
    const candidate = deploymentSuccessor(source || null, input);
    if (rows.some(row => !terminalDeploymentStatuses.includes(row.status))) throw new DeploymentOperationError('ACTIVE_DEPLOYMENT');
    assertMutable(service, 'service');
    const project = this.store.projects.get(service.projectId);
    if (!project) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
    assertMutable(project, 'project');
    return this.runQuotaMutation(input.requestedByUserId === 'system' ? null : input.requestedByUserId, 'deployment:create', deploymentQuotaRequirements(candidate.deploymentType), () => {
      const deployment = this.store.createDeployment(candidate);
      const workflowJob = this.store.enqueueWorkflowJob(successorWorkflow(candidate, input));
      return { deployment, workflowJob, operationId: workflowJob.id, status: deployment.status, streamHref: `/deployments/${deployment.id}/stream` };
    });
  }
  async createDeploymentWorkflow(input: Record<string, any>) {
    const requestedDeployment = input.deployment || input;
    return this.runQuotaMutation(input.actorUserId || requestedDeployment.actorUserId, 'deployment:create', deploymentQuotaRequirements(requestedDeployment.deploymentType), () => {
      const deployment = this.store.createDeployment(requestedDeployment);
      const workflowJob = this.store.enqueueWorkflowJob({
        type: input.workflow?.type || 'build-and-deploy',
        targetType: 'deployment',
        targetId: deployment.id,
        payload: { ...(input.workflow?.payload || {}), deploymentId: deployment.id },
      });
      return { deployment, workflowJob };
    });
  }
  async getProject(projectId: string) { return this.store.getProject(projectId); }
  async getService(serviceId: string) { return deepClone(this.store.services.get(serviceId) || null); }
  async getResource(resourceId: string) { return deepClone(this.store.resources.get(resourceId) || null); }
  async getDeployment(deploymentId: string) { return this.store.getDeployment(deploymentId); }
  async listProjectsForOrganizations(organizationIds?: string[], options: Record<string, any> = {}) {
    const allowed = organizationIds ? new Set(organizationIds.map(String)) : null;
    const projects = boundedKeysetRows([...this.store.projects.values()].filter((project) => !allowed || allowed.has(String(project.organizationId))), options);
    const projectIds = new Set(projects.map((project) => String(project.id)));
    const serviceCounts = countRowsByProject(this.store.services.values(), projectIds);
    const resourceCounts = countRowsByProject(this.store.resources.values(), projectIds);
    return deepClone(projects.map((project) => ({
      ...project,
      serviceCount: serviceCounts.get(String(project.id)) || 0,
      resourceCount: resourceCounts.get(String(project.id)) || 0,
    })));
  }
  async listPublicSites(limit: unknown = 5) { return publicSitesFromSnapshot(this.store.snapshot(), limit); }
  async listUsers() { return deepClone([...this.store.users.values()].map(redactUser)); }
  async getQuotaForUser(userId: string) { return deepClone([...this.store.quotas.values()].find((row) => String(row.userId) === String(userId)) || null); }
  async listUsageRecordsForUser(userId: string, options: Record<string, any> = {}) {
    const month = utcMonthBounds(options.now);
    return deepClone(this.store.usageRecords
      .filter((row) => String(row.userId) === String(userId) && Number(new Date(row.recordedAt)) >= month.start && Number(new Date(row.recordedAt)) < month.end)
      .sort((left, right) => Number(new Date(right.recordedAt)) - Number(new Date(left.recordedAt)))
      .slice(0, activityLimit(options.limit)));
  }
  async adminOverview(options: Record<string, any> = {}) {
    const limit = activityLimit(options.limit);
    const users = [...this.store.users.values()].map(redactUser).slice(-limit);
    const userIds = new Set(users.map((user) => String(user.id)));
    const quotas = [...this.store.quotas.values()].filter((quota) => userIds.has(String(quota.userId)));
    const auditLogs = this.store.auditLogs.slice(-limit).reverse();
    return deepClone({ users, quotas, auditLogs });
  }
  async listServicesForProject(projectId: string, options: Record<string, any> = {}) { return deepClone(boundedKeysetRows([...this.store.services.values()].filter((service) => String(service.projectId) === String(projectId)), options)); }
  async listResourcesForProject(projectId: string, options: Record<string, any> = {}) { return deepClone(boundedKeysetRows([...this.store.resources.values()].filter((resource) => String(resource.projectId) === String(projectId)), options)); }
  async listDeploymentsForService(serviceId: string, options: Record<string, any> = {}) { return deepClone(boundedKeysetRows([...this.store.deployments.values()].filter((deployment) => String(deployment.serviceId) === String(serviceId)), options)).map(publicDeploymentHealth); }
  async listDeploymentsForProject(projectId: string, options: Record<string, any> = {}) {
    return deepClone(boundedKeysetRows([...this.store.deployments.values()]
      .filter((deployment) => String(deployment.projectId) === String(projectId)), options)).map(publicDeploymentHealth);
  }
  async upsertServiceEnvironment(input: Record<string, any>) { return this.store.upsertServiceEnvironment(input); }
  async importServiceEnvFile(input: Record<string, any>) { return this.store.importServiceEnvFile(input); }
  async listServiceEnvironment(input: Record<string, any>) { return this.store.listServiceEnvironment(input); }
  async createGitHubIntegration(input: Record<string, any>) { return this.store.createGitHubIntegration(input); }
  async verifyGitHubIntegration(input: Record<string, any>) { return this.store.verifyGitHubIntegration(input); }
  async registerGitHubRepository(input: Record<string, any>) { return this.store.registerGitHubRepository(input); }
  async listGitHubIntegrations(input: Record<string, any>) { return this.store.listGitHubIntegrations(input); }
  async attachGitHubRepositoryToService(input: Record<string, any>) { return this.store.attachGitHubRepositoryToService(input); }
  async listGitHubInstallations(input: Record<string, any>) { return this.store.listGitHubInstallations(input); }
  async listGitHubInstallationRepositories(input: Record<string, any>) { return this.store.listGitHubInstallationRepositories(input); }
  async importGitHubRepository(input: Record<string, any>) {
    const repository = [...this.store.githubRepositories.values()].find((candidate) => String(candidate.githubRepoId) === String(input.repositoryId)
      || normalizePrismaRepositoryId(candidate.fullName) === normalizePrismaRepositoryId(input.repoUrl || input.repository || ''));
    const serviceName = input.serviceName || repository?.repo || String(repository?.fullName || input.repository || '').split('/').pop() || 'web';
    const existing = [...this.store.services.values()].find((service) => String(service.projectId) === String(input.projectId) && String(service.slug) === slugInput(serviceName));
    return this.runQuotaMutation(input.actorUserId, 'service:create', serviceQuotaRequirements(existing, { ...input, name: serviceName }), () => this.store.importGitHubRepository(input));
  }
  async listServicesForGitHubRepository(repository: any, scope: Record<string, any> = {}) { return deepClone(this.store.servicesForGitHubRepository(repository, scope)); }
  async syncGitHubRepository(input: Record<string, any>) { return this.store.syncGitHubRepository(input); }
  async handleGitHubWebhook(input: Record<string, any>) { return this.store.handleGitHubWebhook(input); }
  async enqueueWorkflowJob(input: Record<string, any>) { return this.store.enqueueWorkflowJob(input); }
  async claimNextWorkflowJob(input: Record<string, any> = {}) { return this.store.claimNextWorkflowJob(input); }
  async completeWorkflowJob(jobId: string, result: any = {}, options: Record<string, any> = {}) { return this.store.completeWorkflowJob(jobId, result, options); }
  async failWorkflowJob(jobId: string, error: any, options: Record<string, any> = {}) { return this.store.failWorkflowJob(jobId, error, options); }
  async processNextWorkflowJob(handlers: Record<string, any>, options: Record<string, any> = {}) { return this.store.processNextWorkflowJob(handlers, options); }
  async approveUser(userId: string, input: Record<string, any> = {}) { return this.store.approveUser(userId, input); }
  async rejectUser(userId: string, input: Record<string, any> = {}) { return this.store.rejectUser(userId, input); }
  async banUser(userId: string, input: Record<string, any> = {}) { return this.store.banUser(userId, input); }
  async unbanUser(userId: string, input: Record<string, any> = {}) { return this.store.unbanUser(userId, input); }
  async setQuota(input: Record<string, any>) { return this.store.setQuota(input); }
  async enforceUserCan(input: Record<string, any>) { return this.store.enforceUserCan(input); }
  async writeDesiredProject(projectSpec: Record<string, any>) {
    for (const resource of projectSpec.resources || []) requireResourceExecution(normalizeResourceEngine(resource.engine || resource.type));
    const orgInput = projectSpec.organization || null;
    if (Object.hasOwn(projectSpec, 'organizationSlug')) validatedOrganizationRouteSlug(projectSpec.organizationSlug);
    if (orgInput && Object.hasOwn(orgInput, 'slug')) validatedOrganizationRouteSlug(orgInput.slug);
    const requestedOrganizationId = projectSpec.organizationId || projectSpec.orgId || null;
    const existingOrganization = (requestedOrganizationId ? this.store.organizations.get(String(requestedOrganizationId)) : null)
      || [...this.store.organizations.values()].find((organization) => String(organization.slug) === slugInput(projectSpec.organizationSlug || orgInput?.slug || orgInput?.name || requestedOrganizationId || ''));
    const organizationId = String(existingOrganization?.id || requestedOrganizationId || stableId('org', orgInput?.slug || orgInput?.name || projectSpec.organizationSlug || 'default'));
    const projectInput = projectSpec.project || { name: projectSpec.name || projectSpec.slug || 'project', slug: projectSpec.slug || projectSpec.name || 'project', description: projectSpec.description || '' };
    const projectSlug = slugInput(projectInput.slug || projectInput.name);
    const existingProject = [...this.store.projects.values()].find((project) => String(project.organizationId) === organizationId && String(project.slug) === projectSlug);
    const requirements: QuotaRequirement[] = [{ metric: 'maxProjects', increment: existingProject ? 0 : 1 }];
    for (const service of projectSpec.services || []) {
      const existingService = existingProject
        ? [...this.store.services.values()].find((candidate) => String(candidate.projectId) === String(existingProject.id) && String(candidate.slug) === slugInput(service.slug || service.name))
        : null;
      assertServiceReplacement(Boolean(existingService && [...this.store.deployments.values()].some((deployment) => deployment.serviceId === existingService.id)));
      requirements.push(...serviceQuotaRequirements(existingService, service));
    }
    for (const resource of projectSpec.resources || []) {
      const existingResource = existingProject
        ? [...this.store.resources.values()].find((candidate) => String(candidate.projectId) === String(existingProject.id) && String(candidate.name) === String(resource.name))
        : null;
      requirements.push(...resourceQuotaRequirements(existingResource, resource));
    }
    return this.runQuotaMutation(projectSpec.actorUserId, 'desired-state:write', requirements, () => {
      const organization = existingOrganization || this.store.createOrganization({
        name: orgInput?.name || projectSpec.organizationSlug || requestedOrganizationId || 'Organization',
        slug: orgInput?.slug || projectSpec.organizationSlug || requestedOrganizationId || 'organization',
        plan: orgInput?.plan || 'free',
      });
      const project = this.store.createProject({
        organizationId: organization.id,
        name: projectInput.name || projectSlug,
        slug: projectSlug,
        description: projectInput.description || '',
        status: projectSpec.actorUserId ? 'ACTIVE' : (projectInput.status || 'ACTIVE'),
      });
      const services = (projectSpec.services || []).map((service: Record<string, any>) => this.store.createService({ ...service, projectId: project.id }));
      const resources = (projectSpec.resources || []).map((resource: Record<string, any>) => this.store.createResource({ ...resource, projectId: project.id }));
      this.store.audit(projectSpec.actorUserId || 'system', 'desired-state:write', 'project', project.id, maskSecrets(projectSpec));
      return { organization, project, services, resources };
    });
  }
  async attachResource(input: Record<string, any>) { return this.store.attachResource(input); }
  async appendBuildLog(input: Record<string, any>) { return this.store.appendBuildLog(input); }
  async appendRuntimeLog(input: Record<string, any>) { return this.store.appendRuntimeLog(input); }
  async appendDeploymentEvent(input: Record<string, any>) { return this.store.appendDeploymentEvent(input); }
  async listDeploymentLogs(deploymentId: string, options: Record<string, any> = {}) { return this.store.listDeploymentLogs(deploymentId, options); }
  async listRuntimeLogs(serviceId: string, options: Record<string, any> = {}) { return this.store.listRuntimeLogs(serviceId, options); }
  async logPemContext(rows: readonly ObservationLogRow[]) { return this.store.logPemContext(rows); }
  async listDeploymentEvents(deploymentId: string, options: Record<string, any> = {}) { return this.store.listDeploymentEvents(deploymentId, options); }
  async runResourceConsoleQuery(resourceId: string, query: string, options: Record<string, any> = {}) { return this.store.runResourceConsoleQuery(resourceId, query, options); }
  async runResourceConsoleCommand(resourceId: string, command: string, options: Record<string, any> = {}) { return this.store.runResourceConsoleCommand(resourceId, command, options); }
  async browseResourceConsole(resourceId: string, options: Record<string, any> = {}) { return this.store.browseResourceConsole(resourceId, options); }
  async resourceConsoleView(resourceId: string, view: string, options: Record<string, any> = {}) { return this.store.resourceConsoleView(resourceId, view, options); }
  async snapshot() { return this.store.snapshot(); }

  private runQuotaMutation<T>(actorUserId: any, action: string, requirements: QuotaRequirement[], mutation: () => T): T {
    if (actorUserId) {
      for (const requirement of combineQuotaRequirements(requirements)) {
        this.store.enforceUserCan({ userId: actorUserId, action, metric: requirement.metric, increment: requirement.increment });
      }
    }
    const before = snapshotInMemoryStore(this.store);
    try {
      return mutation();
    } catch (error) {
      restoreInMemoryStore(this.store, before);
      throw error;
    }
  }
}

export class PrismaControlPlaneRepository {
  resourceRecovery(enforceQuota: RecoveryQuotaPolicy) { return new ResourceRecoveryRepository(new PostgresRecoveryTransaction(this.prisma), enforceQuota); }
  readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  static async connect(options: Record<string, any> = {}) {
    const moduleName = options.clientModule || '@prisma/client';
    const imported = await import(moduleName);
    const PrismaClient = imported.PrismaClient;
    const prisma = new PrismaClient(prismaClientOptions(options.prismaOptions || {}, options.env || process.env));
    if (options.connect !== false) await prisma.$connect();
    return new PrismaControlPlaneRepository(prisma);
  }

  async disconnect() {
    if (this.prisma?.$disconnect) await this.prisma.$disconnect();
  }

  async createOrganization(input: Record<string, any>) {
    const slug = organizationSlugForCreate(input);
    return this.prisma.organization.upsert({
      where: { slug },
      update: { name: input.name, plan: input.plan || 'free' },
      create: { name: input.name, slug, plan: input.plan || 'free' },
    });
  }

  async findOrganizationBySlug(slug: string) {
    return this.prisma.organization.findUnique({ where: { slug: slugInput(slug) } });
  }

  async createUser(input: Record<string, any>) {
    const accountType = normalizeAccountType(input.accountType);
    const emailVerifiedAt = input.emailVerifiedAt === undefined ? new Date() : input.emailVerifiedAt;
    const user = await this.prisma.user.upsert({
      where: { email: input.email },
      update: {
        name: input.name,
        studentId: input.studentId === undefined ? undefined : String(input.studentId),
        clubMemberClaim: input.clubMemberClaim === undefined ? undefined : Boolean(input.clubMemberClaim),
        avatarUrl: input.avatarUrl || null,
        githubId: input.githubId || null,
        passwordHash: input.passwordHash || undefined,
        sessionVersion: input.passwordHash ? { increment: 1 } : undefined,
        role: input.role || undefined,
        accountType,
        approvalStatus: input.approvalStatus || undefined,
        emailVerifiedAt: input.emailVerifiedAt === undefined ? undefined : input.emailVerifiedAt,
      },
      create: {
        name: input.name,
        studentId: input.studentId || '',
        clubMemberClaim: Boolean(input.clubMemberClaim),
        email: input.email,
        avatarUrl: input.avatarUrl || null,
        githubId: input.githubId || null,
        passwordHash: input.passwordHash || null,
        sessionVersion: 0,
        role: input.role || 'USER',
        accountType,
        approvalStatus: input.approvalStatus || 'PENDING',
        emailVerifiedAt,
      },
    });
    return redactUser(user);
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email: String(email || '').toLowerCase() } });
  }

  async countUsers(limit = 1) {
    const requestedLimit = Math.floor(Number(limit));
    const boundedLimit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 1;
    return this.prisma.user.count({ take: boundedLimit });
  }

  async findUserById(userId: string) {
    return this.prisma.user.findUnique({ where: { id: String(userId) } });
  }

  async incrementSessionVersion(userId: string) {
    const user = await this.prisma.user.update({ where: { id: String(userId) }, data: { sessionVersion: { increment: 1 } } });
    return redactUser(user);
  }

  async createOAuthTransaction(input: CreateOAuthTransactionInput) { return createPrismaOAuthTransaction(this.prisma, input); }
  async consumeOAuthTransaction(input: ConsumeOAuthTransactionInput) { return consumePrismaOAuthTransaction(this.prisma, input); }
  async deleteExpiredOAuthTransactions(input: OAuthCleanupInput = {}) { return deletePrismaOAuthTransactions(this.prisma, input); }
  async recordOAuthAudit(event: OAuthAuditEvent) { return this.prisma.auditLog.create({ data: oauthAuditData(event) }); }

  async consumeAuthRateLimit(input: Record<string, any>) {
    const key = String(input.key || 'global');
    const limit = Math.max(1, Number(input.limit || 10));
    const windowMs = Math.max(1_000, Number(input.windowMs || 60_000));
    const now = new Date(input.now === undefined ? Date.now() : Number(input.now));
    const expiresAt = new Date(now.getTime() + windowMs);
    const rows = await this.prisma.$queryRawUnsafe(
      `WITH "expired" AS MATERIALIZED (
         SELECT "key"
         FROM "AuthRateLimit"
         WHERE "expiresAt" <= $2 AND "key" <> $1
         ORDER BY "expiresAt", "key"
         LIMIT $4
       ), "pruned" AS (
         DELETE FROM "AuthRateLimit" AS "target"
         USING "expired"
         WHERE "target"."key" = "expired"."key"
       ), "upserted" AS (
         INSERT INTO "AuthRateLimit" ("key", "count", "windowStartedAt", "expiresAt", "updatedAt")
         VALUES ($1, 1, $2, $3, $2)
         ON CONFLICT ("key") DO UPDATE SET
           "count" = CASE WHEN "AuthRateLimit"."expiresAt" <= EXCLUDED."windowStartedAt" THEN 1 ELSE "AuthRateLimit"."count" + 1 END,
           "windowStartedAt" = CASE WHEN "AuthRateLimit"."expiresAt" <= EXCLUDED."windowStartedAt" THEN EXCLUDED."windowStartedAt" ELSE "AuthRateLimit"."windowStartedAt" END,
           "expiresAt" = CASE WHEN "AuthRateLimit"."expiresAt" <= EXCLUDED."windowStartedAt" THEN EXCLUDED."expiresAt" ELSE "AuthRateLimit"."expiresAt" END,
           "updatedAt" = EXCLUDED."updatedAt"
         WHERE "AuthRateLimit"."expiresAt" <= EXCLUDED."windowStartedAt" OR "AuthRateLimit"."count" < $5
         RETURNING TRUE AS "allowed", "count", "expiresAt"
       )
       SELECT "allowed", "count", "expiresAt" FROM "upserted"
       UNION ALL
       SELECT FALSE AS "allowed", "current"."count", "current"."expiresAt"
       FROM "AuthRateLimit" AS "current"
       WHERE "current"."key" = $1 AND NOT EXISTS (SELECT 1 FROM "upserted")
       LIMIT 1`,
      key,
      now,
      expiresAt,
      AUTH_RETENTION_PRUNE_BATCH_SIZE,
      limit,
    );
    const row = rows[0];
    const count = Number(row?.count ?? limit);
    const resetAt = new Date(row?.expiresAt || expiresAt).getTime();
    const allowed = row ? row.allowed !== false : false;
    return { allowed, count, remaining: Math.max(0, limit - count), resetAt };
  }

  async peekAuthRateLimit(input: Record<string, any>) {
    const key = String(input.key || 'global');
    const limit = Math.max(1, Number(input.limit || 10));
    const now = new Date(input.now === undefined ? Date.now() : Number(input.now));
    const row = await this.prisma.authRateLimit.findUnique({ where: { key } });
    if (!row || new Date(row.expiresAt).getTime() <= now.getTime()) {
      return { allowed: true, count: 0, remaining: limit, resetAt: now.getTime() };
    }
    const count = Number(row.count || 0);
    return {
      allowed: count < limit,
      count,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(row.expiresAt).getTime(),
    };
  }

  async resetAuthRateLimit(key: string) {
    return this.prisma.authRateLimit.deleteMany({ where: { key: String(key || 'global') } });
  }

  async createEmailVerificationCode(input: Record<string, any>) {
    return this.prisma.emailVerificationCode.create({
      data: {
        userId: input.userId || null,
        email: String(input.email || '').toLowerCase(),
        purpose: input.purpose || 'signup',
        payload: input.payload || undefined,
        codeHash: input.codeHash,
        codeSalt: input.codeSalt,
        expiresAt: new Date(input.expiresAt),
        sentAt: input.sentAt ? new Date(input.sentAt) : new Date(),
        attempts: Number(input.attempts || 0),
      },
    });
  }

  async replaceEmailVerificationCode(input: Record<string, any>) {
    const now = new Date();
    const data = {
      userId: input.userId || null,
      email: String(input.email || '').toLowerCase(),
      purpose: input.purpose || 'signup',
      payload: input.payload || undefined,
      codeHash: input.codeHash,
      codeSalt: input.codeSalt,
      expiresAt: new Date(input.expiresAt),
      sentAt: input.sentAt ? new Date(input.sentAt) : new Date(),
      attempts: Number(input.attempts || 0),
    };
    return this.prisma.$transaction(async (transaction: any) => {
      await transaction.$queryRawUnsafe(
        `WITH "expired" AS MATERIALIZED (
           SELECT "id"
           FROM "EmailVerificationCode"
           WHERE "expiresAt" <= $2
           ORDER BY "expiresAt", "id"
           LIMIT $3
         ), "pruned" AS (
           DELETE FROM "EmailVerificationCode" AS "target"
           USING "expired"
           WHERE "target"."id" = "expired"."id"
         )
         SELECT 1::int AS "locked"
         FROM pg_advisory_xact_lock(hashtextextended($1, 0))`,
        JSON.stringify([data.email, data.purpose]),
        now,
        AUTH_RETENTION_PRUNE_BATCH_SIZE,
      );
      await transaction.emailVerificationCode.updateMany({
        where: { email: data.email, purpose: data.purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return transaction.emailVerificationCode.create({ data });
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async invalidatePendingEmailVerificationCodes(email: string) {
    return this.prisma.emailVerificationCode.updateMany({
      where: { email: String(email || '').toLowerCase(), consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  async findPendingEmailVerificationCode(email: string, purpose = 'signup') {
    return this.prisma.emailVerificationCode.findFirst({
      where: { email: String(email || '').toLowerCase(), purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async incrementEmailVerificationAttempts(id: string) {
    return this.prisma.emailVerificationCode.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  async consumeEmailVerificationCode(id: string, consumedAt = new Date().toISOString()) {
    return this.prisma.emailVerificationCode.update({
      where: { id },
      data: { consumedAt: new Date(consumedAt) },
    });
  }

  async completeSignupEmailVerification(input: Record<string, any>) {
    const email = String(input.email || '').trim().toLowerCase();
    const purpose = String(input.purpose || 'signup');
    const maxAttempts = Math.max(1, Number(input.maxAttempts || 5));
    const now = new Date(input.now === undefined ? Date.now() : Number(input.now));
    try {
      return await this.prisma.$transaction(async (transaction: any) => {
        const record = await transaction.emailVerificationCode.findFirst({
          where: { email, purpose, consumedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        if (!record || new Date(record.expiresAt).getTime() <= now.getTime() || Number(record.attempts || 0) >= maxAttempts) {
          return { status: 'invalid' };
        }
        const valid = typeof input.verifyCode === 'function' && input.verifyCode(record) === true;
        if (!valid) {
          await transaction.emailVerificationCode.updateMany({
            where: { id: record.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: maxAttempts } },
            data: { attempts: { increment: 1 } },
          });
          return { status: 'invalid' };
        }
        const payload = record.payload || {};
        if (payload.kind !== 'signup') return { status: 'invalid' };
        const organizationSlug = validatedOrganizationRouteSlug(payload.organizationSlug);
        const claimed = await transaction.emailVerificationCode.updateMany({
          where: { id: record.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: maxAttempts } },
          data: { consumedAt: now },
        });
        if (Number(claimed.count || 0) !== 1) return { status: 'invalid' };
        const existingOrganization = await transaction.organization.findUnique({ where: { slug: organizationSlug } });
        if (existingOrganization) throw conflictError('organization_slug_already_exists');
        const existingUser = await transaction.user.findUnique({ where: { email } });
        if (existingUser) throw conflictError('user_already_exists');
        const firstUser = Number(await transaction.user.count()) === 0;
        const policy = typeof input.resolvePolicy === 'function'
          ? input.resolvePolicy(payload, { firstUser })
          : payload.policy || {};
        const organization = await transaction.organization.create({
          data: {
            name: payload.organizationName || payload.organizationSlug,
            slug: organizationSlug,
            plan: payload.plan || 'free',
          },
        });
        const user = await transaction.user.create({
          data: {
            name: payload.name || email,
            studentId: payload.studentId || '',
            clubMemberClaim: Boolean(payload.clubMemberClaim),
            email,
            passwordHash: payload.passwordHash,
            role: policy.role || 'USER',
            accountType: normalizeAccountType(policy.accountType),
            approvalStatus: policy.approvalStatus || 'PENDING',
            sessionVersion: 0,
            emailVerifiedAt: now,
          },
        });
        const membership = await transaction.membership.create({
          data: { organizationId: organization.id, userId: user.id, role: 'owner' },
        });
        const memberships = await transaction.membership.findMany({ where: { userId: user.id } });
        return {
          status: 'verified',
          user: redactUser(user),
          organization,
          membership,
          memberships,
          verifiedAt: now.toISOString(),
        };
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw conflictError('signup_identity_already_exists');
      throw error;
    }
  }

  async markUserEmailVerified(userId: string, verifiedAt = new Date().toISOString()) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(verifiedAt) } });
    await this.prisma.auditLog.create({ data: { actorUserId: userId, action: 'user.email:verify', targetType: 'user', targetId: userId, metadata: {} } });
    return redactUser(user);
  }

  async findUserByGitHubId(githubId: string) {
    const id = String(githubId || '').trim();
    if (!id) return null;
    return this.prisma.user.findFirst({ where: { githubId: id } });
  }

  async linkGitHubUser(userId: string, input: Record<string, any> = {}) {
    const existing = input.githubId ? await this.findUserByGitHubId(input.githubId) : null;
    if (existing && String(existing.id) !== String(userId)) {
      const error = new Error('github account is already linked to another user');
      (error as any).statusCode = 403;
      throw error;
    }
    const data: Record<string, any> = {};
    if (input.githubId !== null && input.githubId !== undefined && String(input.githubId).trim()) data.githubId = String(input.githubId);
    if (input.avatarUrl !== null && input.avatarUrl !== undefined && String(input.avatarUrl).trim()) data.avatarUrl = String(input.avatarUrl);
    if (input.name !== null && input.name !== undefined && String(input.name).trim()) data.name = String(input.name);
    const user = Object.keys(data).length
      ? await this.prisma.user.update({ where: { id: userId }, data })
      : await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error(`user not found: ${userId}`);
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'user.github:link', targetType: 'user', targetId: userId, metadata: maskSecrets({ githubId: input.githubId || user.githubId || null, githubLogin: input.githubLogin || null }) } });
    return redactUser(user);
  }

  async addMember(input: Record<string, any>) {
    const roleResult = parseOrganizationMembershipRoleForMutation(input.role || 'DEVELOPER');
    if (roleResult.ok === false) throw badRequestError(roleResult.code);
    const role = typeof input.role === 'string' && input.role === input.role.toLowerCase() ? input.role : roleResult.role;
    const where = { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } };
    return this.prisma.$transaction(async (transaction: any) => {
      const existing = await transaction.membership.findUnique({ where });
      const protectCanonicalOwner = normalizeOrganizationRoleForRead(existing?.role) === 'OWNER' && roleResult.role !== 'OWNER';
      const ownerCount = protectCanonicalOwner || input.actorRole !== undefined
        ? await organizationOwnerCount(transaction, input.organizationId)
        : 0;
      if (input.actorRole !== undefined) {
        const transition = membershipRoleTransition({ actorRole: input.actorRole, targetRole: roleResult.role, currentRole: existing?.role || 'VIEWER', ownerCount });
        if (transition.statusCode === 400) throw badRequestError(transition.code);
        if (transition.statusCode === 403) throw forbiddenError(transition.code);
        if (transition.statusCode === 409) throw conflictError(transition.code);
      }
      if (protectCanonicalOwner && ownerCount <= 1) throw conflictError('membership_last_owner');
      const membership = await transaction.membership.upsert({
        where,
        update: { role },
        create: { organizationId: input.organizationId, userId: input.userId, role },
      });
      if (existing && existing.role !== role) {
        await transaction.user.update({ where: { id: input.userId }, data: { sessionVersion: { increment: 1 } } });
      }
      return membership;
    }, { isolationLevel: 'Serializable' });
  }

  async removeMember(input: Record<string, any>) {
    const where = { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } };
    return this.prisma.$transaction(async (transaction: any) => {
      const existing = await transaction.membership.findUnique({ where });
      if (!existing) return null;
      const isOwner = existing.role === 'OWNER' || existing.role === 'owner';
      const canCountOwners = typeof transaction.membership.count === 'function';
      const ownerCount = isOwner && canCountOwners ? await organizationOwnerCount(transaction, input.organizationId) : 0;
      if (isOwner && canCountOwners && ownerCount <= 1) throw conflictError('membership_last_owner');
      const membership = await transaction.membership.delete({ where });
      await transaction.user.update({ where: { id: input.userId }, data: { sessionVersion: { increment: 1 } } });
      return membership;
    }, { isolationLevel: 'Serializable' });
  }

  async listMembershipsForUser(userId: string) {
    return this.prisma.membership.findMany({ where: { userId } });
  }

  async createProject(input: Record<string, any>) {
    const slug = input.slug || slugInput(input.name);
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const existing = await tx.project.findUnique({ where: { organizationId_slug: { organizationId: input.organizationId, slug } } });
      assertMutable(existing, 'project');
      await enforcePrismaQuotaRequirements(tx, input.actorUserId, 'project:create', [{ metric: 'maxProjects', increment: existing ? 0 : 1 }]);
      return tx.project.upsert({
        where: { organizationId_slug: { organizationId: input.organizationId, slug } },
        update: { name: input.name, description: input.description || '', status: input.actorUserId ? 'ACTIVE' : (input.status || 'ACTIVE') },
        create: { organizationId: input.organizationId, name: input.name, slug, description: input.description || '', status: input.actorUserId ? 'ACTIVE' : (input.status || 'ACTIVE') },
      });
    });
  }

  async updateProject(projectId: string, updates: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const current = await tx.project.findUnique({ where: { id: projectId } });
      if (!current) return null;
      assertMutable(current, 'project');
      return tx.project.update({ where: { id: projectId }, data: projectUpdateData(parseProjectMutation(updates)) });
    }, { isolationLevel: 'Serializable' });
  }

  async deleteProject(projectId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      await lockRecoveryDeletion(tx, { projectId });
      const current = await tx.project.findUnique({ where: { id: projectId } });
      if (!current) return null;
      const requestedAt = current.deletionRequestedAt || new Date();
      const services = await tx.service.findMany({ where: { projectId }, select: { id: true } });
      const resources = await tx.resource.findMany({ where: { projectId }, select: { id: true } });
      const deployments = await tx.deployment.findMany({ where: { projectId }, select: { id: true } });
      await revokeResourceAttachments(tx, resources.map((row: Record<string, any>) => row.id));
      await tx.project.updateMany({
        where: { id: projectId, status: { notIn: deletionStatuses } },
        data: { status: deletionRequestedStatus, deletionRequestedAt: requestedAt },
      });
      await tx.service.updateMany({
        where: { projectId, status: { notIn: deletionStatuses } },
        data: { status: deletionRequestedStatus, deletionRequestedAt: requestedAt },
      });
      await tx.resource.updateMany({
        where: { projectId, status: { notIn: deletionStatuses } },
        data: { status: deletionRequestedStatus, deletionRequestedAt: requestedAt },
      });
      await cancelDeletionWork(tx, {
        projectId,
        serviceIds: services.map((row: Record<string, any>) => row.id),
        resourceIds: resources.map((row: Record<string, any>) => row.id),
        deploymentIds: deployments.map((row: Record<string, any>) => row.id),
      });
      await tx.auditLog.create({ data: { actorUserId: null, action: 'project:delete-requested', targetType: 'project', targetId: projectId, metadata: maskSecrets({ repeated: isDeleting(current), childServices: services.length, childResources: resources.length }) } });
      return tx.project.findUnique({ where: { id: projectId } });
    }, { isolationLevel: 'Serializable' });
  }

  async createService(input: Record<string, any>, options: Record<string, any> = {}) {
    const slug = input.slug || slugInput(input.name);
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      await requireMutableProject(tx, input.projectId);
      const existing = await tx.service.findUnique({ where: { projectId_slug: { projectId: input.projectId, slug } } });
      assertMutable(existing, 'service');
      assertServiceReplacement(Boolean(existing && await tx.deployment.findFirst({ where: { serviceId: existing.id }, select: { id: true } })));
      await enforcePrismaQuotaRequirements(tx, input.actorUserId, 'service:create', serviceQuotaRequirements(existing, input));
      return tx.service.upsert({
        where: { projectId_slug: { projectId: input.projectId, slug } },
        update: serviceData(input, options),
        create: { projectId: input.projectId, name: input.name, slug, ...serviceData(input, options) },
      });
    });
  }

  async createResource(input: Record<string, any>) {
    requireResourceExecution(normalizeResourceEngine(input.engine || input.type));
    const row = await serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      await requireMutableProject(tx, input.projectId);
      const existing = await tx.resource.findUnique({ where: { projectId_name: { projectId: input.projectId, name: input.name } } });
      assertMutable(existing, 'resource');
      if (String(existing?.status || '').toUpperCase() === 'READY') return existing;
      await enforcePrismaQuotaRequirements(tx, input.actorUserId, 'resource:create', resourceQuotaRequirements(existing, input));
      return tx.resource.upsert({
        where: { projectId_name: { projectId: input.projectId, name: input.name } },
        update: resourceData({ ...input, slug: input.slug || existing?.slug }, { connectionSecretName: existing?.connectionSecretName || null, baseDesiredSpec: existing?.desiredSpec || {}, currentDesiredState: existing?.desiredState || {} }),
        create: { projectId: input.projectId, name: input.name, slug: input.slug || slugInput(input.name), ...resourceData(input) },
      });
    });
    return this.getResource(row.id);
  }

  async updateResource(resourceId: string, updates: Record<string, any>) {
    parseResourceMutation(updates);
    const updated = await this.prisma.$transaction(async (tx: any) => {
      const current = await tx.resource.findUnique({ where: { id: resourceId } });
      if (!current) return null;
      assertMutable(current, 'resource');
        if (String(current.status || '').toUpperCase() === 'READY') throw conflictError('READY managed resources cannot be updated in place; delete and recreate the resource');
    if (String(current.status || '').toUpperCase() === 'RECONCILING' && Object.keys(updates || {}).length > 0) throw conflictError('RECONCILING managed resources cannot be updated while the provisioner claim is active');
      await requireMutableProject(tx, current.projectId);
      const row = await tx.resource.update({ where: { id: resourceId }, data: resourceData({ ...current, ...updates, projectId: current.projectId, name: updates.name || current.name }, { connectionSecretName: current.connectionSecretName || null, baseDesiredSpec: current.desiredSpec || {}, currentDesiredState: current.desiredState || {} }) });
      await tx.auditLog.create({ data: { actorUserId: null, action: 'resource:update', targetType: 'resource', targetId: resourceId, metadata: maskSecrets(updates) } });
      return row;
    }, { isolationLevel: 'Serializable' });
    if (!updated) return null;
    return this.getResource(resourceId);
  }

  async deleteResource(resourceId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      await lockRecoveryDeletion(tx, { resourceId });
      const current = await tx.resource.findUnique({ where: { id: resourceId } });
      if (!current) return null;
      const attachmentsRevoked = await revokeResourceAttachments(tx, [resourceId]);
      await tx.resource.updateMany({
        where: { id: resourceId, status: { notIn: deletionStatuses } },
        data: { status: deletionRequestedStatus, deletionRequestedAt: current.deletionRequestedAt || new Date() },
      });
      await cancelDeletionWork(tx, { projectId: current.projectId, resourceIds: [resourceId] });
      await tx.auditLog.create({ data: { actorUserId: null, action: 'resource:delete-requested', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ projectId: current.projectId, engine: current.engine, repeated: isDeleting(current), attachmentsRevoked }) } });
      return tx.resource.findUnique({ where: { id: resourceId } });
    }, { isolationLevel: 'Serializable' });
  }

  async provisionResourceProvider({ resourceId, actorUserId = 'provider', ...options }: Record<string, any>) {
      const intent = parseResourceIntent(options);
      return this.prisma.$transaction(async (tx: any) => {
        const resource = await tx.resource.findUnique({ where: { id: resourceId } });
        if (!resource) throw notFoundError(`resource not found: ${resourceId}`);
        const plan = buildResourceProviderPlan(resource, providerPlanPlaceholders());
        const publicPlan = publicResourceProviderPlan(plan);
        if (intent === 'preview-plan') return { resource, result: { intent, engine: plan.engine, provider: plan.provider, status: 'PLAN_ONLY', dryRun: true, plan: publicPlan } };
        const resourceExecution = requireResourceExecution(resource.engine);
        assertMutable(resource, 'resource');
        if (['READY', 'RECONCILING'].includes(String(resource.status).toUpperCase())) throw conflictError('Active managed resources cannot be reprovisioned');
        await requireMutableProject(tx, resource.projectId);
        // Persist a request only; the authoritative Go provisioner owns execution.
        const result = { intent, engine: plan.engine, provider: plan.provider, status: 'PROVISIONING', dryRun: false };
        const updated = await tx.resource.update({
          where: { id: resourceId },
          data: { status: 'PROVISIONING', desiredState: maskSecrets({ ...(resource.desiredState || {}), resourceExecution }) },
        });
        await tx.auditLog.create({ data: { actorUserId, action: 'resource.provider:requested', targetType: 'resource', targetId: resourceId, metadata: { engine: result.engine, executor: 'go-provisioner' } } });
        return { resource: updated, result: maskSecrets(result) };
      }, { isolationLevel: 'Serializable' });
  }

  async attachProviderConnectionSecret({ resourceId, databaseUrl, connectionUrl, actorUserId = 'provider', key = 'DATABASE_URL', live = true }: Record<string, any>) {
      void resourceId; void databaseUrl; void connectionUrl; void actorUserId; void key; void live;
      throw forbiddenError('provider credentials are written only by the Go provisioner to a Kubernetes Secret');
  }

  async attachProviderConnectionSecrets({ resourceId, env = {}, actorUserId = 'provider', live = false, providerMode = 'provider-contract' }: Record<string, any>) {
      return this.prisma.$transaction(async () => {
        void resourceId; void env; void actorUserId; void live; void providerMode;
        throw forbiddenError('provider credentials are written only by the Go provisioner to a Kubernetes Secret');
      }, { isolationLevel: 'Serializable' });
  }

  async createDeployment(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const service = input.serviceId ? await tx.service.findUnique({ where: { id: input.serviceId } }) : null;
      if (!service) throw notFoundError(`service not found: ${input.serviceId}`);
      assertMutable(service, 'service');
      const projectId = input.projectId || service.projectId;
      await requireMutableProject(tx, projectId);
      return tx.deployment.create({ data: deploymentData({ ...input, projectId, desiredSpecSnapshot: captureDeploymentSnapshot(service), snapshotVersion: 1 }) });
    }, { isolationLevel: 'Serializable' });
  }

  async updateService(serviceId: string, updates: Record<string, any>, options: Record<string, any> = {}) {
    return this.prisma.$transaction(async (tx: any) => {
      const current = await tx.service.findUnique({ where: { id: serviceId } });
      if (!current) return null;
      assertMutable(current, 'service');
      assertPrismaGitHubBindingImmutable(current, updates);
      await requireMutableProject(tx, current.projectId);
      const trusted = options.mutation === INTERNAL_SERVICE_MUTATION || options.allowGitHubBinding === true;
      if (!trusted) assertNoTenantGitHubBinding(updates);
      const parsed = trusted ? updates : parseServiceMutation(updates);
      const deployed = !trusted && (Object.hasOwn(parsed, 'name') || Object.hasOwn(parsed, 'type'))
        ? Boolean(await tx.deployment.findFirst({ where: { serviceId }, select: { id: true } })) : false;
      const quota = !trusted && parsed.resources !== undefined && options.actorUserId
        ? await tx.quota.findFirst({ where: { userId: options.actorUserId }, orderBy: { updatedAt: 'desc' } }) : undefined;
      const safeUpdates = trusted ? parsed : serviceMutationState(current, parsed, { deployed, quota });
      return tx.service.update({
        where: { id: serviceId },
        data: serviceUpdateData(safeUpdates, { ...options, currentDesiredState: current.desiredState, currentDesiredSpec: current.desiredSpec }),
      });
    }, { isolationLevel: 'Serializable' });
  }

  async deleteService(serviceId: string) {
    return this.prisma.$transaction(async (tx: any) => {
      const current = await tx.service.findUnique({ where: { id: serviceId } });
      if (!current) return null;
      const deployments = await tx.deployment.findMany({ where: { serviceId }, select: { id: true } });
      await tx.service.updateMany({
        where: { id: serviceId, status: { notIn: deletionStatuses } },
        data: { status: deletionRequestedStatus, deletionRequestedAt: current.deletionRequestedAt || new Date() },
      });
      await cancelDeletionWork(tx, { projectId: current.projectId, serviceIds: [serviceId], deploymentIds: deployments.map((row: Record<string, any>) => row.id) });
      await tx.auditLog.create({ data: { actorUserId: null, action: 'service:delete-requested', targetType: 'service', targetId: serviceId, metadata: maskSecrets({ projectId: current.projectId, repeated: isDeleting(current) }) } });
      return tx.service.findUnique({ where: { id: serviceId } });
    }, { isolationLevel: 'Serializable' });
  }

  async updateDeployment(deploymentId: string, updates: Record<string, any>, options: Record<string, any> = {}) {
    const current = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!current) throw notFoundError(`deployment not found: ${deploymentId}`);
    if (current && Object.prototype.hasOwnProperty.call(updates || {}, 'status')) {
      if (options.validateTransition === true) assertDeploymentTransition(current.status, updates.status);
    }
    const data = deploymentUpdateData(updates, current);
    const deployment = await this.prisma.deployment.update({ where: { id: deploymentId }, data });
    const statusChanged = Object.prototype.hasOwnProperty.call(data, 'status') && normalizeDeploymentStatus(current.status) !== normalizeDeploymentStatus(deployment.status);
    if ((statusChanged || options.eventType) && options.appendEvent !== false) {
      await this.appendDeploymentEvent({
        deploymentId,
        type: options.eventType || 'deployment.status.changed',
        message: options.message || `Deployment status changed: ${normalizeDeploymentStatus(current.status)} -> ${normalizeDeploymentStatus(deployment.status)}`,
        metadata: { from: normalizeDeploymentStatus(current.status), to: normalizeDeploymentStatus(deployment.status), imageUrl: deployment.imageUrl, imageDigest: deployment.imageDigest, errorCode: deployment.errorCode, ...(options.metadata || {}) },
      });
    }
    return deployment;
  }

  async transitionDeployment(deploymentId: string, status: string, updates: Record<string, any> = {}, options: Record<string, any> = {}) {
    const current = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!current) throw notFoundError(`deployment not found: ${deploymentId}`);
    const nextStatus = normalizeDeploymentStatus(status);
    assertDeploymentTransition(current.status, nextStatus);
    const deployment = await this.updateDeployment(deploymentId, { ...updates, status: nextStatus }, { ...options, appendEvent: false });
    await this.appendDeploymentEvent({
      deploymentId,
      type: options.eventType || 'deployment.status.changed',
      message: options.message || `Deployment status changed: ${normalizeDeploymentStatus(current.status)} -> ${nextStatus}`,
      metadata: { from: normalizeDeploymentStatus(current.status), to: nextStatus, ...(options.metadata || {}) },
    });
    return deployment;
  }

  async cancelDeployment(deploymentId: string, input: Record<string, any> = {}) {
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const current = await tx.deployment.findUnique({ where: { id: deploymentId } });
      if (!current) throw notFoundError(`deployment not found: ${deploymentId}`);
      const currentStatus = normalizeDeploymentStatus(current.status);
      if (currentStatus === 'CANCELLED') return { deployment: current };
      if (!canCancelDeployment(currentStatus)) {
        throw conflictError('deployment_cancellation_conflict: deployment cannot be cancelled after runtime reconciliation has started or reached a terminal state');
      }
      const nextStatus = 'CANCELLED';
      assertDeploymentTransition(current.status, nextStatus);
      const cancelledAt = new Date();
      await tx.workflowJob.updateMany({
        where: {
          type: { in: ['build-and-deploy', 'preview-deploy', 'build', 'builder'] },
          status: { in: ['queued', 'running'] },
          OR: [
            { targetType: 'deployment', targetId: deploymentId },
            { payload: { path: ['deploymentId'], equals: deploymentId } },
          ],
        },
        data: { status: 'cancelled', lockedBy: null, lockedAt: null, updatedAt: cancelledAt },
      });
      const deployment = await tx.deployment.update({
        where: { id: deploymentId },
        data: deploymentUpdateData({
          status: nextStatus,
          errorCode: input.errorCode || 'DEPLOYMENT_CANCELLED',
          errorMessage: input.reason || input.errorMessage || 'Deployment cancelled',
          reconcileAction: null,
          reconcileLockedBy: null,
          reconcileLockedAt: null,
        }, current),
      });
      await tx.deploymentEvent.create({
        data: {
          deploymentId,
          type: 'deployment.cancelled',
          message: sanitizeLogRecord(input.reason || 'Deployment cancelled'),
          metadata: sanitizeJson({ from: normalizeDeploymentStatus(current.status), to: nextStatus }),
        },
      });
      return { deployment };
    });
  }

  async rollbackDeployment(deploymentId: string, input: Record<string, any> = {}) {
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const current = await tx.deployment.findUnique({ where: { id: deploymentId } });
      if (!current) throw notFoundError(`deployment not found: ${deploymentId}`);
      const previous = input.previousDeploymentId
        ? await tx.deployment.findUnique({ where: { id: String(input.previousDeploymentId) } })
        : await tx.deployment.findFirst({
          where: { serviceId: current.serviceId, id: { not: current.id }, status: 'READY', imageUrl: { not: null } },
          orderBy: [{ deployedAt: 'desc' }, { finishedAt: 'desc' }, { createdAt: 'desc' }],
        });
      validateRollbackSource(current, previous, input.previousDeploymentId);
      const imageUrl = previous?.imageUrl || null;
      if (!imageUrl) throw conflictError('no previous READY deployment image is available for rollback');
      const imageDigest = previous?.imageDigest || null;
      await enforcePrismaQuotaRequirements(tx, input.actorUserId, 'deployment:create', deploymentQuotaRequirements(current.deploymentType));
      const rollback = await tx.deployment.create({ data: deploymentData({
        serviceId: current.serviceId,
        projectId: current.projectId,
        commitSha: previous?.commitSha || current.commitSha || null,
        imageUrl,
        imageDigest,
        status: 'IMAGE_READY',
        deploymentType: current.deploymentType || 'production',
        triggerType: 'rollback',
        branch: input.branch || current.branch || previous?.branch || 'main',
      }) });
      await tx.deploymentEvent.create({ data: { deploymentId: current.id, type: 'deployment.rollback.requested', message: sanitizeLogRecord(`Rollback requested to ${imageUrl}`), metadata: sanitizeJson(maskSecrets({ rollbackDeploymentId: rollback.id, previousDeploymentId: previous?.id || null, imageUrl, imageDigest })) } });
      await tx.deploymentEvent.create({ data: { deploymentId: rollback.id, type: 'deployment.rollback.created', message: sanitizeLogRecord(`Rollback deployment created from ${current.id}`), metadata: sanitizeJson(maskSecrets({ rollbackOfDeploymentId: current.id, previousDeploymentId: previous?.id || null, imageUrl, imageDigest })) } });
      const workflowJob = await tx.workflowJob.create({ data: workflowJobData({
        type: 'rollback-deploy',
        targetType: 'deployment',
        targetId: rollback.id,
        payload: { deploymentId: rollback.id, rollbackOfDeploymentId: current.id, previousDeploymentId: previous?.id || null, serviceId: rollback.serviceId, projectId: rollback.projectId, imageUrl, imageDigest },
      }) });
      return { deployment: rollback, rollbackOfDeploymentId: current.id, previousDeployment: previous || null, workflowJob };
    });
  }

  async requestPreviewCleanup(deploymentId: string, input: Record<string, any> = {}) {
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const deployment = await tx.deployment.findUnique({ where: { id: deploymentId } });
      if (!deployment) throw notFoundError(`deployment not found: ${deploymentId}`);
      if (String(deployment.deploymentType).toLowerCase() !== 'preview' || !deployment.previewLineageId) throw conflictError('PREVIEW_CLEANUP_UNAVAILABLE');
      const lineageRow = await tx.previewLineage.findUnique({ where: { id: deployment.previewLineageId } });
      if (!lineageRow || lineageRow.projectId !== deployment.projectId || lineageRow.serviceId !== deployment.serviceId) throw conflictError('PREVIEW_CLEANUP_UNAVAILABLE');
      const lineage = previewLineageRecord(lineageRow);
      const operationId = `preview-cleanup:${lineage.id}`;
      const attempts = await tx.deployment.findMany({ where: { previewLineageId: lineage.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const deploymentIds = attempts.map((candidate: Record<string, any>) => candidate.id);
      const status = attempts.every((candidate: Record<string, any>) => normalizeDeploymentStatus(candidate.status) === 'CLEANED_UP') ? 'CLEANED_UP' : 'PREVIEW_CLEANUP_REQUESTED';
      if (lineage.state !== 'CLOSED') {
        const closed = { ...lineage, state: 'CLOSED' as const, version: lineage.version + 1, candidateDeploymentId: null, candidateGeneration: null, currentDeploymentId: null, currentGeneration: null };
        await tx.previewLineage.update({ where: { id: lineage.id }, data: { ...previewLineageData(closed), routeIntent: previewCloseIntent(closed), reconcileToken: null, reconcileWorker: null, reconcileLeaseUntil: null } });
        await tx.deployment.updateMany({ where: { previewLineageId: lineage.id, status: { notIn: ['CLEANED_UP', 'cleaned_up'] } }, data: { status: 'PREVIEW_CLEANUP_REQUESTED' } });
        await tx.workflowJob.updateMany({ where: { status: { in: ['queued', 'running'] }, OR: [{ targetId: lineage.id }, { targetId: { in: deploymentIds } }] }, data: { status: 'cancelled', lockedBy: null, lockedAt: null } });
        for (const attempt of attempts) if (normalizeDeploymentStatus(attempt.status) !== 'CLEANED_UP') {
          const eventId = stableId('devevt', attempt.id, operationId);
          await tx.deploymentEvent.upsert({ where: { id: eventId }, update: {}, create: { id: eventId, deploymentId: attempt.id, type: 'preview.cleanup.requested', message: 'Preview cleanup requested', metadata: { operationId, lineageId: lineage.id } } });
        }
        await tx.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'preview:cleanup-requested', targetType: 'preview-lineage', targetId: lineage.id, metadata: { operationId, deploymentIds } } });
      }
      return { operationId, status, streamHref: `/deployments/${deploymentId}/stream`, lineageId: lineage.id, deploymentIds };
    });
  }

  async createDeploymentWorkflow(input: Record<string, any>) {
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const requestedDeployment = input.deployment || input;
      const service = await tx.service.findUnique({ where: { id: requestedDeployment.serviceId } });
      if (!service) throw notFoundError(`service not found: ${requestedDeployment.serviceId}`);
      assertMutable(service, 'service');
      await requireMutableProject(tx, requestedDeployment.projectId || service.projectId);
      await enforcePrismaQuotaRequirements(tx, input.actorUserId || requestedDeployment.actorUserId, 'deployment:create', deploymentQuotaRequirements(requestedDeployment.deploymentType));
      const deployment = await tx.deployment.create({ data: deploymentData({ ...requestedDeployment, projectId: requestedDeployment.projectId || service?.projectId, desiredSpecSnapshot: captureDeploymentSnapshot(service), snapshotVersion: 1 }) });
      const workflowJob = await tx.workflowJob.create({ data: workflowJobData({
        ...(input.workflow || {}),
        targetType: 'deployment',
        targetId: deployment.id,
        payload: { ...(input.workflow?.payload || {}), deploymentId: deployment.id },
      }) });
      return { deployment, workflowJob };
    });
  }

  async getProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    return project ? { ...project, organizationSlug: project.organization?.slug } : null;
  }

  async getService(serviceId: string) {
    return this.prisma.service.findUnique({ where: { id: serviceId } });
  }

  async createDeploymentOperation(input: DeploymentOperation) {
    return this.prisma.$transaction(async tx => {
      // READ COMMITTED takes a fresh snapshot after the per-service lock, so all
      // concurrent replays observe the committed winner without retry storms.
      await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${input.serviceId}, 15))`;
      const service = await tx.service.findUnique({ where: { id: input.serviceId } });
      if (!service) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
      const existing = await tx.deployment.findUnique({ where: { serviceId_requestIdempotencyKey: { serviceId: input.serviceId, requestIdempotencyKey: input.requestIdempotencyKey } } });
      if (existing) {
        const workflowJob = await tx.workflowJob.findFirst({ where: { targetId: existing.id, targetType: 'deployment' } });
        if (!workflowJob) throw new DeploymentOperationError('LINEAGE_JOB_MISSING');
        assertOperationReplay(input, workflowJob.payload);
        return { deployment: existing, workflowJob, operationId: workflowJob.id, status: existing.status, streamHref: `/deployments/${existing.id}/stream` };
      }
      const source = input.operation === 'retry'
        ? await tx.deployment.findUnique({ where: { id: input.sourceDeploymentId || '' } })
        : await tx.deployment.findFirst({ where: { serviceId: input.serviceId, status: { in: ['BUILD_FAILED', 'FAILED', 'READY'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      let previewLineage: PreviewLineageRecord | null = null;
      if (String(source?.deploymentType || '').toLowerCase() === 'preview') {
        const lineageRow = await tx.previewLineage.findUnique({ where: { id: source.previewLineageId || '' } });
        previewLineage = assertPreviewRetry(lineageRow ? previewLineageRecord(lineageRow) : null, source);
      }
      let candidate = deploymentSuccessor(source, input);
      if (previewLineage) {
        const lineage = previewLineage;
        const advanced = { ...lineage, version: lineage.version + 1, generation: lineage.generation + 1, candidateDeploymentId: null, candidateGeneration: null };
        const runtime = createPreviewRuntime(advanced, candidate.id);
        candidate = { ...candidate, commitSha: lineage.headSha, commitHash: lineage.headSha, previewLineageId: lineage.id, previewGeneration: advanced.generation, previewRuntime: runtime, previewUrl: `https://${lineage.stableHost}` };
        await tx.previewLineage.update({ where: { id: lineage.id }, data: previewLineageData(advanced) });
      }
      if (await tx.deployment.findFirst({ where: { serviceId: input.serviceId, status: { notIn: [...terminalDeploymentStatuses] } } })) throw new DeploymentOperationError('ACTIVE_DEPLOYMENT');
      assertMutable(service, 'service');
      await requireMutableProject(tx, service.projectId);
      await enforcePrismaQuotaRequirements(tx, input.requestedByUserId === 'system' ? null : input.requestedByUserId, 'deployment:create', deploymentQuotaRequirements(candidate.deploymentType));
      const deployment = await tx.deployment.create({ data: candidate });
      const workflowJob = await tx.workflowJob.create({ data: workflowJobData(successorWorkflow(candidate, input)) });
      if (candidate.previewLineageId) await tx.previewLineage.update({ where: { id: candidate.previewLineageId }, data: { candidateDeploymentId: deployment.id, candidateGeneration: candidate.previewGeneration } });
      await tx.deploymentEvent.create({ data: { deploymentId: deployment.id, type: 'deployment.queued', message: 'Immutable deployment operation queued', metadata: { sourceDeploymentId: candidate.sourceDeploymentId } } });
      return { deployment, workflowJob, operationId: workflowJob.id, status: deployment.status, streamHref: `/deployments/${deployment.id}/stream` };
    }, { isolationLevel: 'ReadCommitted', maxWait: 30000, timeout: 30000 });
  }

  async getResource(resourceId: string) {
    return this.prisma.resource.findUnique({ where: { id: resourceId } });
  }

  async getDeployment(deploymentId: string) {
    const row = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    return row ? publicDeploymentHealth(row) : null;
  }

  async listProjectsForOrganizations(organizationIds?: string[], options: Record<string, any> = {}) {
    const scope = organizationIds ? { organizationId: { in: organizationIds } } : {};
    const projects = await findKeysetRows(this.prisma.project, scope, options, {
      include: { _count: { select: { services: true, resources: true } } },
    });
    return projects.map(({ _count, ...project }: Record<string, any>) => ({
      ...project,
      serviceCount: Number(_count?.services || 0),
      resourceCount: Number(_count?.resources || 0),
    }));
  }

  async listPublicSites(limit: unknown = 5) {
    const take = normalizePublicSiteLimit(limit);
    if (take === 0) return { sites: [] };
    const services = await this.prisma.service.findMany({
      where: {
        type: 'web',
        deletionRequestedAt: null,
        domains: { some: { verified: true } },
        deployments: {
          some: {
            deploymentType: { in: ['production', 'PRODUCTION'] },
            status: { in: ['ready', 'READY'] },
          },
        },
        project: { is: { deletionRequestedAt: null, status: { notIn: ['ARCHIVED', 'DELETED', 'FAILED', 'archived', 'deleted', 'failed'] } } },
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        type: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        domains: { where: { verified: true }, select: { domain: true, verified: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
        deployments: {
          where: {
            deploymentType: { in: ['production', 'PRODUCTION'] },
            status: { in: ['ready', 'READY'] },
          },
          select: { id: true, deploymentType: true, status: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        project: { select: { id: true, name: true, slug: true, status: true, organization: { select: { name: true, slug: true } } } },
      },
      distinct: ['projectId'],
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return publicSitesFromServices(services, take);
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(redactUser);
  }

  async getQuotaForUser(userId: string) {
    return this.prisma.quota.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
  }

  async listUsageRecordsForUser(userId: string, options: Record<string, any> = {}) {
    const month = utcMonthBounds(options.now);
    return this.prisma.usageRecord.findMany({
      where: { userId, recordedAt: { gte: month.startDate, lt: month.endDate } },
      orderBy: { recordedAt: 'desc' },
      take: activityLimit(options.limit),
    });
  }

  async adminOverview(options: Record<string, any> = {}) {
    const limit = activityLimit(options.limit);
    const [users, quotas, auditLogs] = await Promise.all([
      this.prisma.user.findMany({
        select: { id: true, email: true, name: true, studentId: true, clubMemberClaim: true, avatarUrl: true, githubId: true, role: true, accountType: true, approvalStatus: true, emailVerifiedAt: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.quota.findMany({ orderBy: { updatedAt: 'desc' }, take: limit }),
      this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    return deepClone({ users, quotas, auditLogs });
  }

  async listServicesForProject(projectId: string, options: Record<string, any> = {}) {
    return findKeysetRows(this.prisma.service, { projectId }, options);
  }

  async listResourcesForProject(projectId: string, options: Record<string, any> = {}) {
    return findKeysetRows(this.prisma.resource, { projectId }, options);
  }

  async listDeploymentsForService(serviceId: string, options: Record<string, any> = {}) {
    return (await findKeysetRows(this.prisma.deployment, { serviceId }, options)).map(publicDeploymentHealth);
  }

  async listDeploymentsForProject(projectId: string, options: Record<string, any> = {}) {
    return (await findKeysetRows(this.prisma.deployment, { projectId }, options)).map(publicDeploymentHealth);
  }

  async upsertServiceEnvironment(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const service = await tx.service.findUnique({ where: { id: input.serviceId } });
      if (!service) throw notFoundError(`service not found: ${input.serviceId}`);
      assertMutable(service, 'service');
      await requireMutableProject(tx, input.projectId || service.projectId);
      return upsertServiceEnvironmentWithDb(tx, { ...input, projectId: service.projectId, desiredSpec: service.desiredSpec });
    }, { isolationLevel: 'Serializable' });
  }

  async importServiceEnvFile(input: Record<string, any>) {
    const { parseDotEnv } = await import('./env-file.ts');
    const parsed = parseDotEnv(String(input.content || ''), { source: input.source || '.env' });
    const result = await this.upsertServiceEnvironment({ ...input, entries: parsed.entries });
    return { ...result, source: input.source || '.env', parsed: { plainCount: parsed.plainCount, secretCount: parsed.secretCount, errors: parsed.errors } };
  }

  async listServiceEnvironment(input: Record<string, any>) {
    const rows = await this.prisma.environmentVariable.findMany({ where: { serviceId: input.serviceId } });
    return { serviceId: input.serviceId, entries: rows.map(maskEnvRow), plainCount: rows.filter((row) => !row.isSecret).length, secretCount: rows.filter((row) => row.isSecret).length };
  }

  async createGitHubIntegration(input: Record<string, any>) {
    const { githubIntegrationSummary } = await import('./github-integration.ts');
    const summary = githubIntegrationSummary(input);
    let row = await this.prisma.gitHubIntegration.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId || null,
        accountLogin: summary.accountLogin,
        installationId: summary.installationId ? String(summary.installationId) : null,
        tokenPreview: summary.tokenPreview,
        tokenFingerprint: summary.tokenFingerprint,
        scopes: summary.scopes,
        defaultBranch: input.defaultBranch || 'main',
      },
    });
    if (input.token) {
      const secret = await this.prisma.secretValue.upsert({
        where: { scopeType_scopeId_key: { scopeType: 'github-integration', scopeId: row.id, key: 'GITHUB_TOKEN' } },
        update: { sealedValue: sealSecret(input.token), valueMasked: maskSecretValue(input.token), metadata: maskSecrets({ accountLogin: input.accountLogin }) },
        create: { scopeType: 'github-integration', scopeId: row.id, key: 'GITHUB_TOKEN', sealedValue: sealSecret(input.token), valueMasked: maskSecretValue(input.token), metadata: maskSecrets({ accountLogin: input.accountLogin }) },
      });
      row = await this.prisma.gitHubIntegration.update({ where: { id: row.id }, data: { tokenSecretId: secret.id } });
    }
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(input.userId), action: 'github:connect', targetType: 'organization', targetId: input.organizationId, metadata: maskSecrets({ integrationId: row.id, accountLogin: row.accountLogin }) } });
    return row;
  }

  async listGitHubIntegrations(input: Record<string, any>) {
    return this.prisma.gitHubIntegration.findMany({ where: { organizationId: input.organizationId } });
  }

  async verifyGitHubIntegration(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const integration = await tx.gitHubIntegration.findUnique({ where: { id: input.integrationId } });
      if (!integration) throw notFoundError(`GitHub integration not found: ${input.integrationId}`);
      const installationId = String(input.installationId || '').trim();
      if (!installationId) throw conflictError('verified GitHub integration requires an installationId');
      if (integration.verifiedAt && String(integration.installationId) !== installationId) throw conflictError('verified GitHub installation binding is immutable');
      const conflictRow = await tx.gitHubIntegration.findFirst({ where: { installationId, verifiedAt: { not: null }, id: { not: integration.id } } });
      if (conflictRow) throw conflictError(String(conflictRow.organizationId) === String(integration.organizationId) ? 'GitHub installation is already verified by another integration' : 'GitHub installation is already verified for another organization');
      const verifiedAt = new Date();
      const row = await tx.gitHubIntegration.update({ where: { id: integration.id }, data: { installationId, accountLogin: input.accountLogin || integration.accountLogin, verifiedAt } });
      await tx.auditLog.create({ data: { actorUserId: auditActorUserId(input.verifiedBy), action: 'github:verify-installation', targetType: 'github-integration', targetId: integration.id, metadata: { organizationId: integration.organizationId, installationId } } });
      return row;
    }, { isolationLevel: 'Serializable' });
  }

  async connectVerifiedGitHubInstallation(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const organizationId = String(input.organizationId || '').trim();
      const installationId = String(input.installationId || '').trim();
      const accountLogin = String(input.accountLogin || '').trim();
      if (!organizationId) throw badRequestError('organizationId is required for GitHub integration');
      if (!/^\d+$/.test(installationId)) throw badRequestError('GitHub installationId must be numeric');
      if (!accountLogin) throw badRequestError('GitHub installation accountLogin is required');
      const existing = await tx.gitHubIntegration.findFirst({ where: { installationId, verifiedAt: { not: null } } });
      if (existing && String(existing.organizationId) !== organizationId) throw forbiddenError('GitHub installation is already verified for another organization');
      const verifiedAt = existing?.verifiedAt || new Date();
      const row = existing
        ? await tx.gitHubIntegration.update({ where: { id: existing.id }, data: { accountLogin, userId: existing.userId || input.userId || null, verifiedAt } })
        : await tx.gitHubIntegration.create({ data: { organizationId, userId: input.userId || null, accountLogin, installationId, scopes: ['repo:read'], defaultBranch: 'main', verifiedAt } });
      await tx.gitHubInstallation.upsert({
        where: { installationId },
        update: { accountLogin, accountType: String(input.accountType || 'Organization') },
        create: { installationId, accountLogin, accountType: String(input.accountType || 'Organization') },
      });
      await tx.auditLog.create({ data: { actorUserId: auditActorUserId(input.verifiedBy || input.userId), action: 'github:verify-installation', targetType: 'github-integration', targetId: row.id, metadata: { organizationId, installationId, accountLogin } } });
      return row;
    }, { isolationLevel: 'Serializable' });
  }

  async registerGitHubRepository(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const installationId = String(input.installationId || '').trim();
      const integration = await tx.gitHubIntegration.findFirst({ where: { installationId, verifiedAt: { not: null } } });
      if (!integration) throw forbiddenError('repository catalog updates require a verified GitHub installation');
      const record = canonicalPrismaGitHubRepositoryRecord(input);
      const existing = await tx.gitHubRepository.findUnique({ where: { githubRepoId: record.githubRepoId } });
      if (existing && String(existing.installationId) !== installationId) throw conflictError('GitHub repository is already bound to another installation');
      await tx.gitHubInstallation.upsert({
        where: { installationId },
        update: { accountLogin: integration.accountLogin || record.owner },
        create: { installationId, accountLogin: integration.accountLogin || record.owner, accountType: 'Organization' },
      });
      return tx.gitHubRepository.upsert({ where: { githubRepoId: record.githubRepoId }, update: record, create: record });
    }, { isolationLevel: 'Serializable' });
  }

  async replaceGitHubInstallationRepositories(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const installationId = String(input.installationId || '').trim();
      const integration = await tx.gitHubIntegration.findFirst({ where: { installationId, verifiedAt: { not: null } } });
      if (!integration) throw forbiddenError('repository catalog updates require a verified GitHub installation');
      if (!Array.isArray(input.repositories)) throw badRequestError('GitHub repositories must be an array');
      const records = input.repositories.map((repository: Record<string, any>) => canonicalPrismaGitHubRepositoryRecord({ ...repository, installationId }));
      const ids = records.map((record: Record<string, any>) => record.githubRepoId);
      if (new Set(ids).size !== ids.length) throw conflictError('GitHub repository catalog contains duplicate repository IDs');
      const conflicts = ids.length ? await tx.gitHubRepository.findMany({ where: { githubRepoId: { in: ids }, installationId: { not: installationId } } }) : [];
      if (conflicts.length) throw conflictError('GitHub repository is already bound to another installation');
      await tx.gitHubRepository.deleteMany({ where: { installationId, ...(ids.length ? { githubRepoId: { notIn: ids } } : {}) } });
      const repositories = [];
      for (const record of records) repositories.push(await tx.gitHubRepository.upsert({ where: { githubRepoId: record.githubRepoId }, update: record, create: record }));
      await tx.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'github:sync-installation-repositories', targetType: 'github-installation', targetId: installationId, metadata: { repositoryCount: repositories.length } } });
      return { installationId, repositories: repositories.map(publicPrismaGitHubRepository), repositoryCount: repositories.length };
    }, { isolationLevel: 'Serializable' });
  }

  async attachGitHubRepositoryToService(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx) => {
      const serviceRow = await tx.service.findUnique({ where: { id: input.serviceId }, include: { project: true } });
      if (!serviceRow) throw notFoundError(`service not found: ${input.serviceId}`);
      if (String(serviceRow.projectId) !== String(input.projectId)) throw forbiddenError('service does not belong to project');
      assertServiceReplacement(Boolean(await tx.deployment.findFirst({ where: { serviceId: input.serviceId }, select: { id: true } })));
      const integration = await requireVerifiedPrismaGitHubIntegration(tx, input.integrationId, serviceRow.project?.organizationId);
      const repo = await resolvePrismaGitHubRepository(tx, integration.installationId, input);
      const branch = input.branch || repo.defaultBranch || integration.defaultBranch || 'main';
      const binding = prismaGitHubServiceBinding(integration, repo);
      assertPrismaGitHubBindingImmutable(serviceRow, { repoUrl: repo.repoUrl, githubRepositoryId: repo.githubRepoId, desiredState: binding });
      const currentDesiredState = serviceRow.desiredState && typeof serviceRow.desiredState === 'object' && !Array.isArray(serviceRow.desiredState) ? serviceRow.desiredState as Record<string, any> : {};
      const currentGitHub = currentDesiredState.github && typeof currentDesiredState.github === 'object' && !Array.isArray(currentDesiredState.github) ? currentDesiredState.github : {};
      const service = await tx.service.update({
        where: { id: input.serviceId },
        data: { sourceType: 'github', repoUrl: repo.repoUrl, githubRepositoryId: repo.githubRepoId, branch, desiredState: sanitizeJson({ ...currentDesiredState, ...binding, github: { ...currentGitHub, ...binding.github, attached: true } }) },
      });
      await tx.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'github:attach-repository', targetType: 'service', targetId: input.serviceId, metadata: { repository: repo.fullName, repositoryId: repo.githubRepoId, integrationId: integration.id, installationId: integration.installationId } } });
      return { service, github: { ...binding.github, branch } };
    }, { isolationLevel: 'Serializable' });
  }

  async listGitHubInstallations(input: Record<string, any>) {
    const integrations = await this.prisma.gitHubIntegration.findMany({ where: { organizationId: input.organizationId, installationId: { not: null }, verifiedAt: { not: null } } });
    const repositoryCounts = await Promise.all(integrations.map((integration: Record<string, any>) => this.prisma.gitHubRepository.count({ where: { installationId: String(integration.installationId) } })));
    return {
      installations: integrations.map((integration: Record<string, any>, index: number) => ({
        id: String(integration.installationId),
        installationId: String(integration.installationId),
        integrationId: integration.id,
        accountLogin: integration.accountLogin,
        organizationId: integration.organizationId,
        repositoryCount: repositoryCounts[index],
      })),
    };
  }

  async listGitHubInstallationRepositories(input: Record<string, any>) {
    const organizationIds = organizationScopeArray(input);
    const integrations = await this.prisma.gitHubIntegration.findMany({ where: { installationId: String(input.installationId), verifiedAt: { not: null }, ...(organizationIds.length ? { organizationId: { in: organizationIds } } : {}) } });
    if (integrations.length === 0) return { installationId: String(input.installationId), repositories: [] };
    const rows = await this.prisma.gitHubRepository.findMany({ where: { installationId: String(input.installationId) }, orderBy: [{ fullName: 'asc' }, { githubRepoId: 'asc' }] });
    const repositories = rows.map(publicPrismaGitHubRepository);
    return { installationId: String(input.installationId), repositories };
  }

  async importGitHubRepository(input: Record<string, any>) {
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw notFoundError(`project not found: ${input.projectId}`);
      assertMutable(project, 'project');
      const integration = await requireVerifiedPrismaGitHubIntegration(tx, input.integrationId, project.organizationId);
      const repo = await resolvePrismaGitHubRepository(tx, integration.installationId, input);
      const branch = input.branch || repo.defaultBranch || integration.defaultBranch || 'main';
      const binding = prismaGitHubServiceBinding(integration, repo);
      const name = input.serviceName || repo.repo;
      const slug = slugInput(name);
      const existing = await tx.service.findUnique({ where: { projectId_slug: { projectId: input.projectId, slug } } });
      assertMutable(existing, 'service');
      assertServiceReplacement(Boolean(existing && await tx.deployment.findFirst({ where: { serviceId: existing.id }, select: { id: true } })));
      const serviceInput = {
        projectId: input.projectId,
        name,
        type: 'web',
        runtimeType: 'container',
        sourceType: 'github',
        repoUrl: repo.repoUrl,
        githubRepositoryId: repo.githubRepoId,
        branch,
        ...binding,
        desiredState: { ...binding, github: { ...binding.github, imported: true } },
      };
      await enforcePrismaQuotaRequirements(tx, input.actorUserId, 'service:create', serviceQuotaRequirements(existing, serviceInput));
      const service = await tx.service.upsert({
        where: { projectId_slug: { projectId: input.projectId, slug } },
        update: serviceData(serviceInput, { allowGitHubBinding: true }),
        create: { projectId: input.projectId, name, slug, ...serviceData(serviceInput, { allowGitHubBinding: true }) },
      });
      await tx.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'github:import-repository', targetType: 'project', targetId: input.projectId, metadata: maskSecrets({ repository: repo.fullName, repositoryId: repo.githubRepoId, integrationId: integration.id, installationId: integration.installationId }) } });
      return { service, github: { ...binding.github, branch } };
    });
  }

  async listServicesForGitHubRepository(repository: any, scope: Record<string, any> = {}) {
    return servicesForPrismaGitHubRepository(this.prisma, repository, scope);
  }

  async syncGitHubRepository(input: Record<string, any>) {
    const repository = normalizePrismaRepositoryId(input.repositoryId || input.repository || '');
    const matchedServices = await servicesForPrismaGitHubRepository(this.prisma, repository, { organizationId: input.organizationId, organizationIds: input.organizationIds });
    const authorizedServiceIds = Array.isArray(input.serviceIds) ? new Set(input.serviceIds.map(String)) : null;
    const services = authorizedServiceIds
      ? matchedServices.filter((service: Record<string, any>) => authorizedServiceIds.has(String(service.id)))
      : matchedServices;
    const workflowJob = await this.enqueueWorkflowJob({ type: 'github-repository-sync', targetType: 'github-repository', targetId: repository, payload: { repository, serviceIds: services.map((service: Record<string, any>) => service.id) } });
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'github:repository-sync', targetType: 'github-repository', targetId: repository, metadata: maskSecrets({ repository }) } });
    return { repository, services, workflowJob };
  }

  async handleGitHubWebhook(input: Record<string, any>) {
    const { githubWebhookActionPlan, githubWebhookOutboundPlan, verifyGitHubWebhookSignature } = await import('./github-integration.ts');
    const rawBody = typeof input.body === 'string' ? input.body : JSON.stringify(input.payload || {});
    const secret = input.secret || process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET || '';
    if (!secret) {
      const error = new Error('GitHub webhook secret is not configured');
      (error as any).statusCode = 503;
      throw error;
    }
    if (!verifyGitHubWebhookSignature(rawBody, input.signature, secret)) {
      const error = new Error('invalid GitHub webhook signature');
      (error as any).statusCode = 401;
      throw error;
    }
    if (String(input.event || '').toLowerCase() === 'pull_request') return this.handlePreviewWebhook({ ...input, body: rawBody, secret });
    const deliveryId = String(input.deliveryId || stableId('ghdel', input.event, rawBody));
    const actionPlan = githubWebhookActionPlan(input.event, input.payload || {});
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const existing = await tx.webhookEvent.findUnique({ where: { deliveryId } });
      if (existing?.handled) return { accepted: true, duplicate: true, deliveryId, actions: [] };
      let row = existing || await tx.webhookEvent.create({
        data: { provider: 'github', eventType: String(input.event || 'unknown'), deliveryId, payload: sanitizeJson(maskSecrets(input.payload || {})), handled: false, errorMessage: null },
      });
      const actions: any[] = await applyPrismaGitHubCatalogWebhook(tx, input.event, input.payload || {});
      const services = await servicesForPrismaGitHubWebhook(tx, actionPlan);
      const blockedServiceIds = await prismaGitHubWebhookQuotaBlocks(tx, services, actionPlan, actions);
      for (const service of services.filter((candidate: Record<string, any>) => !blockedServiceIds.has(String(candidate.id)))) {
        const deploymentId = stableId('dep', 'github', deliveryId, service.id, actionPlan.kind);
        const workflowJobId = stableId('job', 'github', deliveryId, service.id, actionPlan.kind);
        if (actionPlan.kind === 'production-deploy') {
          const deployment = await tx.deployment.upsert({
            where: { id: deploymentId },
            update: {},
            create: deploymentData({ id: deploymentId, serviceId: service.id, projectId: service.projectId, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'production', triggerType: 'github_push', branch: actionPlan.branch }),
          });
          const workflowJob = await tx.workflowJob.upsert({
            where: { id: workflowJobId },
            update: {},
            create: { id: workflowJobId, ...workflowJobData({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, githubRepositoryId: actionPlan.repositoryId, githubInstallationId: actionPlan.installationId, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook', deliveryId } }) },
          });
          actions.push({ type: 'production-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id });
        } else if (actionPlan.kind === 'preview-deploy') {
          const previewPlan = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber });
          const deployment = await tx.deployment.upsert({
            where: { id: deploymentId },
            update: {},
            create: deploymentData({ id: deploymentId, serviceId: service.id, projectId: service.projectId, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'preview', triggerType: 'github_pull_request', branch: actionPlan.branch, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: previewPlan.url }),
          });
          const preview = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id });
          const workflowJob = await tx.workflowJob.upsert({
            where: { id: workflowJobId },
            update: {},
            create: { id: workflowJobId, ...workflowJobData({ type: 'preview-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, githubRepositoryId: actionPlan.repositoryId, githubInstallationId: actionPlan.installationId, pullRequestNumber: actionPlan.pullRequestNumber, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook', deliveryId, preview, kubernetes: preview.kubernetes } }) },
          });
          const eventId = stableId('devevt', 'github', deliveryId, service.id, 'preview-queued');
          await tx.deploymentEvent.upsert({ where: { id: eventId }, update: {}, create: { id: eventId, deploymentId: deployment.id, type: 'preview.workload.queued', message: sanitizeLogRecord(`Preview Kubernetes workload queued for PR #${actionPlan.pullRequestNumber}`), metadata: sanitizeJson(maskSecrets({ previewUrl: preview.url, workloadName: preview.kubernetes.workloadName, namespace: preview.kubernetes.namespace })) } });
          actions.push({ type: 'preview-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: preview.url, previewWorkloadName: preview.kubernetes.workloadName });
        } else if (actionPlan.kind === 'preview-cleanup') {
          const preview = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber, action: 'delete' });
          const workflowJob = await tx.workflowJob.upsert({
            where: { id: workflowJobId },
            update: {},
            create: { id: workflowJobId, ...workflowJobData({ type: 'preview-cleanup', targetType: 'service', targetId: service.id, payload: { serviceId: service.id, projectId: service.projectId, repository: actionPlan.repository, githubRepositoryId: actionPlan.repositoryId, githubInstallationId: actionPlan.installationId, pullRequestNumber: actionPlan.pullRequestNumber, branch: actionPlan.branch, source: 'github-webhook', deliveryId, preview, kubernetes: preview.kubernetes } }) },
          });
          const deployments = await tx.deployment.findMany({ where: { serviceId: service.id, deploymentType: 'preview', pullRequestNumber: Number(actionPlan.pullRequestNumber) } });
          for (const deployment of deployments) {
            const cleanupPlan = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id, action: 'delete' });
            await tx.deployment.update({ where: { id: deployment.id }, data: { status: 'PREVIEW_CLEANUP_REQUESTED' } });
            const eventId = stableId('devevt', 'github', deliveryId, deployment.id, 'preview-cleanup');
            await tx.deploymentEvent.upsert({ where: { id: eventId }, update: {}, create: { id: eventId, deploymentId: deployment.id, type: 'preview.cleanup.requested', message: sanitizeLogRecord(`Preview cleanup requested for PR #${actionPlan.pullRequestNumber}`), metadata: sanitizeJson(maskSecrets({ repository: actionPlan.repository, workloadName: cleanupPlan.kubernetes.workloadName, cleanupSelector: cleanupPlan.kubernetes.cleanupSelector })) } });
          }
          actions.push({ type: 'preview-cleanup-enqueued', serviceId: service.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, deploymentIds: deployments.map((deployment: Record<string, any>) => deployment.id) });
        }
      }
      const outbound = githubWebhookOutboundPlan(actionPlan, actions);
      row = await tx.webhookEvent.update({ where: { id: row.id }, data: { handled: true, errorMessage: null } });
      const auditId = stableId('aud', 'github:webhook', deliveryId);
      await tx.auditLog.upsert({ where: { id: auditId }, update: {}, create: { id: auditId, actorUserId: null, action: 'github:webhook', targetType: 'github-delivery', targetId: deliveryId, metadata: sanitizeJson(maskSecrets({ event: input.event, repository: actionPlan.repository, action: actionPlan.action, actions: actions.map((action) => action.type) })) } });
      return { accepted: true, duplicate: false, deliveryId, event: input.event, repository: actionPlan.repository, action: actionPlan.action, matchedServiceCount: services.length, actions, outbound, webhookEvent: row };
    });
  }

  async handlePreviewWebhook(input: Record<string, any>) {
    const event = parsePreviewWebhook({ body: input.body, signature: input.signature, secret: input.secret, deliveryId: input.deliveryId });
    const actionPlan = { kind: event.action === 'closed' ? 'preview-cleanup' : 'preview-deploy', repositoryId: event.repositoryId, installationId: event.installationId, repository: event.repository, baseBranch: event.baseRef };
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const existingDelivery = await tx.webhookEvent.findUnique({ where: { deliveryId: event.deliveryId } });
      if (existingDelivery?.handled) return { accepted: true, duplicate: true, deliveryId: event.deliveryId, actions: [] };
      const services = await servicesForPrismaGitHubWebhook(tx, actionPlan);
      const actions: Record<string, unknown>[] = [];
      const blocked = event.action === 'closed' ? new Set<string>() : await prismaGitHubWebhookQuotaBlocks(tx, services, actionPlan, actions);
      for (const service of services.filter((candidate: Record<string, any>) => !blocked.has(String(candidate.id)))) {
        const organizationId = String(service.project.organizationId);
        await tx.$queryRawUnsafe('SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1,18))', `preview:organization:${organizationId}`);
        await tx.$queryRawUnsafe('SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1,15))', String(service.id));
        const desired = service.desiredState && typeof service.desiredState === 'object' && !Array.isArray(service.desiredState) ? service.desiredState : {};
        const github = desired.github && typeof desired.github === 'object' && !Array.isArray(desired.github) ? desired.github : {};
        const integrationId = String(desired.githubIntegrationId || github.integrationId || '');
        const lineageId = stableId('preview-lineage', organizationId, service.projectId, service.id, event.installationId, event.repositoryId, event.pullRequestNumber);
        const currentRow = await tx.previewLineage.findFirst({ where: { id: lineageId } });
        const current = currentRow ? previewLineageRecord(currentRow) : null;
        const transition = transitionPreviewLineage(current, event, { organizationId, projectId: service.projectId, serviceId: service.id, integrationId }, lineageId);
        if (transition.decision === 'stale' || transition.decision === 'duplicate') {
          actions.push({ type: `preview-${transition.decision}`, serviceId: service.id, lineageId });
          continue;
        }
        const data = previewLineageData(transition.lineage);
        await tx.previewLineage.upsert({ where: { id: lineageId }, update: data, create: data });
        if (transition.decision === 'ambiguous') {
          const jobId = resolverJobId(transition.lineage);
          await tx.workflowJob.upsert({ where: { id: jobId }, update: {}, create: { id: jobId, ...workflowJobData({ type: PREVIEW_RESOLVER_JOB, targetType: 'preview-lineage', targetId: lineageId, payload: resolverPayload(transition.lineage), maxAttempts: 3 }) } });
          actions.push({ type: 'preview-resolution-enqueued', serviceId: service.id, lineageId, workflowJobId: jobId });
          continue;
        }
        const attempts = await tx.deployment.findMany({ where: { previewLineageId: lineageId } });
        if (transition.decision === 'close') {
          await tx.previewLineage.update({ where: { id: lineageId }, data: { routeIntent: previewCloseIntent(transition.lineage), reconcileToken: null, reconcileWorker: null, reconcileLeaseUntil: null } });
          const mutableIds = attempts.filter((attempt: Record<string, any>) => String(attempt.status).toUpperCase() !== 'CLEANED_UP').map((attempt: Record<string, any>) => attempt.id);
          if (mutableIds.length) await tx.deployment.updateMany({ where: { id: { in: mutableIds } }, data: { status: 'PREVIEW_CLEANUP_REQUESTED' } });
          await tx.workflowJob.updateMany({ where: { status: { in: ['queued', 'running'] }, OR: [{ targetType: 'preview-lineage', targetId: lineageId }, { targetType: 'deployment', targetId: { in: attempts.map((attempt: Record<string, any>) => attempt.id) } }] }, data: { status: 'cancelled', lockedBy: null, lockedAt: null } });
          actions.push({ type: 'preview-cleanup-requested', serviceId: service.id, lineageId, deploymentIds: mutableIds });
          continue;
        }
        const deploymentId = stableId('dep', 'github-preview', event.deliveryId, service.id, transition.lineage.generation);
        const runtime = createPreviewRuntime(transition.lineage, deploymentId);
        const deployment = await tx.deployment.create({ data: deploymentData({ id: deploymentId, serviceId: service.id, projectId: service.projectId, commitSha: event.headSha, commitHash: event.headSha, status: 'queued', deploymentType: 'preview', triggerType: 'github_pull_request', branch: event.headRef, pullRequestNumber: event.pullRequestNumber, previewUrl: `https://${transition.lineage.stableHost}`, previewLineageId: lineageId, previewGeneration: transition.lineage.generation, previewRuntime: runtime, desiredSpecSnapshot: captureDeploymentSnapshot(service), snapshotVersion: 1 }) });
        const jobId = stableId('job', 'github-preview', event.deliveryId, service.id);
        await tx.workflowJob.create({ data: { id: jobId, ...workflowJobData({ type: 'preview-deploy', targetType: 'deployment', targetId: deployment.id, payload: { version: 1, lineageId, lineageVersion: transition.lineage.version, generation: transition.lineage.generation, deploymentId: deployment.id, desiredSpecSnapshot: deployment.desiredSpecSnapshot, snapshotVersion: 1, runtime } }) } });
        await tx.previewLineage.update({ where: { id: lineageId }, data: { candidateDeploymentId: deployment.id, candidateGeneration: transition.lineage.generation } });
        actions.push({ type: 'preview-deployment-enqueued', serviceId: service.id, lineageId, deploymentId: deployment.id, workflowJobId: jobId, generation: transition.lineage.generation });
      }
      const delivery = existingDelivery
        ? await tx.webhookEvent.update({ where: { id: existingDelivery.id }, data: { handled: true, errorMessage: null } })
        : await tx.webhookEvent.create({ data: { provider: 'github', eventType: 'pull_request', deliveryId: event.deliveryId, payload: sanitizeJson(maskSecrets({ action: event.action, repositoryId: event.repositoryId, pullRequestNumber: event.pullRequestNumber })), handled: true } });
      await tx.auditLog.upsert({ where: { id: stableId('aud', 'github:preview-webhook', event.deliveryId) }, update: {}, create: { id: stableId('aud', 'github:preview-webhook', event.deliveryId), actorUserId: null, action: 'github:preview-webhook', targetType: 'github-delivery', targetId: event.deliveryId, metadata: sanitizeJson({ action: event.action, actions: actions.map(action => action.type) }) } });
      return { accepted: true, duplicate: false, deliveryId: event.deliveryId, matchedServiceCount: services.length, actions, webhookEvent: delivery };
    });
  }

  async applyNextPreviewObservation(options: Record<string, any> = {}) {
    const workerId = String(options.workerId || 'preview-apply');
    const now = new Date(options.now || Date.now());
    const expiredBefore = new Date(now.getTime() - 60_000);
    return this.prisma.$transaction(async (tx: any) => {
      const job = await tx.workflowJob.findFirst({ where: { type: PREVIEW_APPLY_JOB, attempts: { lt: 3 }, runAfter: { lte: now }, OR: [{ status: 'queued' }, { status: 'running', lockedAt: { lte: expiredBefore } }] }, orderBy: [{ runAfter: 'asc' }, { createdAt: 'asc' }] });
      if (!job) return { processed: false, reason: 'no_ready_preview_observation' };
      const claimed = await tx.workflowJob.updateMany({ where: { id: job.id, type: PREVIEW_APPLY_JOB, attempts: job.attempts, status: job.status, lockedAt: job.lockedAt }, data: { status: 'running', attempts: { increment: 1 }, lockedBy: workerId, lockedAt: now } });
      if (claimed.count !== 1) return { processed: false, reason: 'claim_lost' };
      const lineage = await tx.previewLineage.findUnique({ where: { id: job.targetId } });
      if (!lineage || job.targetType !== 'preview-lineage') {
        await tx.workflowJob.update({ where: { id: job.id }, data: { status: 'cancelled', lockedBy: null, lockedAt: null } });
        return { processed: true, reason: 'stale_preview_observation' };
      }
      let observation;
      try { observation = parsePreviewObservation(lineage.resolutionObservation); }
      catch (error) {
        if (!(error instanceof PreviewError)) throw error;
        await tx.workflowJob.update({ where: { id: job.id }, data: { status: 'failed', lockedBy: null, lockedAt: null, payload: { ...job.payload, terminalReason: 'preview_observation_invalid' } } });
        return { processed: true, reason: 'preview_observation_invalid' };
      }
      if (observation.lineageId !== lineage.id || observation.lineageVersion !== lineage.version) {
        await tx.workflowJob.update({ where: { id: job.id }, data: { status: 'cancelled', lockedBy: null, lockedAt: null } });
        return { processed: true, reason: 'stale_preview_observation' };
      }
      await tx.$queryRawUnsafe('SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1,18))', `preview:organization:${lineage.organizationId}`);
      await tx.$queryRawUnsafe('SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtextextended($1,15))', String(lineage.serviceId));
      const service = await tx.service.findUnique({ where: { id: lineage.serviceId }, include: { project: { include: { organization: true } } } });
      const actionPlan = { kind: observation.state === 'closed' ? 'preview-cleanup' : 'preview-deploy', repositoryId: observation.repositoryId, installationId: observation.installationId, repository: lineage.repository, baseBranch: observation.baseRef };
      const bindingValid = service && !['DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(String(service.status).toUpperCase()) && !['DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(String(service.project?.status).toUpperCase()) && serviceMatchesGitHubWebhook(service, actionPlan);
      const matched = bindingValid ? await servicesForPrismaGitHubWebhook(tx, actionPlan) : [];
      if (!matched.some((candidate: Record<string, any>) => candidate.id === lineage.serviceId)) {
        await tx.workflowJob.update({ where: { id: job.id }, data: { status: 'failed', lockedBy: null, lockedAt: null, payload: { ...job.payload, terminalReason: 'preview_binding_inactive' } } });
        return { processed: true, reason: 'preview_binding_inactive' };
      }
      if (observation.state === 'open') {
        const blocked = await prismaGitHubWebhookQuotaBlocks(tx, [service], actionPlan, []);
        if (blocked.has(String(service.id))) {
          await tx.workflowJob.update({ where: { id: job.id }, data: { status: 'failed', lockedBy: null, lockedAt: null, payload: { ...job.payload, terminalReason: 'preview_quota_blocked' } } });
          return { processed: true, reason: 'preview_quota_blocked' };
        }
      }
      const transition = applyPreviewObservation(previewLineageRecord(lineage), observation);
      await tx.previewLineage.update({ where: { id: lineage.id }, data: previewLineageData(transition.lineage) });
      if (transition.decision === 'open') {
        const deploymentId = stableId('dep', 'github-preview-apply', lineage.id, transition.lineage.version, transition.lineage.generation);
        const runtime = createPreviewRuntime(transition.lineage, deploymentId);
        const deployment = await tx.deployment.create({ data: deploymentData({ id: deploymentId, serviceId: service.id, projectId: service.projectId, commitSha: observation.headSha, commitHash: observation.headSha, status: 'queued', deploymentType: 'preview', triggerType: 'github_preview_resolver', branch: observation.headRef, pullRequestNumber: observation.pullRequestNumber, previewUrl: `https://${lineage.stableHost}`, previewLineageId: lineage.id, previewGeneration: transition.lineage.generation, previewRuntime: runtime, desiredSpecSnapshot: captureDeploymentSnapshot(service), snapshotVersion: 1 }) });
        await tx.workflowJob.create({ data: { id: stableId('job', 'github-preview-apply', lineage.id, transition.lineage.version), ...workflowJobData({ type: 'preview-deploy', targetType: 'deployment', targetId: deployment.id, payload: { version: 1, lineageId: lineage.id, lineageVersion: transition.lineage.version, generation: transition.lineage.generation, deploymentId: deployment.id, desiredSpecSnapshot: deployment.desiredSpecSnapshot, snapshotVersion: 1, runtime } }) } });
        await tx.previewLineage.update({ where: { id: lineage.id }, data: { candidateDeploymentId: deployment.id, candidateGeneration: transition.lineage.generation, resolutionObservation: null, resolutionErrorCode: null } });
      } else if (transition.decision === 'close') {
        const attempts = await tx.deployment.findMany({ where: { previewLineageId: lineage.id } });
        const mutableIds = attempts.filter((attempt: Record<string, any>) => String(attempt.status).toUpperCase() !== 'CLEANED_UP').map((attempt: Record<string, any>) => attempt.id);
        if (mutableIds.length) await tx.deployment.updateMany({ where: { id: { in: mutableIds } }, data: { status: 'PREVIEW_CLEANUP_REQUESTED' } });
        await tx.previewLineage.update({ where: { id: lineage.id }, data: { routeIntent: previewCloseIntent(transition.lineage), resolutionObservation: null, resolutionErrorCode: null } });
      }
      await tx.workflowJob.update({ where: { id: job.id }, data: { status: 'succeeded', lockedBy: null, lockedAt: null, payload: { ...job.payload, appliedVersion: transition.lineage.version } } });
      return { processed: true, lineageId: lineage.id, decision: transition.decision };
    }, { isolationLevel: 'Serializable' });
  }

  async enqueueWorkflowJob(input: Record<string, any>) {
    return this.prisma.workflowJob.create({ data: workflowJobData(input) });
  }

  async claimNextWorkflowJob(options: Record<string, any> = {}) {
    const now = new Date(options.now || Date.now());
    const leaseMs = Number(options.leaseMs ?? (Number(options.leaseSeconds || 300) * 1000));
    const expiredBefore = new Date(now.getTime() - leaseMs);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.prisma.workflowJob.findFirst({
        where: {
          type: { notIn: [
            WORKFLOW_TYPES.PUBLIC_HEALTH_OBSERVE,
            WORKFLOW_TYPES.RESOURCE_BACKUP,
            WORKFLOW_TYPES.RESOURCE_RESTORE,
            WORKFLOW_TYPES.GITHUB_PREVIEW_RESOLVE,
            WORKFLOW_TYPES.GITHUB_PREVIEW_APPLY,
          ] },
          status: 'queued',
          runAfter: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lte: expiredBefore } }],
        },
        orderBy: [{ runAfter: 'asc' }, { createdAt: 'asc' }],
      });
      if (!job) return null;
      const updated = await this.prisma.workflowJob.updateMany({
        where: {
          id: job.id,
          type: { notIn: [
            WORKFLOW_TYPES.PUBLIC_HEALTH_OBSERVE,
            WORKFLOW_TYPES.RESOURCE_BACKUP,
            WORKFLOW_TYPES.RESOURCE_RESTORE,
            WORKFLOW_TYPES.GITHUB_PREVIEW_RESOLVE,
            WORKFLOW_TYPES.GITHUB_PREVIEW_APPLY,
          ] },
          status: 'queued',
          runAfter: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lte: expiredBefore } }],
        },
        data: {
          status: 'running',
          attempts: { increment: 1 },
          lockedBy: options.workerId || options.worker || 'workflow-worker',
          lockedAt: now,
        },
      });
      if (updated.count === 1) return this.prisma.workflowJob.findUnique({ where: { id: job.id } });
    }
    return null;
  }

  async completeWorkflowJob(jobId: string, result: any = {}, options: Record<string, any> = {}) {
    const current = await this.prisma.workflowJob.findUnique({ where: { id: jobId } });
    if (!current) throw new Error(`workflow job not found: ${jobId}`);
    const next = options.record || completeWorkflowJobRecord(current, result, options);
    return this.prisma.workflowJob.update({
      where: { id: jobId },
      data: prismaWorkflowJobUpdateData(next),
    });
  }

  async failWorkflowJob(jobId: string, error: any, options: Record<string, any> = {}) {
    const current = await this.prisma.workflowJob.findUnique({ where: { id: jobId } });
    if (!current) throw new Error(`workflow job not found: ${jobId}`);
    const next = options.record || failWorkflowJobRecord(current, error, options);
    return this.prisma.workflowJob.update({
      where: { id: jobId },
      data: prismaWorkflowJobUpdateData(next),
    });
  }

  async processNextWorkflowJob(handlers: Record<string, any>, options: Record<string, any> = {}) {
    return processNextWorkflowJob(this, handlers, options);
  }


  async approveUser(userId: string, input: Record<string, any> = {}) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    const accountType = normalizeAccountType(input.accountType, current?.accountType || 'NON_CLUB');
    const user = await this.prisma.user.update({ where: { id: userId }, data: { approvalStatus: 'APPROVED', accountType, role: input.role || undefined, sessionVersion: { increment: 1 } } });
    if (accountType === 'NON_CLUB') await this.setQuota({ userId, accountType });
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'user:approve', targetType: 'user', targetId: userId, metadata: maskSecrets({ accountType }) } });
    return redactUser(user);
  }

  async rejectUser(userId: string, input: Record<string, any> = {}) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { approvalStatus: 'REJECTED', sessionVersion: { increment: 1 } } });
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'user:reject', targetType: 'user', targetId: userId, metadata: {} } });
    return redactUser(user);
  }

  async banUser(userId: string, input: Record<string, any> = {}) {
    const actorUserId = auditActorUserId(input.actorUserId);
    if (actorUserId && actorUserId === String(userId)) throw forbiddenError('administrators cannot ban themselves');
    const reason = normalizeBanReason(input.reason);
    const expiresAt = normalizeBanExpiresAt(input.expiresAt);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          bannedAt: new Date(),
          banExpiresAt: expiresAt,
          banReason: reason,
          bannedByUserId: actorUserId,
          sessionVersion: { increment: 1 },
        },
      });
      await tx.auditLog.create({ data: { actorUserId, action: 'user:ban', targetType: 'user', targetId: userId, metadata: maskSecrets({ reason, expiresAt: expiresAt?.toISOString() || null, permanent: expiresAt === null }) } });
      return redactUser(user);
    });
  }

  async unbanUser(userId: string, input: Record<string, any> = {}) {
    const actorUserId = auditActorUserId(input.actorUserId);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { bannedAt: null, banExpiresAt: null, banReason: null, bannedByUserId: null, sessionVersion: { increment: 1 } },
      });
      await tx.auditLog.create({ data: { actorUserId, action: 'user:unban', targetType: 'user', targetId: userId, metadata: {} } });
      return redactUser(user);
    });
  }

  async setQuota(input: Record<string, any>) {
    const accountType = normalizeAccountType(input.accountType);
    return this.prisma.quota.upsert({
      where: { id: input.id || `quota_${input.userId}_${accountType}` },
      update: quotaData({ ...input, accountType }),
      create: { id: input.id || `quota_${input.userId}_${accountType}`, userId: input.userId, accountType, ...quotaData({ ...input, accountType }) },
    });
  }

  async enforceUserCan(input: Record<string, any>) {
    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) return true;
    if (isActiveBan(user)) {
      await this.prisma.auditLog.create({ data: { actorUserId: input.userId, action: 'user:ban-block', targetType: input.action || 'action', targetId: input.metric || input.action || 'unknown', metadata: { reason: user.banReason || 'banned', expiresAt: user.banExpiresAt?.toISOString() || null } } });
      throw forbiddenError(`user ${input.userId} is banned and cannot ${input.action}`);
    }
    if (user.role === 'ADMIN' || user.accountType === 'CLUB_MEMBER') return true;
    if (user.approvalStatus !== 'APPROVED') {
      await this.prisma.auditLog.create({ data: { actorUserId: input.userId, action: 'quota:block', targetType: input.action || 'action', targetId: input.metric || input.action || 'unknown', metadata: { reason: user.approvalStatus || 'PENDING' } } });
      const error = new Error(`user ${input.userId} is ${user.approvalStatus || 'PENDING'} and cannot ${input.action}`);
      (error as any).statusCode = 403;
      throw error;
    }
    const quota = await this.prisma.quota.findFirst({ where: { userId: input.userId, accountType: user.accountType || 'NON_CLUB' } })
      || await this.setQuota({ userId: input.userId, accountType: user.accountType || 'NON_CLUB' });
    if (input.metric && quota[input.metric] !== undefined) {
      const current = (await this.quotaUsageForUser(input.userId))[input.metric] || 0;
      const requested = current + Number(input.increment || 0);
      if (requested > Number(quota[input.metric])) {
        await this.prisma.auditLog.create({ data: { actorUserId: input.userId, action: 'quota:block', targetType: input.action || 'action', targetId: input.metric, metadata: { current, increment: Number(input.increment || 0), limit: quota[input.metric] } } });
        const error = new Error(`quota exceeded: ${input.metric} (${requested}/${quota[input.metric]})`);
        (error as any).statusCode = 403;
        throw error;
      }
    }
    return true;
  }

  async quotaUsageForUser(userId: string) {
    return prismaQuotaUsage(this.prisma, userId);
  }

  async appendBuildLog(input: Record<string, any>) {
    return this.prisma.buildLog.create({ data: { deploymentId: input.deploymentId, step: input.step || 'build', line: maskLogLine(input.line), level: input.level || 'info' } });
  }

  async appendRuntimeLog(input: Record<string, any>) {
    const podName = input.podName || 'local-pod';
    const containerName = input.containerName || 'app';
    const podUid = persistedRuntimePodUid({ podUid: input.podUid, sourceInstanceId: input.sourceInstanceId });
    return this.prisma.runtimeLog.create({ data: { serviceId: input.serviceId, deploymentId: input.deploymentId || null, podName, podUid, containerName, line: maskLogLine(input.line), level: input.level || 'info' } });
  }

  async appendDeploymentEvent(input: Record<string, any>) {
    return this.prisma.deploymentEvent.create({ data: { deploymentId: input.deploymentId, type: input.type || 'deployment.event', message: maskLogLine(input.message), metadata: sanitizeJson(sanitizeLogRecord(input.metadata || {})) } });
  }

  async listDeploymentLogs(deploymentId: string, options: Record<string, any> = {}) { return findActivityRows(this.prisma.buildLog, { deploymentId }, options); }
  async listRuntimeLogs(serviceId: string, options: Record<string, any> = {}) { return findActivityRows(this.prisma.runtimeLog, { serviceId }, options); }
  async logPemContext(rows: readonly ObservationLogRow[]): Promise<ObservationLogContext[]> {
    const sources = pemContextSources(rows);
    const runtimeSources = sources.filter((source): source is RuntimePemContextSource => source.kind === 'runtime');
    const buildSources = sources.filter((source): source is BuildPemContextSource => source.kind === 'build');
    const queryRows: PemContextQueryRow[] = [];
    if (runtimeSources.length) queryRows.push(...await this.prisma.$queryRaw<PemContextQueryRow[]>(runtimePemContextQuery(runtimeSources)));
    if (buildSources.length) queryRows.push(...await this.prisma.$queryRaw<PemContextQueryRow[]>(buildPemContextQuery(buildSources)));
    return pemContextsFromQuery(sources, queryRows);
  }
  async listDeploymentEvents(deploymentId: string, options: Record<string, any> = {}) { return findActivityRows(this.prisma.deploymentEvent, { deploymentId }, options); }

  async runResourceConsoleQuery(resourceId: string, query: string, options: Record<string, any> = {}) {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      const error = new Error(`resource not found: ${resourceId}`);
      (error as any).statusCode = 404;
      throw error;
    }
    const result = await runDbConsoleQuery(await this.resourceForConsole(resource), query, options);
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(options.actorUserId), action: 'resource.console:query', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ queryPreview: redactDbConsoleStatement(query), queryBytes: Buffer.byteLength(String(query || '')), resultRows: (result as any).rowCount || result.rows?.length || 0 }) } });
    return result;
  }

  async runResourceConsoleCommand(resourceId: string, command: string, options: Record<string, any> = {}) {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      const error = new Error(`resource not found: ${resourceId}`);
      (error as any).statusCode = 404;
      throw error;
    }
    const result = await runDbConsoleQuery(await this.resourceForConsole(resource), command, { ...options, providerCommand: true });
    await this.prisma.auditLog.create({ data: { actorUserId: auditActorUserId(options.actorUserId), action: 'resource.console:command', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ commandPreview: redactDbConsoleStatement(command), commandBytes: Buffer.byteLength(String(command || '')), mode: (result as any).mode }) } });
    return result;
  }

  async browseResourceConsole(resourceId: string, options: Record<string, any> = {}) {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      const error = new Error(`resource not found: ${resourceId}`);
      (error as any).statusCode = 404;
      throw error;
    }
    return browseDbConsole(await this.resourceForConsole(resource), options);
  }

  async resourceConsoleView(resourceId: string, view: string, options: Record<string, any> = {}) {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      const error = new Error(`resource not found: ${resourceId}`);
      (error as any).statusCode = 404;
      throw error;
    }
    return resourceConsoleView(await this.resourceForConsole(resource), view, options);
  }

  async resourceForConsole(resource: Record<string, any>) {
    await assertPostgresRecoveryPublished(this.prisma, resource.id);
    return resourceForConsoleWithDb(this.prisma, resource);
  }

  async attachResource({ resourceId, serviceId, envPrefix = null, actorUserId = 'system' }: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      await assertPostgresRecoveryPublished(tx, resourceId);
      const [resource, service] = await Promise.all([
        tx.resource.findUnique({ where: { id: resourceId } }),
        tx.service.findUnique({ where: { id: serviceId } }),
      ]);
      if (!resource) throw Object.assign(new Error(`resource not found: ${resourceId}`), { statusCode: 404 });
      if (!service) throw Object.assign(new Error(`service not found: ${serviceId}`), { statusCode: 404 });
      assertMutable(resource, 'resource');
      assertMutable(service, 'service');
      await requireMutableProject(tx, resource.projectId);
      if (String(resource.projectId) !== String(service.projectId)) throw Object.assign(new Error('resource and service must be in the same project'), { statusCode: 403 });
        const injectedEnv = providerSecretEnvRefs(resource, envPrefix);
        const existing = await tx.resourceAttachment.findUnique({ where: { resourceId_serviceId: { resourceId, serviceId } } });
        const previousKeys = Object.keys(existing?.injectedEnv || {});
      const row = await tx.resourceAttachment.upsert({
        where: { resourceId_serviceId: { resourceId, serviceId } },
          update: { envPrefix, injectedEnv },
          create: { resourceId, serviceId, envPrefix, injectedEnv },
      });
        const secretEnv = mergeSecretEnv(service.desiredSpec?.secretEnv, injectedEnv, previousKeys);
        await tx.service.update({ where: { id: serviceId }, data: { desiredSpec: sanitizeJson({ ...(service.desiredSpec || {}), secretEnv }) } });
        for (const [key, reference] of Object.entries(injectedEnv)) {
          await tx.environmentVariable.upsert({
            where: { serviceId_key: { serviceId, key } },
            update: { projectId: service.projectId, value: null, isSecret: true, valueMasked: '****', secretRef: kubernetesExternalSecretRef(reference), source: `resource:${resourceId}` },
            create: { projectId: service.projectId, serviceId, key, value: null, isSecret: true, valueMasked: '****', secretRef: kubernetesExternalSecretRef(reference), source: `resource:${resourceId}` },
          });
        }
      await tx.auditLog.create({ data: { actorUserId, action: 'resource:attach', targetType: 'service', targetId: serviceId, metadata: maskSecrets({ resourceId, envPrefix, envKeys: Object.keys(injectedEnv) }) } });
      return row;
    }, { isolationLevel: 'Serializable' });
  }

  async removeResourceInjectedEnvironment(attachment: Record<string, any>) {
      const removedKeys = new Set(Object.keys(attachment.injectedEnv || {}));
    for (const key of Object.keys(attachment.injectedEnv || {})) {
      const row = await this.prisma.environmentVariable.findUnique({ where: { serviceId_key: { serviceId: attachment.serviceId, key } } }).catch(() => null);
      if (row?.source !== `resource:${attachment.resourceId}`) continue;
        if (row.secretRef && !String(row.secretRef).startsWith('k8s:')) await this.prisma.secretValue.delete({ where: { id: row.secretRef } }).catch(() => null);
      await this.prisma.environmentVariable.delete({ where: { serviceId_key: { serviceId: attachment.serviceId, key } } }).catch(() => null);
    }
      const service = await this.prisma.service.findUnique({ where: { id: attachment.serviceId } }).catch(() => null);
      if (service) {
        const secretEnv = (Array.isArray(service.desiredSpec?.secretEnv) ? service.desiredSpec.secretEnv : []).filter((entry: any) => !removedKeys.has(String(entry?.name || '')));
        await this.prisma.service.update({ where: { id: attachment.serviceId }, data: { desiredSpec: sanitizeJson({ ...(service.desiredSpec || {}), secretEnv }) } });
      }
  }

  async writeDesiredProject(projectSpec: Record<string, any>) {
    for (const resource of projectSpec.resources || []) requireResourceExecution(normalizeResourceEngine(resource.engine || resource.type));
    const orgInput = projectSpec.organization || null;
    if (Object.hasOwn(projectSpec, 'organizationSlug')) validatedOrganizationRouteSlug(projectSpec.organizationSlug);
    if (orgInput && Object.hasOwn(orgInput, 'slug')) validatedOrganizationRouteSlug(orgInput.slug);
    const requestedOrganizationId = projectSpec.organizationId || projectSpec.orgId || null;
    return serializableTransactionWithRetry(this.prisma, async (tx: any) => {
      const organization = await resolveDesiredOrganization(tx, orgInput, requestedOrganizationId, projectSpec.organizationSlug);
      const projectInput = projectSpec.project || { name: projectSpec.name || projectSpec.slug || 'project', slug: projectSpec.slug || projectSpec.name || 'project', description: projectSpec.description || '' };
      const projectSlug = projectInput.slug || slugInput(projectInput.name);
      const existingProject = typeof tx.project.findUnique === 'function'
        ? await tx.project.findUnique({ where: { organizationId_slug: { organizationId: organization.id, slug: projectSlug } } })
        : null;
      assertMutable(existingProject, 'project');
      const requirements: QuotaRequirement[] = [{ metric: 'maxProjects', increment: existingProject ? 0 : 1 }];
      if (existingProject) {
        for (const service of projectSpec.services || []) {
          const existingService = typeof tx.service.findUnique === 'function'
            ? await tx.service.findUnique({ where: { projectId_slug: { projectId: existingProject.id, slug: service.slug || slugInput(service.name) } } })
            : null;
          requirements.push(...serviceQuotaRequirements(existingService, service));
        }
        for (const resource of projectSpec.resources || []) {
          const existingResource = typeof tx.resource.findUnique === 'function'
            ? await tx.resource.findUnique({ where: { projectId_name: { projectId: existingProject.id, name: resource.name } } }).catch(() => null)
            : null;
          requirements.push(...resourceQuotaRequirements(existingResource, resource));
        }
      } else {
        for (const service of projectSpec.services || []) requirements.push(...serviceQuotaRequirements(null, service));
        for (const resource of projectSpec.resources || []) requirements.push(...resourceQuotaRequirements(null, resource));
      }
      await enforcePrismaQuotaRequirements(tx, projectSpec.actorUserId, 'desired-state:write', requirements);
      const project = await tx.project.upsert({
        where: { organizationId_slug: { organizationId: organization.id, slug: projectSlug } },
        update: { name: projectInput.name || projectSlug, description: projectInput.description || '', status: projectSpec.actorUserId ? 'ACTIVE' : (projectInput.status || 'ACTIVE') },
        create: { organizationId: organization.id, name: projectInput.name || projectSlug, slug: projectSlug, description: projectInput.description || '', status: projectSpec.actorUserId ? 'ACTIVE' : (projectInput.status || 'ACTIVE') },
      });
      const services = [];
      for (const service of projectSpec.services || []) {
        const serviceSlug = service.slug || slugInput(service.name);
        const existingService = typeof tx.service.findUnique === 'function'
          ? await tx.service.findUnique({ where: { projectId_slug: { projectId: project.id, slug: serviceSlug } } })
          : null;
        assertMutable(existingService, 'service');
        assertServiceReplacement(Boolean(existingService && await tx.deployment.findFirst({ where: { serviceId: existingService.id }, select: { id: true } })));
        services.push(await tx.service.upsert({
          where: { projectId_slug: { projectId: project.id, slug: serviceSlug } },
          update: serviceData({ ...service, projectId: project.id }),
          create: { projectId: project.id, name: service.name, slug: serviceSlug, ...serviceData({ ...service, projectId: project.id }) },
        }));
      }
      const resources = [];
      for (const resource of projectSpec.resources || []) {
        const existing = typeof tx.resource.findUnique === 'function'
          ? await tx.resource.findUnique({
            where: { projectId_name: { projectId: project.id, name: resource.name } },
            select: { connectionSecretName: true, status: true, deletionRequestedAt: true, slug: true, desiredSpec: true },
          }).catch(() => null)
          : null;
        assertMutable(existing, 'resource');
        if (String(existing?.status || '').toUpperCase() === 'READY') {
          resources.push(existing);
          continue;
        }
        resources.push(await tx.resource.upsert({
          where: { projectId_name: { projectId: project.id, name: resource.name } },
          update: resourceData({ ...resource, projectId: project.id, slug: resource.slug || existing?.slug }, { connectionSecretName: existing?.connectionSecretName || null, baseDesiredSpec: existing?.desiredSpec || {} }),
          create: { projectId: project.id, name: resource.name, ...resourceData({ ...resource, projectId: project.id }) },
        }));
      }
      await tx.auditLog.create({ data: { actorUserId: auditActorUserId(projectSpec.actorUserId), action: 'desired-state:write', targetType: 'project', targetId: project.id, metadata: maskSecrets(projectSpec) } });
      return { organization, project, services, resources };
    });
  }

  async snapshot() {
    const [organizations, users, members, projects, services, resources, deployments, auditLogs, usageRecords, workflowJobs, quotas, domains, resourceAttachments, buildLogs, runtimeLogs, deploymentEvents, resourceBackups] = await Promise.all([
      this.prisma.organization.findMany(),
      this.prisma.user.findMany(),
      this.prisma.membership.findMany(),
      this.prisma.project.findMany(),
      this.prisma.service.findMany(),
      this.prisma.resource.findMany(),
      this.prisma.deployment.findMany(),
      this.prisma.auditLog.findMany(),
      this.prisma.usageRecord.findMany(),
      this.prisma.workflowJob.findMany(),
      this.prisma.quota.findMany(),
      this.prisma.domain.findMany(),
      this.prisma.resourceAttachment.findMany(),
      this.prisma.buildLog.findMany(),
      this.prisma.runtimeLog.findMany(),
      this.prisma.deploymentEvent.findMany(),
      this.prisma.resourceBackup.findMany(),
    ]);
    const [environmentVariables, githubIntegrations] = await Promise.all([
      this.prisma.environmentVariable.findMany(),
      this.prisma.gitHubIntegration.findMany(),
    ]);
    return deepClone({ organizations, users: users.map(redactUser), members, projects, services, resources, deployments, auditLogs, usageRecords, workflowJobs, quotas, domains, resourceAttachments, resourceBackups, buildLogs, runtimeLogs, deploymentEvents, environmentVariables: environmentVariables.map(maskEnvRow), githubIntegrations });
  }
}

function previewLineageRecord(row: Record<string, any>): PreviewLineageRecord {
  return {
    id: row.id, organizationId: row.organizationId, projectId: row.projectId, serviceId: row.serviceId, integrationId: row.integrationId,
    installationId: row.installationId, repositoryId: row.repositoryId, repository: row.repository, pullRequestNumber: row.pullRequestNumber,
    stableHost: row.stableHost, namespace: row.namespace, routeName: row.routeName, state: row.state,
    version: row.version, generation: row.generation, eventUpdatedAt: new Date(row.eventUpdatedAt).toISOString(), eventAction: row.eventAction,
    headSha: row.headSha, headRef: row.headRef, baseRef: row.baseRef, beforeSha: row.beforeSha,
    candidateDeploymentId: row.candidateDeploymentId, candidateGeneration: row.candidateGeneration,
    currentDeploymentId: row.currentDeploymentId, currentGeneration: row.currentGeneration,
  };
}

function previewLineageData(lineage: PreviewLineageRecord) {
  return { ...lineage, eventUpdatedAt: new Date(lineage.eventUpdatedAt) };
}

async function findActivityRows(model: any, scope: Record<string, any>, options: Record<string, any> = {}) {
  const cursorFilter = prismaKeysetFilter(options, 'timestamp', 'asc');
  const rows = await model.findMany({
    where: cursorFilter ? { AND: [scope, cursorFilter] } : scope,
    orderBy: [{ timestamp: cursorFilter ? 'asc' : 'desc' }, { id: cursorFilter ? 'asc' : 'desc' }],
    take: activityLimit(options.limit),
  });
  return cursorFilter ? rows : rows.reverse();
}

function pemContextSources(rows: readonly ObservationLogRow[]): PemContextSource[] {
  const sources = new Map<string, PemContextSource>();
  for (const row of rows.slice(0, 1000)) {
    if (sources.size >= PEM_CONTEXT_LIMITS.sources) break;
    const source = observationLogSource(row);
    const id = boundedPemIdentity(row.id);
    const timestamp = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp || ''));
    const deploymentId = boundedPemIdentity(row.deploymentId);
    if (!source || !id || !deploymentId || !Number.isFinite(timestamp.getTime()) || sources.has(source)) continue;
    const serviceId = boundedPemIdentity(row.serviceId);
    if (serviceId) {
      const podUid = boundedPemIdentity(row.podUid);
      const containerName = boundedPemIdentity(row.containerName);
      if (podUid && containerName) sources.set(source, { requestId: sources.size + 1, source, kind: 'runtime', serviceId, deploymentId, podUid, containerName, timestamp, id });
      continue;
    }
    const step = boundedPemIdentity(row.step);
    if (step) sources.set(source, { requestId: sources.size + 1, source, kind: 'build', deploymentId, step, timestamp, id });
  }
  return [...sources.values()];
}

export function runtimePemContextQuery(sources: readonly RuntimePemContextSource[]) {
  const values = sources.map((source) => Prisma.sql`(CAST(${source.requestId} AS integer), CAST(${source.serviceId} AS text), CAST(${source.deploymentId} AS text), CAST(${source.podUid} AS text), CAST(${source.containerName} AS text), CAST(${source.timestamp} AS timestamp(3)), CAST(${source.id} AS text))`);
  return Prisma.sql`
    WITH requested("requestId", "serviceId", "deploymentId", "podUid", "containerName", "timestamp", "id") AS MATERIALIZED (VALUES ${Prisma.join(values)})
    SELECT requested."requestId", history."line", history."truncated"
    FROM requested CROSS JOIN LATERAL (
      SELECT clipped."line", clipped."truncated", clipped."timestamp", clipped."id"
      FROM (
        SELECT substring(log."line" FROM 1 FOR CAST(${PEM_CONTEXT_LIMITS.lineCharacters} AS integer)) AS "line",
          substring(log."line" FROM CAST(${PEM_CONTEXT_LIMITS.lineCharacters + 1} AS integer) FOR 1) <> '' AS "truncated",
          log."timestamp", log."id"
        FROM "RuntimeLog" AS log
        WHERE log."serviceId" = requested."serviceId" AND log."deploymentId" = requested."deploymentId"
          AND log."podUid" = requested."podUid" AND log."containerName" = requested."containerName"
          AND log."id" <> requested."id"
          AND (log."timestamp", log."id") < (requested."timestamp", requested."id")
        ORDER BY log."serviceId" ASC, log."deploymentId" ASC, log."podUid" ASC, log."containerName" ASC, log."timestamp" DESC, log."id" DESC
        LIMIT ${PEM_CONTEXT_LIMITS.rowsPerSource + 1}
      ) AS clipped
      WHERE octet_length(clipped."line") <= ${PEM_CONTEXT_LIMITS.lineBytes}
    ) AS history
    ORDER BY requested."requestId", history."timestamp" ASC, history."id" ASC
  `;
}

function buildPemContextQuery(sources: readonly BuildPemContextSource[]) {
  const values = sources.map((source) => Prisma.sql`(CAST(${source.requestId} AS integer), CAST(${source.deploymentId} AS text), CAST(${source.step} AS text), CAST(${source.timestamp} AS timestamp(3)), CAST(${source.id} AS text))`);
  return Prisma.sql`
    WITH requested("requestId", "deploymentId", "step", "timestamp", "id") AS MATERIALIZED (VALUES ${Prisma.join(values)})
    SELECT requested."requestId", history."line", history."truncated"
    FROM requested CROSS JOIN LATERAL (
      SELECT clipped."line", clipped."truncated", clipped."timestamp", clipped."id"
      FROM (
        SELECT substring(log."line" FROM 1 FOR CAST(${PEM_CONTEXT_LIMITS.lineCharacters} AS integer)) AS "line",
          substring(log."line" FROM CAST(${PEM_CONTEXT_LIMITS.lineCharacters + 1} AS integer) FOR 1) <> '' AS "truncated",
          log."timestamp", log."id"
        FROM "BuildLog" AS log
        WHERE log."deploymentId" = requested."deploymentId" AND log."step" = requested."step"
          AND log."id" <> requested."id"
          AND (log."timestamp", log."id") < (requested."timestamp", requested."id")
        ORDER BY log."deploymentId" ASC, log."step" ASC, log."timestamp" DESC, log."id" DESC
        LIMIT ${PEM_CONTEXT_LIMITS.rowsPerSource + 1}
      ) AS clipped
      WHERE octet_length(clipped."line") <= ${PEM_CONTEXT_LIMITS.lineBytes}
    ) AS history
    ORDER BY requested."requestId", history."timestamp" ASC, history."id" ASC
  `;
}

function pemContextsFromQuery(sources: readonly PemContextSource[], rows: readonly PemContextQueryRow[]): ObservationLogContext[] {
  const histories = new Map<number, PemContextQueryRow[]>();
  const withinQueryLimit = rows.length <= PEM_CONTEXT_LIMITS.queryRows;
  for (const row of rows.slice(0, PEM_CONTEXT_LIMITS.queryRows)) {
    if (!Number.isInteger(row.requestId) || row.requestId < 1 || row.requestId > sources.length || typeof row.line !== 'string') continue;
    const history = histories.get(row.requestId) || [];
    if (history.length < PEM_CONTEXT_LIMITS.rowsPerSource + 1) history.push(row);
    histories.set(row.requestId, history);
  }
  return sources.map((source) => {
    const history = histories.get(source.requestId) || [];
    const complete = withinQueryLimit && history.length <= PEM_CONTEXT_LIMITS.rowsPerSource && history.every((row) => row.truncated !== true && Buffer.byteLength(row.line) <= PEM_CONTEXT_LIMITS.lineBytes);
    return { source: source.source, rows: complete ? history.map((row) => ({ line: row.line })) : [], complete };
  });
}

function boundedPemIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const identity = value.trim();
  return identity.length > 0 && identity.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(identity) ? identity : null;
}

async function findKeysetRows(model: any, scope: Record<string, any>, options: Record<string, any> = {}, query: Record<string, any> = {}) {
  const cursorFilter = prismaKeysetFilter(options, 'createdAt', 'desc');
  return model.findMany({
    ...query,
    where: cursorFilter ? { AND: [scope, cursorFilter] } : scope,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: activityLimit(options.limit),
  });
}

function countRowsByProject(rows: Iterable<Record<string, any>>, projectIds: Set<string>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const projectId = String(row.projectId || '');
    if (!projectIds.has(projectId)) continue;
    counts.set(projectId, (counts.get(projectId) || 0) + 1);
  }
  return counts;
}

const QUOTA_USAGE_AGGREGATE_SQL = `
WITH member_orgs AS (
  SELECT "organizationId" FROM "Membership" WHERE "userId" = $1
), scoped_projects AS (
  SELECT p.id FROM "Project" p WHERE p."organizationId" IN (SELECT "organizationId" FROM member_orgs)
), scoped_services AS (
  SELECT s.id, s."desiredSpec", s."desiredState" FROM "Service" s WHERE s."projectId" IN (SELECT id FROM scoped_projects)
), scoped_resources AS (
  SELECT r.id, r.type, r.engine, r."desiredSpec", r."desiredState" FROM "Resource" r WHERE r."projectId" IN (SELECT id FROM scoped_projects)
), daily_deployments AS (
  SELECT d."deploymentType" FROM "Deployment" d
  WHERE d."serviceId" IN (SELECT id FROM scoped_services) AND d."createdAt" >= $2 AND d."createdAt" < $3
), monthly_deployments AS (
  SELECT d."buildStartedAt", d."buildFinishedAt", d."deployedAt", d."finishedAt" FROM "Deployment" d
  WHERE d."serviceId" IN (SELECT id FROM scoped_services) AND (
    (d."buildStartedAt" < $5 AND d."buildFinishedAt" > $4) OR
    (d."deployedAt" < $5 AND (d."finishedAt" IS NULL OR d."finishedAt" > $4))
  )
), scoped_usage AS (
  SELECT u.metric, u.value FROM "UsageRecord" u
  WHERE u."recordedAt" >= $4 AND u."recordedAt" < $5 AND (
    u."userId" = $1 OR
    u."organizationId" IN (SELECT "organizationId" FROM member_orgs) OR
    u."projectId" IN (SELECT id FROM scoped_projects) OR
    u."serviceId" IN (SELECT id FROM scoped_services) OR
    u."resourceId" IN (SELECT id FROM scoped_resources)
  )
)
SELECT
  (SELECT COUNT(*)::int FROM scoped_projects) AS "maxProjects",
  (SELECT COUNT(*)::int FROM scoped_services) AS "maxServices",
  (SELECT COUNT(*)::int FROM daily_deployments) AS "maxDeploymentsPerDay",
  (SELECT COUNT(*)::int FROM daily_deployments WHERE LOWER("deploymentType") = 'preview') AS "maxPreviewDeployments",
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('desiredSpec', "desiredSpec", 'desiredState', "desiredState")), '[]'::jsonb) FROM scoped_services) AS services,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('type', type, 'engine', engine, 'desiredSpec', "desiredSpec", 'desiredState', "desiredState")), '[]'::jsonb) FROM scoped_resources) AS resources,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('buildStartedAt', "buildStartedAt", 'buildFinishedAt', "buildFinishedAt", 'deployedAt', "deployedAt", 'finishedAt', "finishedAt")), '[]'::jsonb) FROM monthly_deployments) AS deployments,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('metric', metric, 'value', value)), '[]'::jsonb) FROM scoped_usage) AS "usageRecords"
`;

function quotaUsageFromAggregate(row: Record<string, any>, month: ReturnType<typeof utcMonthBounds>) {
  const services = jsonArray(row.services);
  const resources = jsonArray(row.resources);
  const deployments = jsonArray(row.deployments);
  const usageRecords = jsonArray(row.usageRecords);
  return {
    maxProjects: Number(row.maxProjects || 0),
    maxServices: Number(row.maxServices || 0),
    maxDeploymentsPerDay: Number(row.maxDeploymentsPerDay || 0),
    maxPreviewDeployments: Number(row.maxPreviewDeployments || 0),
    maxDbStorageMb: resources.filter((resource) => resourceQuotaMetric(resource) === 'maxDbStorageMb').reduce((sum, resource) => sum + resourceStorageMb(resource, { includeDesiredState: true }), 0),
    maxObjectStorageMb: resources.filter((resource) => resourceQuotaMetric(resource) === 'maxObjectStorageMb').reduce((sum, resource) => sum + resourceStorageMb(resource, { includeDesiredState: true }), 0),
    maxBuildMinutesPerMonth: usageMetricSum(usageRecords, ['build-minutes', 'build_minutes', 'buildMinutes', 'maxBuildMinutesPerMonth']) + deployments.reduce((sum, deployment) => sum + deploymentBuildMinutesWithin(deployment, month.start, month.end), 0),
    maxRuntimeHoursPerMonth: usageMetricSum(usageRecords, ['runtime-hours', 'runtime_hours', 'runtimeHours', 'app-runtime-hours', 'maxRuntimeHoursPerMonth']) + deployments.reduce((sum, deployment) => sum + deploymentRuntimeHoursWithin(deployment, month.start, month.end), 0),
    maxCpuMillicores: services.reduce((sum, service) => sum + serviceCpuMillicores(service), 0),
    maxMemoryMb: services.reduce((sum, service) => sum + serviceMemoryMb(service), 0),
  };
}

function jsonArray(value: any): Record<string, any>[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function prismaClientOptions(input: Record<string, any>, env: Record<string, any>) {
  const queryTimeoutMs = boundedInteger(env.RAIBITSERVER_DB_QUERY_TIMEOUT_MS, 15_000, 1_000, 60_000);
  const maxWaitMs = boundedInteger(env.RAIBITSERVER_DB_MAX_WAIT_MS, 5_000, 1_000, 30_000);
  const transactionOptions = {
    maxWait: boundedInteger(input.transactionOptions?.maxWait, maxWaitMs, 1_000, 30_000),
    timeout: boundedInteger(input.transactionOptions?.timeout, queryTimeoutMs, 1_000, 60_000),
    ...(input.transactionOptions?.isolationLevel ? { isolationLevel: input.transactionOptions.isolationLevel } : {}),
  };
  const datasourceUrl = input.datasourceUrl || env.DATABASE_URL;
  if (!datasourceUrl || input.datasources) return { ...input, transactionOptions };
  let url: URL;
  try {
    url = new URL(String(datasourceUrl));
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  url.searchParams.set('connection_limit', String(boundedInteger(env.RAIBITSERVER_DB_POOL_SIZE, 10, 1, 50)));
  url.searchParams.set('pool_timeout', String(boundedInteger(env.RAIBITSERVER_DB_POOL_TIMEOUT_SECONDS, 10, 1, 60)));
  url.searchParams.set('connect_timeout', String(boundedInteger(env.RAIBITSERVER_DB_CONNECT_TIMEOUT_SECONDS, 5, 1, 30)));
  url.searchParams.set('socket_timeout', String(Math.ceil(queryTimeoutMs / 1_000)));
  return { ...input, datasourceUrl: url.toString(), transactionOptions };
}

function boundedInteger(value: any, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function resolveControlPlaneRepositoryConfig(options: Record<string, any> = {}, env: Record<string, any> = process.env) {
  const rawKind = String(options.kind || env.RAIBITSERVER_PERSISTENCE || '').trim().toLowerCase();
  const production = env.NODE_ENV === 'production';
  const kind = rawKind || (production ? 'prisma' : 'memory');
  if (!['memory', 'prisma'].includes(kind)) throw new Error(`unsupported RAIBITSERVER_PERSISTENCE kind: ${kind}`);
  if (production && kind === 'memory' && env.RAIBITSERVER_ALLOW_MEMORY_PERSISTENCE !== '1') {
    throw new Error('in-memory persistence is disabled in production; set RAIBITSERVER_PERSISTENCE=prisma with DATABASE_URL');
  }
  if (production && kind === 'prisma') {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for production Prisma persistence');
    if (!secretEncryptionConfigured(env)) throw new Error('RAIBITSERVER_SECRET_ENCRYPTION_KEY must be at least 32 characters for production Prisma persistence');
  }
  return { kind, production };
}

export async function createControlPlaneRepository(options: Record<string, any> = {}) {
  const env = options.env || process.env;
  const { kind } = resolveControlPlaneRepositoryConfig(options, env);
  if (kind === 'prisma') {
    return PrismaControlPlaneRepository.connect(options);
  }
  return new InMemoryControlPlaneRepository(options.store);
}

const deletionRequestedStatus = 'DELETE_REQUESTED';
const deletionStatuses = [deletionRequestedStatus, 'DELETING'];
const terminalDeploymentStatuses = terminalLifecycleInputs(LIFECYCLE_CONTRACT.machines.deployment.states, LIFECYCLE_CONTRACT.machines.deployment.aliases);
const terminalWorkflowStatuses = terminalLifecycleInputs(LIFECYCLE_CONTRACT.machines.workflow.states, LIFECYCLE_CONTRACT.machines.workflow.aliases);

function isDeleting(row: Record<string, any> | null | undefined) {
  return deletionStatuses.includes(String(row?.status || '').toUpperCase());
}

function assertMutable(row: Record<string, any> | null | undefined, kind: string) {
  if (row && isDeleting(row)) throw conflictError(`${kind} is being deleted`);
}

async function requireMutableProject(db: any, projectId: any) {
  const project = await db.project.findUnique({ where: { id: String(projectId) } });
  if (!project) throw notFoundError(`project not found: ${projectId}`);
  assertMutable(project, 'project');
  return project;
}

async function revokeResourceAttachments(tx: any, resourceIds: string[]) {
  if (!resourceIds.length) return 0;
  const attachments = await tx.resourceAttachment.findMany({ where: { resourceId: { in: resourceIds } } });
  const injectedRows: Record<string, any>[] = [];
  for (const attachment of attachments) {
    const keys = Object.keys(attachment.injectedEnv || {});
    if (!keys.length) continue;
    const rows = await tx.environmentVariable.findMany({ where: { serviceId: attachment.serviceId, key: { in: keys }, source: `resource:${attachment.resourceId}` } });
    injectedRows.push(...rows);
  }
    const injectedSecretIds = injectedRows.map((row) => row.secretRef).filter((value) => value && !String(value).startsWith('k8s:'));
  if (injectedSecretIds.length) await tx.secretValue.deleteMany({ where: { id: { in: injectedSecretIds } } });
  if (injectedRows.length) await tx.environmentVariable.deleteMany({ where: { id: { in: injectedRows.map((row) => row.id) } } });
    for (const attachment of attachments) {
      const removedKeys = new Set(Object.keys(attachment.injectedEnv || {}));
      if (!removedKeys.size || typeof tx.service?.findUnique !== 'function' || typeof tx.service?.update !== 'function') continue;
      const service = await tx.service.findUnique({ where: { id: attachment.serviceId } });
      if (!service || !Array.isArray(service.desiredSpec?.secretEnv)) continue;
      const secretEnv = service.desiredSpec.secretEnv.filter((entry: any) => !removedKeys.has(String(entry?.name || '')));
      await tx.service.update({ where: { id: attachment.serviceId }, data: { desiredSpec: sanitizeJson({ ...(service.desiredSpec || {}), secretEnv }) } });
    }
  await tx.resourceAttachment.deleteMany({ where: { resourceId: { in: resourceIds } } });
  return attachments.length;
}

async function cancelDeletionWork(tx: any, scope: Record<string, any>) {
  const deploymentWhere: Record<string, any> = { status: { notIn: terminalDeploymentStatuses } };
  if (scope.serviceIds?.length) deploymentWhere.serviceId = { in: scope.serviceIds };
  else if (scope.projectId) deploymentWhere.projectId = scope.projectId;
  if (tx.deployment?.updateMany) {
    await tx.deployment.updateMany({
      where: deploymentWhere,
      data: {
        status: 'CANCELLED',
        finishedAt: new Date(),
        errorCode: 'PARENT_DELETE_REQUESTED',
        errorMessage: 'Deployment cancelled because its parent is being deleted',
        reconcileAction: null,
        reconcileLockedBy: null,
        reconcileLockedAt: null,
      },
    });
  }
  const targets = [
    ...(scope.projectId ? [{ targetType: 'project', targetId: scope.projectId }] : []),
    ...(scope.serviceIds || []).map((targetId: string) => ({ targetType: 'service', targetId })),
    ...(scope.resourceIds || []).map((targetId: string) => ({ targetType: 'resource', targetId })),
    ...(scope.deploymentIds || []).map((targetId: string) => ({ targetType: 'deployment', targetId })),
  ];
  if (targets.length && tx.workflowJob?.updateMany) {
    await tx.workflowJob.updateMany({
      where: { status: { notIn: terminalWorkflowStatuses }, OR: targets },
      data: { status: 'cancelled', lockedBy: null, lockedAt: null },
    });
  }
}

async function upsertServiceEnvironmentWithDb(db: any, input: Record<string, any>) {
  const { normalizeEnvEntries } = await import('./env-file.ts');
  const normalizedEntries = normalizeEnvEntries(input.entries || [], { source: input.source || 'api' });
  const desiredSpec = input.desiredSpec && typeof input.desiredSpec === 'object' && !Array.isArray(input.desiredSpec)
    ? { ...input.desiredSpec }
    : {};
  const runtimeEnv = desiredSpec.env && typeof desiredSpec.env === 'object' && !Array.isArray(desiredSpec.env)
    ? { ...desiredSpec.env }
    : {};
  const rows = [];
  for (const entry of normalizedEntries) {
    let secretRef = (entry as any).secretId || null;
    if (entry.isSecret) {
      const secret = await db.secretValue.upsert({
        where: { scopeType_scopeId_key: { scopeType: 'service', scopeId: input.serviceId, key: entry.key } },
        update: { sealedValue: sealSecret(entry.value), valueMasked: maskSecretValue(entry.value), metadata: maskSecrets({ source: entry.source || input.source || 'api' }) },
        create: { scopeType: 'service', scopeId: input.serviceId, key: entry.key, sealedValue: sealSecret(entry.value), valueMasked: maskSecretValue(entry.value), metadata: maskSecrets({ source: entry.source || input.source || 'api' }) },
      });
      secretRef = secret.id;
    }
    const data = envVariableData({ ...entry, projectId: input.projectId, serviceId: input.serviceId, source: entry.source || input.source || 'api', secretRef });
    const row = await db.environmentVariable.upsert({
      where: { serviceId_key: { serviceId: input.serviceId, key: data.key } },
      update: data,
      create: data,
    });
    if (entry.isSecret) delete runtimeEnv[entry.key];
    else runtimeEnv[entry.key] = entry.value;
    rows.push(row);
  }
  if (Object.keys(runtimeEnv).length) desiredSpec.env = runtimeEnv;
  else delete desiredSpec.env;
  await db.service.update({ where: { id: input.serviceId }, data: { desiredSpec: sanitizeJson(desiredSpec) } });
  await db.auditLog.create({ data: { actorUserId: auditActorUserId(input.actorUserId), action: 'service.env:upsert', targetType: 'service', targetId: input.serviceId, metadata: maskSecrets({ keys: rows.map((row) => row.key) }) } });
  return { serviceId: input.serviceId, entries: rows.map(maskEnvRow), plainCount: rows.filter((row) => !row.isSecret).length, secretCount: rows.filter((row) => row.isSecret).length };
}

async function resourceForConsoleWithDb(db: any, resource: Record<string, any>) {
  const secrets = await db.secretValue.findMany({ where: { scopeType: 'resource-provider-connection', scopeId: resource.id } });
  const env: Record<string, string> = {};
  let live = false;
  for (const secret of secrets) {
    if (!isProviderConnectionSecret(secret, resource.id)) continue;
    if (secret.sealedValue) env[secret.key] = openSecret(secret.sealedValue);
    if (secret.metadata?.live === true) live = true;
  }
  if (!Object.keys(env).length) return resource;
  return { ...resource, providerConnection: providerConnectionFromEnv(env, resource.engine, live) };
}

function slugInput(value: any) {
  return String(value || 'item').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function projectUpdateData(input: Record<string, any> = {}) {
  const data: Record<string, any> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description || '';
  return data;
}

async function resolveDesiredOrganization(tx: any, orgInput: Record<string, any> | null, requestedOrganizationId: any, organizationSlug: any) {
  if (requestedOrganizationId) {
    const byId = await tx.organization.findUnique({ where: { id: String(requestedOrganizationId) } });
    if (byId) return byId;
    const bySlug = await tx.organization.findUnique({ where: { slug: slugInput(requestedOrganizationId) } });
    if (bySlug) return bySlug;
    const error = new Error(`organization not found: ${requestedOrganizationId}`);
    (error as any).statusCode = 404;
    throw error;
  }
  const desired = orgInput || { name: organizationSlug || 'default', slug: organizationSlug || 'default', plan: 'free' };
  const slug = Object.hasOwn(desired, 'slug')
    ? validatedOrganizationRouteSlug(desired.slug)
    : slugInput(desired.name);
  return tx.organization.upsert({
    where: { slug },
    update: { name: desired.name || slug, plan: desired.plan || 'free' },
    create: { name: desired.name || slug, slug, plan: desired.plan || 'free' },
  });
}

function serviceData(input: Record<string, any>, options: Record<string, any> = {}) {
  const safe = sanitizeTenantServiceInput(input, { allowGitHubBinding: options.allowGitHubBinding === true });
  const desiredState = options.allowGitHubBinding === true && input.desiredState && typeof input.desiredState === 'object' && !Array.isArray(input.desiredState)
    ? { ...safe, ...input.desiredState }
    : safe;
  return {
    type: safe.type || 'web',
    runtimeType: safe.runtimeType || 'container',
    sourceType: safe.sourceType || 'github',
    buildMode: safe.buildMode || 'AUTO',
    repoUrl: safe.repoUrl || null,
    githubRepositoryId: safe.githubRepositoryId || null,
    branch: safe.branch || null,
    rootDirectory: safe.rootDirectory || null,
    buildContext: safe.buildContext || null,
    dockerfilePath: safe.dockerfilePath || null,
    installCommand: safe.installCommand || null,
    buildCommand: safe.buildCommand || null,
    startCommand: safe.startCommand || null,
    outputDirectory: safe.outputDirectory || null,
    image: safe.image || null,
    imageUrl: safe.imageUrl || safe.image || null,
    port: safe.port ? Number(safe.port) : null,
    ...Object.fromEntries(HEALTH_PATH_FIELDS.map(field => [field, safe[field] ?? null])),
    status: 'created',
    desiredSpec: sanitizeJson(safe.desiredSpec || safe),
    desiredState: sanitizeJson(desiredState),
  };
}

function resourceData(input: Record<string, any>, options: Record<string, any> = {}) {
  const safe = sanitizeTenantResourceInput(input);
  const engine = normalizeResourceEngine(safe.engine || input.engine || safe.type);
  const resourceExecution = requireResourceExecution(engine);
  const id = input.id || stableId('res', safe.projectId, resourceNameFallback(safe.name) || safe.name);
  const sqlitePath = engine === 'sqlite' ? (input.sqlitePath || input.desiredSpec?.sqlitePath || options.baseDesiredSpec?.sqlitePath || providerOwnedSqlitePath(id)) : null;
  const canonicalSpec = canonicalizeProviderDesiredSpec(safe, { baseSpec: options.baseDesiredSpec || {}, rejectUnknown: false });
  const desiredSpec = sqlitePath ? { ...canonicalSpec, sqlitePath } : canonicalSpec;
  const desiredState = { ...(options.currentDesiredState || {}), ...safe, engine, desiredSpec, sqlitePath: sqlitePath || undefined, resourceExecution };
  return {
    slug: safe.slug || resourceNameFallback(safe.name) || slugInput(safe.name),
    type: safe.type || resourceTypeForEngine(engine),
    engine,
    provider: safe.provider || 'shared-provider',
    plan: safe.plan || 'shared-small',
    region: safe.region || 'local',
    version: safe.version || null,
    status: safe.status || 'provisioning',
    desiredSpec: sanitizeJson(desiredSpec),
    desiredState: sanitizeJson(desiredState),
    connectionSecretName: options.connectionSecretName || undefined,
  };
}


function serviceUpdateData(input: Record<string, any> = {}, options: Record<string, any> = {}) {
  const inputSafe = sanitizeTenantServiceUpdate(input, options);
  const allowed = ['name', 'type', 'runtimeType', 'sourceType', 'buildMode', 'repoUrl', 'githubRepositoryId', 'branch', 'rootDirectory', 'buildContext', 'dockerfilePath', 'installCommand', 'buildCommand', 'startCommand', 'outputDirectory', 'image', 'imageUrl', 'port', ...HEALTH_PATH_FIELDS];
  const data: Record<string, any> = {};
  if (options.mutation === INTERNAL_SERVICE_MUTATION && input.status !== undefined) data.status = input.status;
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(inputSafe || {}, key)) continue;
    const value = inputSafe[key] === '' ? null : inputSafe[key];
    data[key] = key === 'port' && value !== null && value !== undefined ? Number(value) : value;
  }
  if (inputSafe.slug !== undefined) data.slug = slugInput(inputSafe.slug);
  if (Object.prototype.hasOwnProperty.call(inputSafe || {}, 'image') && !Object.prototype.hasOwnProperty.call(inputSafe || {}, 'imageUrl')) data.imageUrl = data.image;
  if (Object.prototype.hasOwnProperty.call(inputSafe || {}, 'imageUrl') && !Object.prototype.hasOwnProperty.call(inputSafe || {}, 'image')) data.image = data.imageUrl;
  if (Object.prototype.hasOwnProperty.call(inputSafe || {}, 'desiredSpec')) data.desiredSpec = sanitizeJson(inputSafe.desiredSpec || {});
  const health = parseHealthPaths(inputSafe);
  if (Object.keys(health).length) data.desiredSpec = sanitizeJson({ ...(options.currentDesiredSpec || {}), ...health });
  if (Object.keys(inputSafe || {}).length && !data.desiredState) {
    const currentDesiredState = options.currentDesiredState && typeof options.currentDesiredState === 'object' && !Array.isArray(options.currentDesiredState)
      ? options.currentDesiredState
      : {};
    data.desiredState = sanitizeJson({ ...currentDesiredState, ...inputSafe });
  }
  return data;
}

function deploymentUpdateData(input: Record<string, any> = {}, current: Record<string, any> = {}) {
  const allowed = ['imageUrl', 'imageDigest', 'buildStartedAt', 'buildFinishedAt', 'deployedAt', 'finishedAt', 'errorCode', 'errorMessage', 'previewUrl'];
  const data: Record<string, any> = {};
  if (input.image && !input.imageUrl) data.imageUrl = input.image;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'status')) {
    const status = normalizeDeploymentStatus(input.status);
    data.status = status;
    const now = new Date();
    if (status === 'BUILDING' && !current.buildStartedAt && !input.buildStartedAt) data.buildStartedAt = now;
    if (status === 'IMAGE_READY' && !input.buildFinishedAt) data.buildFinishedAt = now;
    if (status === 'DEPLOYING' && !current.deployedAt && !input.deployedAt) data.deployedAt = now;
    if (status === 'READY') {
      if (!input.deployedAt) data.deployedAt = current.deployedAt || now;
      if (!input.finishedAt) data.finishedAt = now;
      if (!Object.prototype.hasOwnProperty.call(input, 'errorCode')) data.errorCode = null;
      if (!Object.prototype.hasOwnProperty.call(input, 'errorMessage')) data.errorMessage = null;
    }
    if ((status === 'FAILED' || status === 'BUILD_FAILED' || status === 'CANCELLED') && !input.finishedAt) data.finishedAt = now;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, key)) continue;
    if (['buildStartedAt', 'buildFinishedAt', 'deployedAt', 'finishedAt'].includes(key)) data[key] = input[key] ? new Date(input[key]) : null;
    else data[key] = key === 'errorMessage' ? maskLogLine(input[key]) : (input[key] === '' ? null : input[key]);
  }
  return data;
}

function maskLogLine(value: any) {
  return sanitizeLogRecord(String(value ?? ''));
}

function deploymentData(input: Record<string, any>) {
  if (!input.projectId) throw new Error('projectId is required for deployment persistence');
  return compactData({
    id: input.id,
    ...INITIAL_DEPLOYMENT_HEALTH,
    serviceId: input.serviceId,
    projectId: input.projectId,
    commitSha: input.commitSha || input.commitHash || null,
    sourceDeploymentId: input.sourceDeploymentId ?? null,
    retryOfDeploymentId: input.retryOfDeploymentId ?? null,
    requestIdempotencyKey: input.requestIdempotencyKey ?? null,
    desiredSpecSnapshot: input.desiredSpecSnapshot,
    requestedByUserId: input.requestedByUserId ?? input.actorUserId ?? null,
    snapshotVersion: input.snapshotVersion ?? null,
    commitHash: input.commitHash || input.commitSha || null,
    imageUrl: input.imageUrl || input.image || null,
    imageDigest: input.imageDigest || null,
    status: normalizeDeploymentStatus(input.status || 'queued'),
    deploymentType: input.deploymentType || 'production',
    triggerType: input.triggerType || 'manual',
    branch: input.branch || 'main',
    pullRequestNumber: input.pullRequestNumber ? Number(input.pullRequestNumber) : null,
    previewUrl: input.previewUrl || null,
    previewLineageId: input.previewLineageId ?? null,
    previewGeneration: input.previewGeneration ?? null,
    previewRuntime: input.previewRuntime,
    previewOwnedObjects: input.previewOwnedObjects,
    errorCode: input.errorCode || null,
    errorMessage: input.errorMessage ? maskLogLine(input.errorMessage) : null,
    buildStartedAt: input.buildStartedAt ? new Date(input.buildStartedAt) : undefined,
    buildFinishedAt: input.buildFinishedAt ? new Date(input.buildFinishedAt) : undefined,
    deployedAt: input.deployedAt ? new Date(input.deployedAt) : undefined,
    finishedAt: input.finishedAt ? new Date(input.finishedAt) : undefined,
  });
}

function compactData(input: Record<string, any>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function providerPlanPlaceholders() {
  return {
    password: '<generated-by-go-provisioner>', apiKey: '<generated-by-go-provisioner>',
    accessKey: '<generated-by-go-provisioner>', secretKey: '<generated-by-go-provisioner>',
    generatePassword: false,
  };
}

function mergeSecretEnv(current: any, injectedEnv: Record<string, any>, replaceKeys: string[] = []) {
  const replacing = new Set(replaceKeys);
  const rows = (Array.isArray(current) ? current : []).filter((entry: any) => !replacing.has(String(entry?.name || '')));
  const byName = new Map(rows.map((entry: any) => [String(entry.name), entry]));
  for (const [name, reference] of Object.entries(injectedEnv)) byName.set(name, { name, ...(reference as Record<string, any>) });
  return [...byName.values()];
}

function canonicalPrismaGitHubRepositoryRecord(input: Record<string, any>) {
  const installationId = String(input.installationId || '').trim();
  const githubRepoId = String(input.githubRepoId || input.repositoryId || '').trim();
  if (!installationId) throw badRequestError('GitHub repository installationId is required');
  if (!githubRepoId) throw badRequestError('GitHub repository githubRepoId is required');
  const parsed = parseGitHubRepository(input.fullName || (input.owner && input.name ? `${input.owner}/${input.name}` : ''));
  const owner = parsed.owner.toLowerCase();
  const name = parsed.repo.toLowerCase();
  return {
    installationId,
    githubRepoId,
    owner,
    name,
    fullName: `${owner}/${name}`,
    defaultBranch: String(input.defaultBranch || 'main'),
    private: input.private === true,
  };
}

async function requireVerifiedPrismaGitHubIntegration(db: any, integrationId: any, organizationId: any) {
  const id = String(integrationId || '').trim();
  const integration = id ? await db.gitHubIntegration.findUnique({ where: { id } }) : null;
  if (!integration) throw notFoundError(`GitHub integration not found: ${id || '<missing>'}`);
  if (String(integration.organizationId) !== String(organizationId)) throw forbiddenError('GitHub integration does not belong to project organization');
  if (!integration.verifiedAt || !integration.installationId) throw forbiddenError('repository attachment requires a verified GitHub App installation');
  return integration;
}

async function resolvePrismaGitHubRepository(db: any, installationId: any, selector: Record<string, any>) {
  const rows = await db.gitHubRepository.findMany({ where: { installationId: String(installationId) } });
  const repositoryId = String(selector.repositoryId || selector.githubRepositoryId || '').trim();
  const requested = selector.repoUrl || selector.repository;
  if (!repositoryId && !requested) throw badRequestError('GitHub repositoryId or repository selector is required');
  const requestedFullName = requested ? parseGitHubRepository(requested).fullName.toLowerCase() : '';
  const row = rows.find((candidate: Record<string, any>) => {
    const idMatches = !repositoryId || repositoryId === String(candidate.githubRepoId) || repositoryId === String(candidate.id);
    const nameMatches = !requestedFullName || requestedFullName === String(candidate.fullName).toLowerCase();
    return idMatches && nameMatches;
  });
  if (!row) throw forbiddenError('repository is not available to the selected GitHub installation');
  const parsed = parseGitHubRepository(row.fullName);
  return { ...row, owner: parsed.owner.toLowerCase(), repo: parsed.repo.toLowerCase(), fullName: parsed.fullName.toLowerCase(), repoUrl: `https://github.com/${parsed.fullName.toLowerCase()}.git` };
}

function prismaGitHubServiceBinding(integration: Record<string, any>, repository: Record<string, any>) {
  const github = {
    integrationId: integration.id,
    installationId: String(integration.installationId),
    repositoryId: String(repository.githubRepoId),
    repositoryRecordId: String(repository.id),
    repository: repository.fullName,
    repoUrl: repository.repoUrl,
    visibility: repository.private === true ? 'private' : 'public',
  };
  return {
    githubIntegrationId: github.integrationId,
    githubInstallationId: github.installationId,
    githubRepositoryId: github.repositoryId,
    githubRepository: github.repository,
    githubRepositoryVisibility: github.visibility,
    sourceAccess: github.visibility === 'private' ? 'github-app-private' : 'github-app-public',
    github,
  };
}

function publicPrismaGitHubRepository(repository: Record<string, any>) {
  const parsed = parseGitHubRepository(repository.fullName);
  return {
    id: String(repository.githubRepoId),
    githubRepoId: String(repository.githubRepoId),
    fullName: parsed.fullName.toLowerCase(),
    repoUrl: `https://github.com/${parsed.fullName.toLowerCase()}.git`,
    defaultBranch: repository.defaultBranch || 'main',
    private: repository.private === true,
  };
}

function assertPrismaGitHubBindingImmutable(current: Record<string, any>, updates: Record<string, any>) {
  const desired = current.desiredState || {};
  const github = desired.github || {};
  const expected = {
    githubIntegrationId: desired.githubIntegrationId || github.integrationId,
    githubInstallationId: desired.githubInstallationId || github.installationId,
    githubRepositoryId: current.githubRepositoryId || desired.githubRepositoryId || github.repositoryId,
    githubRepository: desired.githubRepository || github.repository,
    githubRepositoryVisibility: desired.githubRepositoryVisibility || github.visibility,
    repoUrl: current.repoUrl || github.repoUrl,
    sourceType: current.sourceType || 'github',
  };
  if (!expected.githubRepositoryId) return;
  const candidates = [updates, updates?.desiredSpec, updates?.desiredState, updates?.desiredState?.github].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  for (const candidate of candidates) {
    for (const key of ['githubIntegrationId', 'githubInstallationId', 'githubRepositoryId', 'githubRepository', 'githubRepositoryVisibility', 'repoUrl', 'sourceType']) {
      const candidateKey = candidate === updates?.desiredState?.github
        ? ({ githubIntegrationId: 'integrationId', githubInstallationId: 'installationId', githubRepositoryId: 'repositoryId', githubRepository: 'repository', githubRepositoryVisibility: 'visibility', repoUrl: 'repoUrl', sourceType: 'sourceType' } as Record<string, string>)[key]
        : key;
      if (!candidateKey || !Object.prototype.hasOwnProperty.call(candidate, candidateKey)) continue;
      let actual = candidate[candidateKey];
      let wanted = expected[key as keyof typeof expected];
      if (key === 'repoUrl') {
        actual = parseGitHubRepository(String(actual)).repoUrl.toLowerCase();
        wanted = parseGitHubRepository(String(wanted)).repoUrl.toLowerCase();
      } else if (key === 'githubRepository') {
        actual = parseGitHubRepository(String(actual)).fullName.toLowerCase();
        wanted = parseGitHubRepository(String(wanted)).fullName.toLowerCase();
      }
      if (String(actual) !== String(wanted)) throw conflictError('GitHub repository binding is immutable; create a new service to use another repository');
    }
  }
}

function uniquePrismaRepositories(services: Array<Record<string, any>>) {
  const byRepository = new Map();
  for (const service of services) {
    const desired = service.desiredState || {};
    const repository = desired.githubRepository || desired.github?.repository || service.repoUrl;
    if (!repository) continue;
    let parsed: Record<string, any>;
    try {
      parsed = parsePrismaRepository(repository);
    } catch {
      continue;
    }
    const existing = byRepository.get(parsed.fullName);
    byRepository.set(parsed.fullName, existing
      ? { ...existing, serviceIds: [...new Set([...(existing.serviceIds || []), service.id])] }
      : { id: stableId('ghr', parsed.fullName), fullName: parsed.fullName, repoUrl: parsed.repoUrl, defaultBranch: service.branch || 'main', serviceIds: [service.id] });
  }
  return [...byRepository.values()];
}

async function servicesForPrismaGitHubRepository(prisma: any, repository: any, scope: Record<string, any> = {}) {
  const normalized = normalizePrismaRepositoryId(repository);
  if (!normalized) return [];
  const organizationIds = organizationScopeArray(scope);
  const services = await prisma.service.findMany({
    where: { repoUrl: { not: null } },
    include: { project: { include: { organization: true } } },
  });
  return services.filter((service: Record<string, any>) => !organizationIds.length || organizationIds.includes(String(service.project?.organizationId))).filter((service: Record<string, any>) => {
    const desired = service.desiredState || {};
    const candidate = desired.githubRepository || desired.github?.repository || service.repoUrl || '';
    return normalizePrismaRepositoryId(candidate) === normalized;
  });
}

function normalizePrismaRepositoryId(value: any) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return parsePrismaRepository(text).fullName.toLowerCase();
  } catch {
    return text.toLowerCase().replace(/^github:/, '');
  }
}

function parsePrismaRepository(value: any) {
  const text = String(value || '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/i, '');
  const [owner, repo] = text.split('/');
  if (!owner || !repo) throw new Error('invalid repository');
  return { fullName: `${owner}/${repo}`, repoUrl: `https://github.com/${owner}/${repo}.git` };
}


function workflowJobData(input: Record<string, any>) {
  return {
    type: input.type || 'build-and-deploy',
    status: input.status || 'queued',
    targetType: input.targetType || 'deployment',
    targetId: input.targetId || input.deploymentId || input.serviceId,
    payload: sanitizeJson(input.payload || {}),
    attempts: Number(input.attempts || 0),
    maxAttempts: Number(input.maxAttempts || 3),
    runAfter: input.runAfter ? new Date(input.runAfter) : new Date(),
    lockedBy: input.lockedBy || null,
    lockedAt: input.lockedAt ? new Date(input.lockedAt) : null,
  };
}

function prismaWorkflowJobUpdateData(input: Record<string, any>) {
  return {
    status: input.status,
    payload: sanitizeJson(input.payload || {}),
    attempts: Number(input.attempts || 0),
    maxAttempts: Number(input.maxAttempts || 3),
    runAfter: input.runAfter ? new Date(input.runAfter) : new Date(),
    lockedBy: input.lockedBy || null,
    lockedAt: input.lockedAt ? new Date(input.lockedAt) : null,
  };
}

function sanitizeJson(value: Record<string, any>) {
  return JSON.parse(JSON.stringify(maskSecrets(value)));
}

function envVariableData(input: Record<string, any>) {
  const isSecret = input.isSecret === true;
  return {
    projectId: input.projectId,
    serviceId: input.serviceId,
    key: input.key,
    value: isSecret ? null : String(input.value ?? ''),
    isSecret,
    valueMasked: input.valueMasked || (isSecret ? '****' : String(input.value ?? '')),
    secretRef: input.secretRef || input.secretId || null,
    source: input.source || 'api',
  };
}

function maskEnvRow(row: Record<string, any>) {
  return {
    key: row.key,
    isSecret: row.isSecret === true,
    value: row.isSecret ? undefined : row.value,
    valueMasked: row.valueMasked || (row.isSecret ? '****' : String(row.value ?? '')),
    source: row.source || 'api',
    updatedAt: row.updatedAt || null,
  };
}

function redactUser(user: Record<string, any>) {
  const { passwordHash, bannedByUserId, ...rest } = user;
  return rest;
}

function organizationScopeArray(input: Record<string, any> = {}) {
  return [
    input.organizationId,
    ...(Array.isArray(input.organizationIds) ? input.organizationIds : []),
  ].filter((value) => value !== null && value !== undefined && String(value).trim()).map(String);
}

function forbiddenError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 403;
  return error;
}

function isActiveBan(user: Record<string, any>, now = Date.now()) {
  if (!user?.bannedAt) return false;
  if (!user.banExpiresAt) return true;
  const expiresAt = new Date(user.banExpiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function normalizeBanReason(value: any) {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 500) {
    const error = new Error('ban reason must be between 1 and 500 characters');
    (error as any).statusCode = 400;
    throw error;
  }
  return reason;
}

function normalizeBanExpiresAt(value: any) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    const error = new Error('ban expiration must be a valid future date');
    (error as any).statusCode = 400;
    throw error;
  }
  return new Date(timestamp);
}

function auditActorUserId(value: any) {
  const actor = String(value || '').trim();
  if (!actor) return null;
  if (new Set(['system', 'provider', 'github-app', 'github-webhook', 'github-installation-webhook', 'workflow-worker', 'builder']).has(actor.toLowerCase())) return null;
  return actor;
}

async function serializableTransactionWithRetry(prisma: any, work: (tx: any) => Promise<any>, maxAttempts = 3) {
  let lastError: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: 'Serializable' });
    } catch (error) {
      lastError = error;
      const code = String((error as any)?.code || '');
      const message = String((error as any)?.message || '').toLowerCase();
      const retryable = code === 'P2034' || code === 'P2002' || message.includes('serialization') || message.includes('write conflict') || message.includes('deadlock');
      if (!retryable || attempt === maxAttempts) {
        await recordQuotaMutationBlock(prisma, error);
        throw error;
      }
      await Promise.resolve();
    }
  }
  throw lastError;
}

async function recordQuotaMutationBlock(prisma: any, error: any) {
  const audit = error?.quotaAudit;
  if (!audit || !prisma?.auditLog?.create) return;
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: audit.actorUserId,
        action: 'quota:block',
        targetType: audit.action || 'action',
        targetId: audit.metric || audit.action || 'unknown',
        metadata: audit.reason
          ? { reason: audit.reason }
          : { current: audit.current, increment: audit.increment, limit: audit.limit },
      },
    });
  } catch {
    // Audit availability must not replace the original authorization failure.
  }
}

async function enforcePrismaQuotaRequirements(db: any, actorUserId: any, action: string, requirements: QuotaRequirement[]) {
  const userId = String(actorUserId || '').trim();
  const combined = combineQuotaRequirements(requirements);
  if (!userId || combined.length === 0) return true;
  if (typeof db.$queryRawUnsafe === 'function') {
    await db.$queryRawUnsafe('SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtext($1))', `raibitserver:quota:${userId}`);
  }
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.role === 'ADMIN' || user.accountType === 'CLUB_MEMBER') return true;
  if (user.approvalStatus !== 'APPROVED') {
    const error = forbiddenError(`user ${userId} is ${user.approvalStatus || 'PENDING'} and cannot ${action}`);
    (error as any).quotaAudit = { actorUserId: userId, action, reason: user.approvalStatus || 'PENDING' };
    throw error;
  }
  const accountType = user.accountType || 'NON_CLUB';
  const quota = await db.quota.findFirst({ where: { userId, accountType } })
    || await db.quota.upsert({ where: { id: `quota_${userId}_${accountType}` }, update: {}, create: { id: `quota_${userId}_${accountType}`, userId, accountType } });
  const usage = await prismaQuotaUsage(db, userId);
  for (const requirement of combined) {
    if (quota[requirement.metric] === undefined || quota[requirement.metric] === null) continue;
    const current = Number(usage[requirement.metric] || 0);
    const requested = current + requirement.increment;
    if (requested > Number(quota[requirement.metric])) {
      const error = forbiddenError(`quota exceeded: ${requirement.metric} (${requested}/${quota[requirement.metric]})`);
      (error as any).quotaAudit = { actorUserId: userId, action, metric: requirement.metric, current, increment: requirement.increment, limit: Number(quota[requirement.metric]) };
      throw error;
    }
  }
  return true;
}

async function prismaQuotaUsage(db: any, userId: string) {
  const month = utcMonthBounds();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  if (typeof db.$queryRawUnsafe === 'function') {
    const rows = await db.$queryRawUnsafe(QUOTA_USAGE_AGGREGATE_SQL, userId, start, end, month.startDate, month.endDate);
    return quotaUsageFromAggregate(rows?.[0] || {}, month);
  }
  const memberships = await db.membership.findMany({ where: { userId }, select: { organizationId: true } });
  const organizationIds = memberships.map((membership: Record<string, any>) => membership.organizationId);
  if (organizationIds.length === 0) return {};
  const projects = await db.project.findMany({ where: { organizationId: { in: organizationIds } }, select: { id: true } });
  const projectIds = projects.map((project: Record<string, any>) => project.id);
  if (projectIds.length === 0) {
    return { maxProjects: 0, maxServices: 0, maxDeploymentsPerDay: 0, maxPreviewDeployments: 0, maxDbStorageMb: 0, maxObjectStorageMb: 0, maxCpuMillicores: 0, maxMemoryMb: 0 };
  }
  const services = await db.service.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, desiredSpec: true, desiredState: true } });
  const serviceIds = services.map((service: Record<string, any>) => service.id);
  const resources = await db.resource.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, type: true, engine: true, desiredSpec: true, desiredState: true } });
  const deployments = serviceIds.length === 0 ? [] : await db.deployment.findMany({ where: { serviceId: { in: serviceIds }, createdAt: { gte: start, lt: end } }, select: { deploymentType: true } });
  const allDeployments = serviceIds.length === 0 ? [] : await db.deployment.findMany({
    where: {
      serviceId: { in: serviceIds },
      OR: [
        { AND: [{ buildStartedAt: { lt: month.endDate } }, { buildFinishedAt: { gt: month.startDate } }] },
        { AND: [{ deployedAt: { lt: month.endDate } }, { OR: [{ finishedAt: null }, { finishedAt: { gt: month.startDate } }] }] },
      ],
    },
    select: { buildStartedAt: true, buildFinishedAt: true, deployedAt: true, finishedAt: true },
  });
  const resourceIds = resources.map((resource: Record<string, any>) => resource.id);
  const usageRecords = await db.usageRecord.findMany({
    where: {
      recordedAt: { gte: month.startDate, lt: month.endDate },
      OR: [
        { userId },
        { organizationId: { in: organizationIds } },
        { projectId: { in: projectIds } },
        ...(serviceIds.length ? [{ serviceId: { in: serviceIds } }] : []),
        ...(resourceIds.length ? [{ resourceId: { in: resourceIds } }] : []),
      ],
    },
    select: { metric: true, value: true },
  }).catch(() => []);
  return {
    maxProjects: projects.length,
    maxServices: serviceIds.length,
    maxDeploymentsPerDay: deployments.length,
    maxPreviewDeployments: deployments.filter((deployment: Record<string, any>) => String(deployment.deploymentType).toLowerCase() === 'preview').length,
    maxDbStorageMb: resources.filter((resource: Record<string, any>) => resourceQuotaMetric(resource) === 'maxDbStorageMb').reduce((sum: number, resource: Record<string, any>) => sum + resourceStorageMb(resource, { includeDesiredState: true }), 0),
    maxObjectStorageMb: resources.filter((resource: Record<string, any>) => resourceQuotaMetric(resource) === 'maxObjectStorageMb').reduce((sum: number, resource: Record<string, any>) => sum + resourceStorageMb(resource, { includeDesiredState: true }), 0),
    maxBuildMinutesPerMonth: usageMetricSum(usageRecords, ['build-minutes', 'build_minutes', 'buildMinutes', 'maxBuildMinutesPerMonth']) + allDeployments.reduce((sum: number, deployment: Record<string, any>) => sum + deploymentBuildMinutesWithin(deployment, month.start, month.end), 0),
    maxRuntimeHoursPerMonth: usageMetricSum(usageRecords, ['runtime-hours', 'runtime_hours', 'runtimeHours', 'app-runtime-hours', 'maxRuntimeHoursPerMonth']) + allDeployments.reduce((sum: number, deployment: Record<string, any>) => sum + deploymentRuntimeHoursWithin(deployment, month.start, month.end), 0),
    maxCpuMillicores: services.reduce((sum: number, service: Record<string, any>) => sum + serviceCpuMillicores(service), 0),
    maxMemoryMb: services.reduce((sum: number, service: Record<string, any>) => sum + serviceMemoryMb(service), 0),
  };
}

async function applyPrismaGitHubCatalogWebhook(prisma: any, event: any, payload: Record<string, any> = {}) {
  const eventName = String(event || '').toLowerCase();
  const action = String(payload.action || '').toLowerCase();
  if (!['installation', 'installation_repositories', 'repository'].includes(eventName)) return [];
  const installationId = String(payload.installation?.id || '').trim();
  const accountLogin = String(payload.installation?.account?.login || '').trim().toLowerCase();
  const senderId = String(payload.sender?.id || '').trim();
  const actions: any[] = [];
  if (eventName === 'installation' && ['created', 'new_permissions_accepted'].includes(action)) {
    if (!/^\d+$/.test(installationId) || !accountLogin || !/^\d+$/.test(senderId)) return actions;
    const integrations = await prisma.gitHubIntegration.findMany({ where: { accountLogin: { equals: accountLogin, mode: 'insensitive' } }, include: { user: true } });
    const candidates = integrations.filter((integration: Record<string, any>) => String(integration.accountLogin || '').toLowerCase() === accountLogin
      && String(integration.user?.githubId || '') === senderId
      && (!integration.verifiedAt || String(integration.installationId || '') === installationId));
    if (candidates.length !== 1) return actions;
    const integration = candidates[0];
    const conflict = await prisma.gitHubIntegration.findFirst({ where: { installationId, verifiedAt: { not: null }, id: { not: integration.id } } });
    if (conflict) return actions;
    const verifiedAt = new Date();
    await prisma.gitHubIntegration.update({ where: { id: integration.id }, data: { installationId, accountLogin, verifiedAt } });
    await prisma.gitHubInstallation.upsert({ where: { installationId }, update: { accountLogin, accountType: String(payload.installation?.account?.type || 'Organization') }, create: { installationId, accountLogin, accountType: String(payload.installation?.account?.type || 'Organization') } });
    let repositoryCount = 0;
    for (const repository of Array.isArray(payload.repositories) ? payload.repositories : []) {
      if (!/^\d+$/.test(String(repository?.id || '')) || !repository?.full_name) continue;
      const record = canonicalPrismaGitHubRepositoryRecord({ installationId, githubRepoId: String(repository.id), fullName: repository.full_name, defaultBranch: repository.default_branch || 'main', private: repository.private === true });
      const existing = await prisma.gitHubRepository.findUnique({ where: { githubRepoId: record.githubRepoId } });
      if (existing && String(existing.installationId) !== installationId) continue;
      await prisma.gitHubRepository.upsert({ where: { githubRepoId: record.githubRepoId }, update: record, create: record });
      repositoryCount += 1;
    }
    actions.push({ type: 'github-installation-catalog-verified', integrationId: integration.id, installationId, repositoryCount });
    return actions;
  }
  if (eventName === 'installation' && ['deleted', 'suspend'].includes(action) && /^\d+$/.test(installationId)) {
    const removed = await prisma.gitHubRepository.deleteMany({ where: { installationId } });
    await prisma.gitHubIntegration.updateMany({ where: { installationId }, data: { verifiedAt: null } });
    actions.push({ type: 'github-installation-catalog-invalidated', installationId, repositoryCount: Number(removed?.count || 0) });
    return actions;
  }
  if (eventName === 'installation_repositories' && /^\d+$/.test(installationId)) {
    const integration = await prisma.gitHubIntegration.findFirst({ where: { installationId, verifiedAt: { not: null } } });
    if (!integration) return actions;
    for (const repository of Array.isArray(payload.repositories_added) ? payload.repositories_added : []) {
      if (!/^\d+$/.test(String(repository?.id || '')) || !repository?.full_name) continue;
      const record = canonicalPrismaGitHubRepositoryRecord({ installationId, githubRepoId: String(repository.id), fullName: repository.full_name, defaultBranch: repository.default_branch || 'main', private: repository.private === true });
      const existing = await prisma.gitHubRepository.findUnique({ where: { githubRepoId: record.githubRepoId } });
      if (!existing || String(existing.installationId) === installationId) {
        await prisma.gitHubRepository.upsert({ where: { githubRepoId: record.githubRepoId }, update: record, create: record });
      }
    }
    const removedIds = (Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []).map((repository: any) => String(repository?.id || '')).filter((id: string) => /^\d+$/.test(id));
    if (removedIds.length) await prisma.gitHubRepository.deleteMany({ where: { installationId, githubRepoId: { in: removedIds } } });
    actions.push({ type: 'github-installation-repositories-catalog-updated', installationId });
    return actions;
  }
  if (eventName === 'repository' && ['transferred', 'deleted', 'archived'].includes(action)) {
    const repositoryId = String(payload.repository?.id || '').trim();
    const repositoryName = normalizePrismaRepositoryId(payload.repository?.full_name || '');
    if (!/^\d+$/.test(installationId) || !/^\d+$/.test(repositoryId) || !repositoryName) return actions;
    const catalog = await prisma.gitHubRepository.findFirst({ where: { installationId, githubRepoId: repositoryId } });
    if (catalog && normalizePrismaRepositoryId(catalog.fullName) === repositoryName) {
      await prisma.gitHubRepository.deleteMany({ where: { installationId, githubRepoId: repositoryId } });
      actions.push({ type: 'github-repository-catalog-invalidated', installationId, repositoryId });
    }
  }
  return actions;
}

async function prismaGitHubWebhookQuotaBlocks(prisma: any, services: any[], actionPlan: Record<string, any>, actions: any[]) {
  const blocked = new Set<string>();
  if (!['production-deploy', 'preview-deploy'].includes(String(actionPlan.kind || ''))) return blocked;
  const servicesByUser = new Map<string, any[]>();
  for (const service of services) {
    const desired = service.desiredState && typeof service.desiredState === 'object' && !Array.isArray(service.desiredState) ? service.desiredState : {};
    const github = desired.github && typeof desired.github === 'object' && !Array.isArray(desired.github) ? desired.github : {};
    const integrationId = String(desired.githubIntegrationId || github.integrationId || '');
    const integration = integrationId ? await prisma.gitHubIntegration.findUnique({ where: { id: integrationId } }) : null;
    let userId = String(integration?.userId || '');
    if (!userId && service.project?.organizationId && prisma.membership?.findFirst) {
      const owner = await prisma.membership.findFirst({ where: { organizationId: service.project.organizationId, role: { equals: 'owner', mode: 'insensitive' } } });
      userId = String(owner?.userId || '');
    }
    if (!integration?.verifiedAt
      || String(integration.installationId || '') !== String(actionPlan.installationId || '')
      || String(integration.organizationId || '') !== String(service.project?.organizationId || '')
      || !userId) {
      blocked.add(String(service.id));
      actions.push({ type: 'github-webhook-quota-blocked', serviceId: service.id, reason: 'verified_quota_owner_required' });
      continue;
    }
    const group = servicesByUser.get(userId) || [];
    group.push(service);
    servicesByUser.set(userId, group);
  }
  for (const [userId, ownedServices] of servicesByUser) {
    if (typeof prisma.$queryRawUnsafe === 'function') {
      await prisma.$queryRawUnsafe('SELECT 1::int AS "locked" FROM pg_advisory_xact_lock(hashtext($1))', `raibitserver:quota:${userId}`);
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    let permitted = Boolean(user && (user.role === 'ADMIN' || user.accountType === 'CLUB_MEMBER' || user.approvalStatus === 'APPROVED'));
    if (permitted && user.role !== 'ADMIN' && user.accountType !== 'CLUB_MEMBER') {
      const accountType = user.accountType || 'NON_CLUB';
      const quota = await prisma.quota.findFirst({ where: { userId, accountType } })
        || await prisma.quota.upsert({ where: { id: `quota_${userId}_${accountType}` }, update: {}, create: { id: `quota_${userId}_${accountType}`, userId, accountType } });
      const usage = await prismaDeploymentQuotaUsage(prisma, userId);
      const deploymentIncrement = ownedServices.length;
      permitted = usage.maxDeploymentsPerDay + deploymentIncrement <= Number(quota.maxDeploymentsPerDay);
      if (permitted && actionPlan.kind === 'preview-deploy') {
        permitted = usage.maxPreviewDeployments + deploymentIncrement <= Number(quota.maxPreviewDeployments);
      }
    }
    if (!permitted) {
      for (const service of ownedServices) blocked.add(String(service.id));
      actions.push({ type: 'github-webhook-quota-blocked', serviceIds: ownedServices.map((service) => service.id), reason: 'quota_or_approval_policy' });
    }
  }
  return blocked;
}

async function prismaDeploymentQuotaUsage(prisma: any, userId: string) {
  const month = utcMonthBounds();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  if (typeof prisma.$queryRawUnsafe === 'function') {
    const rows = await prisma.$queryRawUnsafe(QUOTA_USAGE_AGGREGATE_SQL, userId, start, end, month.startDate, month.endDate);
    const usage = quotaUsageFromAggregate(rows?.[0] || {}, month);
    return { maxDeploymentsPerDay: Number(usage.maxDeploymentsPerDay || 0), maxPreviewDeployments: Number(usage.maxPreviewDeployments || 0) };
  }
  const memberships = await prisma.membership.findMany({ where: { userId }, select: { organizationId: true } });
  const organizationIds = memberships.map((membership: Record<string, any>) => membership.organizationId);
  const projects = organizationIds.length ? await prisma.project.findMany({ where: { organizationId: { in: organizationIds } }, select: { id: true } }) : [];
  const projectIds = projects.map((project: Record<string, any>) => project.id);
  const services = projectIds.length ? await prisma.service.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } }) : [];
  const serviceIds = services.map((service: Record<string, any>) => service.id);
  if (!serviceIds.length) return { maxDeploymentsPerDay: 0, maxPreviewDeployments: 0 };
  const deployments = await prisma.deployment.findMany({ where: { serviceId: { in: serviceIds }, createdAt: { gte: start, lt: end } }, select: { deploymentType: true } });
  return { maxDeploymentsPerDay: deployments.length, maxPreviewDeployments: deployments.filter((deployment: Record<string, any>) => String(deployment.deploymentType).toLowerCase() === 'preview').length };
}

async function servicesForPrismaGitHubWebhook(prisma: any, actionPlan: Record<string, any>) {
  if (actionPlan.kind === 'ignored' || !actionPlan.repositoryId || !actionPlan.installationId || !actionPlan.repository) return [];
  const catalog = await prisma.gitHubRepository.findFirst({
    where: {
      githubRepoId: String(actionPlan.repositoryId),
      installationId: String(actionPlan.installationId),
    },
  });
  if (!catalog || normalizePrismaRepositoryId(catalog.fullName) !== normalizePrismaRepositoryId(actionPlan.repository)) return [];
  const services = await prisma.service.findMany({
    where: { githubRepositoryId: String(actionPlan.repositoryId) },
    include: { project: { include: { organization: true } } },
  });
  return services.filter((service: Record<string, any>) => previewParentIsActive(service) && serviceMatchesGitHubWebhook(service, actionPlan));
}

function previewParentIsActive(service: Record<string, any>) {
  const inactive = new Set(['DELETE_REQUESTED', 'DELETING', 'DELETED']);
  return !inactive.has(String(service.status).toUpperCase())
    && !inactive.has(String(service.project?.status).toUpperCase());
}

function serviceMatchesGitHubWebhook(service: Record<string, any>, actionPlan: Record<string, any>) {
  const desired = service.desiredState && typeof service.desiredState === 'object' && !Array.isArray(service.desiredState) ? service.desiredState : {};
  const github = desired.github && typeof desired.github === 'object' && !Array.isArray(desired.github) ? desired.github : {};
  const repositoryId = String(service.githubRepositoryId || desired.githubRepositoryId || github.repositoryId || '');
  const installationId = String(desired.githubInstallationId || github.installationId || '');
  const repository = normalizePrismaRepositoryId(desired.githubRepository || github.repository || service.repoUrl || '');
  if (repositoryId !== String(actionPlan.repositoryId) || installationId !== String(actionPlan.installationId) || repository !== normalizePrismaRepositoryId(actionPlan.repository)) return false;
  const productionBranch = String(service.branch || desired.branch || 'main');
  return actionPlan.kind === 'production-deploy'
    ? String(actionPlan.branch) === productionBranch
    : String(actionPlan.baseBranch || '') === productionBranch;
}

function badRequestError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 400;
  return error;
}

function organizationSlugForCreate(input: Record<string, any>) {
  if (!Object.hasOwn(input, 'slug')) return slugInput(input.name);
  return validatedOrganizationRouteSlug(input.slug);
}

function validatedOrganizationRouteSlug(value: unknown) {
  const parsed = parseOrganizationRouteSlug(value);
  if (parsed.ok === false) throw badRequestError(parsed.code);
  return parsed.slug;
}

type MembershipOwnerCounter = {
  readonly membership: {
    readonly count: (input: {
      readonly where: {
        readonly organizationId: string;
        readonly role: { readonly in: readonly string[] };
      };
    }) => Promise<number>;
  };
};

async function organizationOwnerCount(transaction: MembershipOwnerCounter, organizationId: string) {
  return transaction.membership.count({ where: { organizationId, role: { in: ['OWNER', 'owner'] } } });
}

function conflictError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 409;
  return error;
}

function validateRollbackSource(current: Record<string, any>, previous: Record<string, any> | null | undefined, explicitPreviousDeploymentId: any) {
  if (!previous) {
    if (explicitPreviousDeploymentId) throw notFoundError(`rollback source deployment not found: ${explicitPreviousDeploymentId}`);
    throw conflictError('no previous READY deployment image is available for rollback');
  }
  if (String(previous.projectId || '') !== String(current.projectId || '') || String(previous.serviceId || '') !== String(current.serviceId || '')) {
    throw forbiddenError('rollback source deployment must belong to the same service and project');
  }
  if (String(previous.status || '').toUpperCase() !== 'READY' || !previous.imageUrl) {
    throw conflictError('rollback source deployment must be READY and have an image');
  }
}

function notFoundError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 404;
  return error;
}

function quotaData(input: Record<string, any>) {
  const keys = ['maxProjects','maxServices','maxDeploymentsPerDay','maxPreviewDeployments','maxCpuMillicores','maxMemoryMb','maxDbStorageMb','maxObjectStorageMb','maxBuildMinutesPerMonth','maxRuntimeHoursPerMonth'];
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, Number(input[key])]));
}

import { ControlPlaneStore } from './store.ts';
import { deepClone, stableId } from './ids.ts';
import { maskSecretValue, maskSecrets } from './secrets.ts';
import { openSecret, sealSecret } from './secret-vault.ts';
import { secretEncryptionConfigured } from './config.ts';
import { runDbConsoleQuery, browseDbConsole, resourceConsoleView } from './db-console.ts';
import { providerConnectionEnvForResource, provisionResourceProvider as provisionAnyResourceProvider } from './resource-providers.ts';
import { completeWorkflowJobRecord, failWorkflowJobRecord, processNextWorkflowJob } from './workflows.ts';
import { providerOwnedSqlitePath, sanitizeTenantResourceInput } from './resource-sanitizer.ts';
import { normalizeResourceEngine } from './catalog.ts';
import { redactDbConsoleStatement, sanitizeLogRecord, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate } from './security.ts';
import { assertDeploymentTransition, normalizeDeploymentStatus } from './deployments.ts';
import { previewRuntimePlan } from './preview-deployments.ts';
import { normalizeAccountType } from './identity.ts';
import {
  deploymentBuildMinutes,
  deploymentRuntimeHours,
  isProviderConnectionSecret,
  prefixEnv,
  providerConnectionFromEnv,
  providerEnvFromConnection,
  resourceQuotaMetric,
  resourceStorageMb,
  resourceTypeForEngine,
  serviceCpuMillicores,
  serviceMemoryMb,
  usageMetricSum,
} from './store-helpers.ts';

export class InMemoryControlPlaneRepository {
  store: ControlPlaneStore;

  constructor(store = new ControlPlaneStore()) {
    this.store = store;
  }

  async createOrganization(input: Record<string, any>) { return this.store.createOrganization(input); }
  async findOrganizationBySlug(slug: string) { return this.store.findOrganizationBySlug(slug); }
  async createUser(input: Record<string, any>) { return this.store.createUser(input); }
  async findUserByEmail(email: string) { return this.store.findUserByEmail(email); }
  async createEmailVerificationCode(input: Record<string, any>) { return this.store.createEmailVerificationCode(input); }
  async invalidatePendingEmailVerificationCodes(email: string) { return this.store.invalidatePendingEmailVerificationCodes(email); }
  async findPendingEmailVerificationCode(email: string, purpose?: string) { return this.store.findPendingEmailVerificationCode(email, purpose); }
  async incrementEmailVerificationAttempts(id: string) { return this.store.incrementEmailVerificationAttempts(id); }
  async consumeEmailVerificationCode(id: string, consumedAt?: string) { return this.store.consumeEmailVerificationCode(id, consumedAt); }
  async markUserEmailVerified(userId: string, verifiedAt?: string) { return this.store.markUserEmailVerified(userId, verifiedAt); }
  async recordEmailDelivery(input: Record<string, any>) { return this.store.recordEmailDelivery(input); }
  async findUserByGitHubId(githubId: string) { return this.store.findUserByGitHubId(githubId); }
  async linkGitHubUser(userId: string, input: Record<string, any> = {}) { return this.store.linkGitHubUser(userId, input); }
  async addMember(input: Record<string, any>) { return this.store.addMember(input); }
  async listMembershipsForUser(userId: string) { return this.store.listMembershipsForUser(userId); }
  async createProject(input: Record<string, any>) { return this.store.createProject(input); }
  async updateProject(projectId: string, updates: Record<string, any>) { return this.store.updateProject(projectId, updates); }
  async deleteProject(projectId: string) { return this.store.deleteProject(projectId); }
  async createService(input: Record<string, any>) { return this.store.createService(input); }
  async updateService(serviceId: string, updates: Record<string, any>) { return this.store.updateService(serviceId, updates); }
  async deleteService(serviceId: string) { return this.store.deleteService(serviceId); }
  async createResource(input: Record<string, any>) { return this.store.createResource(input); }
  async updateResource(resourceId: string, updates: Record<string, any>) { return this.store.updateResource(resourceId, updates); }
  async deleteResource(resourceId: string) { return this.store.deleteResource(resourceId); }
  async attachProviderConnectionSecret(input: Record<string, any>) { return this.store.attachProviderConnectionSecret(input); }
  async attachProviderConnectionSecrets(input: Record<string, any>) { return this.store.attachProviderConnectionSecrets(input); }
  async provisionResourceProvider(input: Record<string, any>) { return this.store.provisionResourceProvider(input); }
  async createDeployment(input: Record<string, any>) { return this.store.createDeployment(input); }
  async updateDeployment(deploymentId: string, updates: Record<string, any>, options: Record<string, any> = {}) { return this.store.updateDeployment(deploymentId, updates, options); }
  async transitionDeployment(deploymentId: string, status: string, updates: Record<string, any> = {}, options: Record<string, any> = {}) { return this.store.transitionDeployment(deploymentId, status, updates, options); }
  async cancelDeployment(deploymentId: string, input: Record<string, any> = {}) { return this.store.cancelDeployment(deploymentId, input); }
  async rollbackDeployment(deploymentId: string, input: Record<string, any> = {}) { return this.store.rollbackDeployment(deploymentId, input); }
  async createSecret(input: Record<string, any>) { return this.store.createSecret(input); }
  async createDeploymentWorkflow(input: Record<string, any>) {
    const deployment = this.store.createDeployment(input.deployment || input);
    const workflowJob = this.store.enqueueWorkflowJob({
      type: input.workflow?.type || 'build-and-deploy',
      targetType: 'deployment',
      targetId: deployment.id,
      payload: { ...(input.workflow?.payload || {}), deploymentId: deployment.id },
    });
    return { deployment, workflowJob };
  }
  async getProject(projectId: string) { return deepClone(this.store.projects.get(projectId) || null); }
  async getService(serviceId: string) { return deepClone(this.store.services.get(serviceId) || null); }
  async getResource(resourceId: string) { return deepClone(this.store.resources.get(resourceId) || null); }
  async getDeployment(deploymentId: string) { return deepClone(this.store.deployments.get(deploymentId) || null); }
  async listServicesForProject(projectId: string) { return deepClone([...this.store.services.values()].filter((service) => String(service.projectId) === String(projectId))); }
  async listResourcesForProject(projectId: string) { return deepClone([...this.store.resources.values()].filter((resource) => String(resource.projectId) === String(projectId))); }
  async listDeploymentsForService(serviceId: string) { return deepClone([...this.store.deployments.values()].filter((deployment) => String(deployment.serviceId) === String(serviceId))); }
  async upsertServiceEnvironment(input: Record<string, any>) { return this.store.upsertServiceEnvironment(input); }
  async importServiceEnvFile(input: Record<string, any>) { return this.store.importServiceEnvFile(input); }
  async listServiceEnvironment(input: Record<string, any>) { return this.store.listServiceEnvironment(input); }
  async createGitHubIntegration(input: Record<string, any>) { return this.store.createGitHubIntegration(input); }
  async listGitHubIntegrations(input: Record<string, any>) { return this.store.listGitHubIntegrations(input); }
  async attachGitHubRepositoryToService(input: Record<string, any>) { return this.store.attachGitHubRepositoryToService(input); }
  async listGitHubInstallations(input: Record<string, any>) { return this.store.listGitHubInstallations(input); }
  async listGitHubInstallationRepositories(input: Record<string, any>) { return this.store.listGitHubInstallationRepositories(input); }
  async importGitHubRepository(input: Record<string, any>) { return this.store.importGitHubRepository(input); }
  async syncGitHubRepository(input: Record<string, any>) { return this.store.syncGitHubRepository(input); }
  async handleGitHubWebhook(input: Record<string, any>) { return this.store.handleGitHubWebhook(input); }
  async enqueueWorkflowJob(input: Record<string, any>) { return this.store.enqueueWorkflowJob(input); }
  async claimNextWorkflowJob(input: Record<string, any> = {}) { return this.store.claimNextWorkflowJob(input); }
  async completeWorkflowJob(jobId: string, result: any = {}, options: Record<string, any> = {}) { return this.store.completeWorkflowJob(jobId, result, options); }
  async failWorkflowJob(jobId: string, error: any, options: Record<string, any> = {}) { return this.store.failWorkflowJob(jobId, error, options); }
  async processNextWorkflowJob(handlers: Record<string, any>, options: Record<string, any> = {}) { return this.store.processNextWorkflowJob(handlers, options); }
  async approveUser(userId: string, input: Record<string, any> = {}) { return this.store.approveUser(userId, input); }
  async rejectUser(userId: string) { return this.store.rejectUser(userId); }
  async setQuota(input: Record<string, any>) { return this.store.setQuota(input); }
  async enforceUserCan(input: Record<string, any>) { return this.store.enforceUserCan(input); }
  async attachResource(input: Record<string, any>) { return this.store.attachResource(input); }
  async appendBuildLog(input: Record<string, any>) { return this.store.appendBuildLog(input); }
  async appendRuntimeLog(input: Record<string, any>) { return this.store.appendRuntimeLog(input); }
  async appendDeploymentEvent(input: Record<string, any>) { return this.store.appendDeploymentEvent(input); }
  async listDeploymentLogs(deploymentId: string) { return this.store.listDeploymentLogs(deploymentId); }
  async listRuntimeLogs(serviceId: string) { return this.store.listRuntimeLogs(serviceId); }
  async listDeploymentEvents(deploymentId: string) { return this.store.listDeploymentEvents(deploymentId); }
  async runResourceConsoleQuery(resourceId: string, query: string, options: Record<string, any> = {}) { return this.store.runResourceConsoleQuery(resourceId, query, options); }
  async runResourceConsoleCommand(resourceId: string, command: string, options: Record<string, any> = {}) { return this.store.runResourceConsoleCommand(resourceId, command, options); }
  async browseResourceConsole(resourceId: string, options: Record<string, any> = {}) { return this.store.browseResourceConsole(resourceId, options); }
  async resourceConsoleView(resourceId: string, view: string, options: Record<string, any> = {}) { return this.store.resourceConsoleView(resourceId, view, options); }
  async snapshot() { return this.store.snapshot(); }
}

export class PrismaControlPlaneRepository {
  prisma: any;

  constructor(prisma: any) {
    this.prisma = prisma;
  }

  static async connect(options: Record<string, any> = {}) {
    const moduleName = options.clientModule || '@prisma/client';
    const imported = await import(moduleName);
    const PrismaClient = imported.PrismaClient;
    const prisma = new PrismaClient(options.prismaOptions || {});
    if (options.connect !== false) await prisma.$connect();
    return new PrismaControlPlaneRepository(prisma);
  }

  async disconnect() {
    if (this.prisma?.$disconnect) await this.prisma.$disconnect();
  }

  async createOrganization(input: Record<string, any>) {
    return this.prisma.organization.upsert({
      where: { slug: input.slug || slugInput(input.name) },
      update: { name: input.name, plan: input.plan || 'free' },
      create: { name: input.name, slug: input.slug || slugInput(input.name), plan: input.plan || 'free' },
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
      update: { name: input.name, avatarUrl: input.avatarUrl || null, githubId: input.githubId || null, passwordHash: input.passwordHash || undefined, role: input.role || undefined, accountType, approvalStatus: input.approvalStatus || undefined, emailVerifiedAt: input.emailVerifiedAt === undefined ? undefined : input.emailVerifiedAt },
      create: { name: input.name, email: input.email, avatarUrl: input.avatarUrl || null, githubId: input.githubId || null, passwordHash: input.passwordHash || null, role: input.role || 'USER', accountType, approvalStatus: input.approvalStatus || 'PENDING', emailVerifiedAt },
    });
    return redactUser(user);
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email: String(email || '').toLowerCase() } });
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

  async invalidatePendingEmailVerificationCodes(email: string) {
    return this.prisma.emailVerificationCode.updateMany({
      where: { email: String(email || '').toLowerCase(), consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  async findPendingEmailVerificationCode(email: string, purpose = 'signup') {
    return this.prisma.emailVerificationCode.findFirst({
      where: { email: String(email || '').toLowerCase(), purpose, consumedAt: null },
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
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'user.github:link', targetType: 'user', targetId: userId, metadata: maskSecrets({ githubId: input.githubId || user.githubId || null, githubLogin: input.githubLogin || null }) } });
    return redactUser(user);
  }

  async addMember(input: Record<string, any>) {
    return this.prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } },
      update: { role: input.role || 'developer' },
      create: { organizationId: input.organizationId, userId: input.userId, role: input.role || 'developer' },
    });
  }

  async listMembershipsForUser(userId: string) {
    return this.prisma.membership.findMany({ where: { userId } });
  }

  async createProject(input: Record<string, any>) {
    return this.prisma.project.upsert({
      where: { organizationId_slug: { organizationId: input.organizationId, slug: input.slug || slugInput(input.name) } },
      update: { name: input.name, description: input.description || '', status: input.status || 'active' },
      create: { organizationId: input.organizationId, name: input.name, slug: input.slug || slugInput(input.name), description: input.description || '', status: input.status || 'active' },
    });
  }

  async updateProject(projectId: string, updates: Record<string, any>) {
    return this.prisma.project.update({ where: { id: projectId }, data: projectUpdateData(updates) });
  }

  async deleteProject(projectId: string) {
    return this.prisma.project.delete({ where: { id: projectId } });
  }

  async createService(input: Record<string, any>) {
    return this.prisma.service.upsert({
      where: { projectId_slug: { projectId: input.projectId, slug: input.slug || slugInput(input.name) } },
      update: serviceData(input),
      create: { projectId: input.projectId, name: input.name, slug: input.slug || slugInput(input.name), ...serviceData(input) },
    });
  }

  async createResource(input: Record<string, any>) {
    const existing = await this.prisma.resource.findUnique({
      where: { projectId_name: { projectId: input.projectId, name: input.name } },
      select: { connectionSecretName: true },
    }).catch(() => null);
    const row = await this.prisma.resource.upsert({
      where: { projectId_name: { projectId: input.projectId, name: input.name } },
      update: resourceData(input, { connectionSecretName: existing?.connectionSecretName || null }),
      create: { projectId: input.projectId, name: input.name, slug: input.slug || slugInput(input.name), ...resourceData(input) },
    });
    await this.attachProviderConnectionSecrets({ resourceId: row.id, env: providerConnectionEnvForResource(row), actorUserId: 'system', live: false, providerMode: 'provider-contract' });
    return this.getResource(row.id);
  }

  async updateResource(resourceId: string, updates: Record<string, any>) {
    const current = await this.getResource(resourceId);
    if (!current) return null;
    const updated = await this.prisma.resource.update({ where: { id: resourceId }, data: resourceData({ ...current, ...updates, projectId: current.projectId, name: updates.name || current.name }, { connectionSecretName: current.connectionSecretName || null }) });
    if (updates.engine || updates.name || updates.provider || updates.desiredSpec) await this.attachProviderConnectionSecrets({ resourceId, env: providerConnectionEnvForResource(updated), actorUserId: 'system', live: false, providerMode: 'provider-contract' });
    await this.prisma.auditLog.create({ data: { actorUserId: 'system', action: 'resource:update', targetType: 'resource', targetId: resourceId, metadata: maskSecrets(updates) } });
    return this.getResource(resourceId);
  }

  async deleteResource(resourceId: string) {
    const current = await this.getResource(resourceId);
    if (!current) return null;
    const attachments = await this.prisma.resourceAttachment.findMany({ where: { resourceId } }).catch(() => []);
    for (const attachment of attachments) await this.removeResourceInjectedEnvironment(attachment);
    await this.prisma.secretValue.deleteMany({ where: { scopeType: 'resource-provider-connection', scopeId: resourceId } }).catch(() => null);
    const deleted = await this.prisma.resource.delete({ where: { id: resourceId } });
    await this.prisma.auditLog.create({ data: { actorUserId: 'system', action: 'resource:delete', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ projectId: current.projectId, engine: current.engine }) } });
    return deleted;
  }

  async provisionResourceProvider({ resourceId, actorUserId = 'provider', ...options }: Record<string, any>) {
    const resource = await this.getResource(resourceId);
    if (!resource) throw new Error(`resource not found: ${resourceId}`);
    const result = await provisionAnyResourceProvider(resource, options);
    const attached = await this.attachProviderConnectionSecrets({ resourceId, env: (result as any).connectionEnv || providerConnectionEnvForResource(resource), actorUserId, live: result.dryRun !== true, providerMode: result.dryRun ? 'provider-contract' : 'live-provider' });
    const updated = await this.prisma.resource.update({ where: { id: resourceId }, data: { status: 'ready', provider: result.provider, desiredState: maskSecrets({ ...(attached.desiredState || {}), providerResult: result.plan }) } });
    await this.prisma.auditLog.create({ data: { actorUserId, action: 'resource.provider:provision', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ engine: result.engine, provider: result.provider, dryRun: result.dryRun, connectionSecret: result.connectionSecret }) } });
    return { resource: updated, result: maskSecrets({ ...result, databaseUrl: undefined, connectionEnv: undefined }) };
  }

  async attachProviderConnectionSecret({ resourceId, databaseUrl, connectionUrl, actorUserId = 'provider', key = 'DATABASE_URL', live = true }: Record<string, any>) {
    const value = databaseUrl || connectionUrl;
    if (!value) throw new Error('provider connection URL is required');
    return this.attachProviderConnectionSecrets({ resourceId, env: { [key]: value }, actorUserId, live, providerMode: live === false ? 'provider-contract' : 'live-provider' });
  }

  async attachProviderConnectionSecrets({ resourceId, env = {}, actorUserId = 'provider', live = false, providerMode = 'provider-contract' }: Record<string, any>) {
    const entries = Object.entries(env || {}).filter(([, value]) => value !== undefined && value !== null && String(value).length > 0);
    if (!entries.length) throw new Error('provider connection env is required');
    let firstSecretId = (await this.getResource(resourceId))?.connectionSecretName || null;
    for (const [key, value] of entries) {
      const secret = await this.prisma.secretValue.upsert({
        where: { scopeType_scopeId_key: { scopeType: 'resource-provider-connection', scopeId: resourceId, key } },
        update: { sealedValue: sealSecret(String(value)), valueMasked: maskSecretValue(String(value)), metadata: maskSecrets({ providerOwned: true, live: live === true, providerMode }) },
        create: { scopeType: 'resource-provider-connection', scopeId: resourceId, key, sealedValue: sealSecret(String(value)), valueMasked: maskSecretValue(String(value)), metadata: maskSecrets({ providerOwned: true, live: live === true, providerMode }) },
      });
      if (!firstSecretId) firstSecretId = secret.id;
    }
    const resource = await this.prisma.resource.update({ where: { id: resourceId }, data: { connectionSecretName: firstSecretId } });
    await this.prisma.auditLog.create({ data: { actorUserId, action: 'resource.provider-connection:attach', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ connectionSecretName: firstSecretId, envKeys: entries.map(([key]) => key), providerMode }) } });
    return resource;
  }

  async createDeployment(input: Record<string, any>) {
    let projectId = input.projectId;
    if (!projectId && input.serviceId) {
      const service = await this.prisma.service.findUnique({ where: { id: input.serviceId }, select: { projectId: true } });
      projectId = service?.projectId;
    }
    return this.prisma.deployment.create({ data: deploymentData({ ...input, projectId }) });
  }

  async updateService(serviceId: string, updates: Record<string, any>) {
    return this.prisma.service.update({ where: { id: serviceId }, data: serviceUpdateData(updates) });
  }

  async deleteService(serviceId: string) {
    return this.prisma.service.delete({ where: { id: serviceId } });
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
    const deployment = await this.transitionDeployment(deploymentId, 'CANCELLED', {
      finishedAt: new Date(),
      errorCode: input.errorCode || 'DEPLOYMENT_CANCELLED',
      errorMessage: input.reason || input.errorMessage || 'Deployment cancellation requested',
    }, {
      eventType: 'deployment.cancelled',
      message: input.reason || 'Deployment cancellation requested',
    });
    const workflowJob = await this.enqueueWorkflowJob({
      type: 'deployment-cancel',
      targetType: 'deployment',
      targetId: deployment.id,
      payload: { deploymentId: deployment.id, serviceId: deployment.serviceId, projectId: deployment.projectId, reason: input.reason || 'requested' },
    });
    return { deployment, workflowJob };
  }

  async rollbackDeployment(deploymentId: string, input: Record<string, any> = {}) {
    const current = await this.getDeployment(deploymentId);
    if (!current) throw notFoundError(`deployment not found: ${deploymentId}`);
    const previous = input.previousDeploymentId
      ? await this.getDeployment(String(input.previousDeploymentId))
      : await this.prisma.deployment.findFirst({
          where: { serviceId: current.serviceId, id: { not: current.id }, status: 'READY', imageUrl: { not: null } },
          orderBy: [{ deployedAt: 'desc' }, { finishedAt: 'desc' }, { createdAt: 'desc' }],
        });
    const imageUrl = input.imageUrl || previous?.imageUrl || null;
    if (!imageUrl) {
      const error = new Error('no previous READY deployment image is available for rollback');
      (error as any).statusCode = 409;
      throw error;
    }
    const imageDigest = input.imageDigest || previous?.imageDigest || null;
    const rollback = await this.createDeployment({
      serviceId: current.serviceId,
      projectId: current.projectId,
      commitSha: previous?.commitSha || current.commitSha || null,
      imageUrl,
      imageDigest,
      status: 'IMAGE_READY',
      deploymentType: current.deploymentType || 'production',
      triggerType: 'rollback',
      branch: input.branch || current.branch || previous?.branch || 'main',
    });
    await this.appendDeploymentEvent({ deploymentId: current.id, type: 'deployment.rollback.requested', message: `Rollback requested to ${imageUrl}`, metadata: { rollbackDeploymentId: rollback.id, previousDeploymentId: previous?.id || null, imageUrl, imageDigest } });
    await this.appendDeploymentEvent({ deploymentId: rollback.id, type: 'deployment.rollback.created', message: `Rollback deployment created from ${current.id}`, metadata: { rollbackOfDeploymentId: current.id, previousDeploymentId: previous?.id || null, imageUrl, imageDigest } });
    const workflowJob = await this.enqueueWorkflowJob({
      type: 'rollback-deploy',
      targetType: 'deployment',
      targetId: rollback.id,
      payload: { deploymentId: rollback.id, rollbackOfDeploymentId: current.id, previousDeploymentId: previous?.id || null, serviceId: rollback.serviceId, projectId: rollback.projectId, imageUrl, imageDigest },
    });
    return { deployment: rollback, rollbackOfDeploymentId: current.id, previousDeployment: previous || null, workflowJob };
  }

  async createDeploymentWorkflow(input: Record<string, any>) {
    return this.prisma.$transaction(async (tx: any) => {
      const requestedDeployment = input.deployment || input;
      const service = await tx.service.findUnique({ where: { id: requestedDeployment.serviceId } });
      const deployment = await tx.deployment.create({ data: deploymentData({ ...requestedDeployment, projectId: requestedDeployment.projectId || service?.projectId }) });
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
    return this.prisma.project.findUnique({ where: { id: projectId } });
  }

  async getService(serviceId: string) {
    return this.prisma.service.findUnique({ where: { id: serviceId } });
  }

  async getResource(resourceId: string) {
    return this.prisma.resource.findUnique({ where: { id: resourceId } });
  }

  async getDeployment(deploymentId: string) {
    return this.prisma.deployment.findUnique({ where: { id: deploymentId } });
  }

  async listServicesForProject(projectId: string) {
    return this.prisma.service.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  }

  async listResourcesForProject(projectId: string) {
    return this.prisma.resource.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  }

  async listDeploymentsForService(serviceId: string) {
    return this.prisma.deployment.findMany({ where: { serviceId }, orderBy: { createdAt: 'desc' } });
  }

  async upsertServiceEnvironment(input: Record<string, any>) {
    const { normalizeEnvEntries } = await import('./env-file.ts');
    const rows = [];
    for (const entry of normalizeEnvEntries(input.entries || [], { source: input.source || 'api' })) {
      let secretRef = (entry as any).secretId || null;
      if (entry.isSecret) {
        const secret = await this.prisma.secretValue.upsert({
          where: { scopeType_scopeId_key: { scopeType: 'service', scopeId: input.serviceId, key: entry.key } },
          update: { sealedValue: sealSecret(entry.value), valueMasked: maskSecretValue(entry.value), metadata: maskSecrets({ source: entry.source || input.source || 'api' }) },
          create: { scopeType: 'service', scopeId: input.serviceId, key: entry.key, sealedValue: sealSecret(entry.value), valueMasked: maskSecretValue(entry.value), metadata: maskSecrets({ source: entry.source || input.source || 'api' }) },
        });
        secretRef = secret.id;
      }
      const data = envVariableData({ ...entry, projectId: input.projectId, serviceId: input.serviceId, source: entry.source || input.source || 'api', secretRef });
      const row = await this.prisma.environmentVariable.upsert({
        where: { serviceId_key: { serviceId: input.serviceId, key: data.key } },
        update: data,
        create: data,
      });
      rows.push(row);
    }
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'service.env:upsert', targetType: 'service', targetId: input.serviceId, metadata: maskSecrets({ keys: rows.map((row) => row.key) }) } });
    return { serviceId: input.serviceId, entries: rows.map(maskEnvRow), plainCount: rows.filter((row) => !row.isSecret).length, secretCount: rows.filter((row) => row.isSecret).length };
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
    let row = await this.prisma.githubIntegration.create({
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
      row = await this.prisma.githubIntegration.update({ where: { id: row.id }, data: { tokenSecretId: secret.id } });
    }
    await this.prisma.auditLog.create({ data: { actorUserId: input.userId || 'system', action: 'github:connect', targetType: 'organization', targetId: input.organizationId, metadata: maskSecrets({ integrationId: row.id, accountLogin: row.accountLogin }) } });
    return row;
  }

  async listGitHubIntegrations(input: Record<string, any>) {
    return this.prisma.githubIntegration.findMany({ where: { organizationId: input.organizationId } });
  }

  async attachGitHubRepositoryToService(input: Record<string, any>) {
    const { parseGitHubRepository } = await import('./github-integration.ts');
    const repo = parseGitHubRepository(input.repoUrl);
    const serviceRow = await this.prisma.service.findUnique({ where: { id: input.serviceId }, include: { project: true } });
    const integration = input.integrationId ? await this.prisma.githubIntegration.findUnique({ where: { id: input.integrationId } }) : null;
    if (integration && serviceRow?.project && String(integration.organizationId) !== String(serviceRow.project.organizationId)) {
      throw forbiddenError('GitHub integration does not belong to project organization');
    }
    const service = await this.prisma.service.update({
      where: { id: input.serviceId },
      data: { sourceType: 'github', repoUrl: repo.repoUrl, branch: input.branch || 'main', desiredState: sanitizeJson({ github: { repository: repo.fullName, integrationId: input.integrationId || null, attached: true }, githubIntegrationId: input.integrationId || null, githubRepository: repo.fullName }) },
    });
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'github:attach-repository', targetType: 'service', targetId: input.serviceId, metadata: { repository: repo.fullName, integrationId: input.integrationId || null } } });
    return { service, github: { integrationId: input.integrationId || null, repository: repo.fullName, repoUrl: repo.repoUrl, branch: input.branch || 'main' } };
  }

  async listGitHubInstallations(input: Record<string, any>) {
    const integrations = await this.prisma.githubIntegration.findMany({ where: { organizationId: input.organizationId, installationId: { not: null } } });
    const services = await this.prisma.service.findMany({ where: { repoUrl: { not: null } } });
    return {
      installations: integrations.map((integration: Record<string, any>) => ({
        id: String(integration.installationId),
        installationId: String(integration.installationId),
        integrationId: integration.id,
        accountLogin: integration.accountLogin,
        organizationId: integration.organizationId,
        repositoryCount: uniquePrismaRepositories(services.filter((service: Record<string, any>) => {
          const desired = service.desiredState || {};
          return String(desired.githubIntegrationId || desired.github?.integrationId || '') === String(integration.id);
        })).length,
      })),
    };
  }

  async listGitHubInstallationRepositories(input: Record<string, any>) {
    const organizationIds = organizationScopeArray(input);
    const integrations = await this.prisma.githubIntegration.findMany({ where: { installationId: String(input.installationId), ...(organizationIds.length ? { organizationId: { in: organizationIds } } : {}) } });
    const integrationIds = integrations.map((integration: Record<string, any>) => String(integration.id));
    if (integrationIds.length === 0) return { installationId: String(input.installationId), repositories: [] };
    const services = await this.prisma.service.findMany({ where: { repoUrl: { not: null } } });
    const repositories = uniquePrismaRepositories(services.filter((service: Record<string, any>) => {
      const desired = service.desiredState || {};
      return integrationIds.includes(String(desired.githubIntegrationId || desired.github?.integrationId || ''));
    }));
    return { installationId: String(input.installationId), repositories };
  }

  async importGitHubRepository(input: Record<string, any>) {
    const { parseGitHubRepository } = await import('./github-integration.ts');
    const repo = parseGitHubRepository(input.repoUrl || input.repository);
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    const integration = input.integrationId ? await this.prisma.githubIntegration.findUnique({ where: { id: input.integrationId } }) : null;
    if (integration && project && String(integration.organizationId) !== String(project.organizationId)) {
      throw forbiddenError('GitHub integration does not belong to project organization');
    }
    const service = await this.createService({
      projectId: input.projectId,
      name: input.serviceName || repo.repo,
      type: 'web',
      runtimeType: 'container',
      sourceType: 'github',
      repoUrl: repo.repoUrl,
      branch: input.branch || 'main',
      desiredState: { github: { repository: repo.fullName, integrationId: input.integrationId || null, imported: true }, githubRepository: repo.fullName, githubIntegrationId: input.integrationId || null },
    });
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'github:import-repository', targetType: 'project', targetId: input.projectId, metadata: maskSecrets({ repository: repo.fullName, integrationId: input.integrationId || null }) } });
    return { service, github: { integrationId: input.integrationId || null, repository: repo.fullName, repoUrl: repo.repoUrl, branch: input.branch || 'main' } };
  }

  async syncGitHubRepository(input: Record<string, any>) {
    const repository = normalizePrismaRepositoryId(input.repository || input.repositoryId || '');
    const services = await servicesForPrismaGitHubRepository(this.prisma, repository, { organizationId: input.organizationId, organizationIds: input.organizationIds });
    const workflowJob = await this.enqueueWorkflowJob({ type: 'github-repository-sync', targetType: 'github-repository', targetId: repository, payload: { repository, serviceIds: services.map((service: Record<string, any>) => service.id) } });
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'github:repository-sync', targetType: 'github-repository', targetId: repository, metadata: maskSecrets({ repository }) } });
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
    const deliveryId = String(input.deliveryId || stableId('ghdel', input.event, rawBody));
    const existing = await this.prisma.webhookEvent.findUnique({ where: { deliveryId } }).catch(() => null);
    if (existing) return { accepted: true, duplicate: true, deliveryId, actions: [] };
    const actionPlan = githubWebhookActionPlan(input.event, input.payload || {});
    const row = await this.prisma.webhookEvent.create({ data: { provider: 'github', eventType: String(input.event || 'unknown'), deliveryId, payload: sanitizeJson(maskSecrets(input.payload || {})), handled: true } });
    const services = await servicesForPrismaGitHubRepository(this.prisma, actionPlan.repository);
    const actions: any[] = [];
    for (const service of services) {
      if (actionPlan.kind === 'production-deploy') {
        const deployment = await this.createDeployment({ serviceId: service.id, projectId: service.projectId, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'production', triggerType: 'github_push', branch: actionPlan.branch });
        const workflowJob = await this.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook' } });
        actions.push({ type: 'production-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id });
      } else if (actionPlan.kind === 'preview-deploy') {
        const previewPlan = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber });
        const deployment = await this.createDeployment({ serviceId: service.id, projectId: service.projectId, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'preview', triggerType: 'github_pull_request', branch: actionPlan.branch, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: previewPlan.url });
        const preview = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id });
        const workflowJob = await this.enqueueWorkflowJob({ type: 'preview-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, pullRequestNumber: actionPlan.pullRequestNumber, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook', preview, kubernetes: preview.kubernetes } });
        await this.appendDeploymentEvent({ deploymentId: deployment.id, type: 'preview.workload.queued', message: `Preview Kubernetes workload queued for PR #${actionPlan.pullRequestNumber}`, metadata: { previewUrl: preview.url, workloadName: preview.kubernetes.workloadName, namespace: preview.kubernetes.namespace } });
        actions.push({ type: 'preview-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: preview.url, previewWorkloadName: preview.kubernetes.workloadName });
      } else if (actionPlan.kind === 'preview-cleanup') {
        const preview = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber, action: 'delete' });
        const workflowJob = await this.enqueueWorkflowJob({ type: 'preview-cleanup', targetType: 'service', targetId: service.id, payload: { serviceId: service.id, projectId: service.projectId, repository: actionPlan.repository, pullRequestNumber: actionPlan.pullRequestNumber, branch: actionPlan.branch, source: 'github-webhook', preview, kubernetes: preview.kubernetes } });
        const deployments = await this.prisma.deployment.findMany({ where: { serviceId: service.id, deploymentType: 'preview', pullRequestNumber: Number(actionPlan.pullRequestNumber) } });
        for (const deployment of deployments) {
          const cleanupPlan = previewRuntimePlan({ service, project: service.project, organization: service.project?.organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id, action: 'delete' });
          await this.prisma.deployment.update({ where: { id: deployment.id }, data: { status: 'PREVIEW_CLEANUP_REQUESTED' } });
          await this.appendDeploymentEvent({ deploymentId: deployment.id, type: 'preview.cleanup.requested', message: `Preview cleanup requested for PR #${actionPlan.pullRequestNumber}`, metadata: { repository: actionPlan.repository, workloadName: cleanupPlan.kubernetes.workloadName, cleanupSelector: cleanupPlan.kubernetes.cleanupSelector } });
        }
        actions.push({ type: 'preview-cleanup-enqueued', serviceId: service.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, deploymentIds: deployments.map((deployment: Record<string, any>) => deployment.id) });
      }
    }
    const outbound = githubWebhookOutboundPlan(actionPlan, actions);
    await this.prisma.auditLog.create({ data: { actorUserId: 'github-webhook', action: 'github:webhook', targetType: 'github-delivery', targetId: deliveryId, metadata: maskSecrets({ event: input.event, repository: actionPlan.repository, action: actionPlan.action, actions: actions.map((action) => action.type) }) } }).catch(() => null);
    return { accepted: true, duplicate: false, deliveryId, event: input.event, repository: actionPlan.repository, action: actionPlan.action, matchedServiceCount: services.length, actions, outbound, webhookEvent: row };
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
    const user = await this.prisma.user.update({ where: { id: userId }, data: { approvalStatus: 'APPROVED', accountType, role: input.role || undefined } });
    if (accountType === 'NON_CLUB') await this.setQuota({ userId, accountType });
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'user:approve', targetType: 'user', targetId: userId, metadata: maskSecrets({ accountType }) } });
    return redactUser(user);
  }

  async rejectUser(userId: string, input: Record<string, any> = {}) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { approvalStatus: 'REJECTED' } });
    await this.prisma.auditLog.create({ data: { actorUserId: input.actorUserId || 'system', action: 'user:reject', targetType: 'user', targetId: userId, metadata: {} } });
    return redactUser(user);
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
    if (!user || user.role === 'ADMIN' || user.accountType === 'CLUB_MEMBER') return true;
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
    const memberships = await this.prisma.membership.findMany({ where: { userId }, select: { organizationId: true } });
    const organizationIds = memberships.map((membership: Record<string, any>) => membership.organizationId);
    if (organizationIds.length === 0) return {};
    const projects = await this.prisma.project.findMany({ where: { organizationId: { in: organizationIds } }, select: { id: true } });
    const projectIds = projects.map((project: Record<string, any>) => project.id);
    if (projectIds.length === 0) {
      return { maxProjects: 0, maxServices: 0, maxDeploymentsPerDay: 0, maxPreviewDeployments: 0, maxDbStorageMb: 0, maxObjectStorageMb: 0 };
    }
    const services = await this.prisma.service.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, desiredSpec: true, desiredState: true } });
    const serviceIds = services.map((service: Record<string, any>) => service.id);
    const resources = await this.prisma.resource.findMany({ where: { projectId: { in: projectIds } }, select: { type: true, engine: true, desiredSpec: true, desiredState: true } });
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const deployments = serviceIds.length === 0 ? [] : await this.prisma.deployment.findMany({ where: { serviceId: { in: serviceIds }, createdAt: { gte: start, lt: end } }, select: { deploymentType: true } });
    const allDeployments = serviceIds.length === 0 ? [] : await this.prisma.deployment.findMany({ where: { serviceId: { in: serviceIds } }, select: { buildStartedAt: true, buildFinishedAt: true, startedAt: true, deployedAt: true, finishedAt: true } });
    const usageRecords = await this.prisma.usageRecord.findMany({
      where: {
        OR: [
          { userId },
          { organizationId: { in: organizationIds } },
          { projectId: { in: projectIds } },
          ...(serviceIds.length ? [{ serviceId: { in: serviceIds } }] : []),
        ],
      },
      select: { metric: true, value: true },
    }).catch(() => []);
    return {
      maxProjects: projects.length,
      maxServices: serviceIds.length,
      maxDeploymentsPerDay: deployments.length,
      maxPreviewDeployments: deployments.filter((deployment: Record<string, any>) => deployment.deploymentType === 'preview').length,
      maxDbStorageMb: resources.filter((resource: Record<string, any>) => resourceQuotaMetric(resource) === 'maxDbStorageMb').reduce((sum: number, resource: Record<string, any>) => sum + resourceStorageMb(resource, { includeDesiredState: true }), 0),
      maxObjectStorageMb: resources.filter((resource: Record<string, any>) => resourceQuotaMetric(resource) === 'maxObjectStorageMb').reduce((sum: number, resource: Record<string, any>) => sum + resourceStorageMb(resource, { includeDesiredState: true }), 0),
      maxBuildMinutesPerMonth: usageMetricSum(usageRecords, ['build-minutes', 'build_minutes', 'buildMinutes', 'maxBuildMinutesPerMonth']) + allDeployments.reduce((sum: number, deployment: Record<string, any>) => sum + deploymentBuildMinutes(deployment), 0),
      maxRuntimeHoursPerMonth: usageMetricSum(usageRecords, ['runtime-hours', 'runtime_hours', 'runtimeHours', 'app-runtime-hours', 'maxRuntimeHoursPerMonth']) + allDeployments.reduce((sum: number, deployment: Record<string, any>) => sum + deploymentRuntimeHours(deployment), 0),
      maxCpuMillicores: services.reduce((sum: number, service: Record<string, any>) => sum + serviceCpuMillicores(service), 0),
      maxMemoryMb: services.reduce((sum: number, service: Record<string, any>) => sum + serviceMemoryMb(service), 0),
    };
  }

  async appendBuildLog(input: Record<string, any>) {
    return this.prisma.buildLog.create({ data: { deploymentId: input.deploymentId, step: input.step || 'build', line: maskLogLine(input.line), level: input.level || 'info' } });
  }

  async appendRuntimeLog(input: Record<string, any>) {
    return this.prisma.runtimeLog.create({ data: { serviceId: input.serviceId, deploymentId: input.deploymentId || null, podName: input.podName || 'local-pod', containerName: input.containerName || 'app', line: maskLogLine(input.line), level: input.level || 'info' } });
  }

  async appendDeploymentEvent(input: Record<string, any>) {
    return this.prisma.deploymentEvent.create({ data: { deploymentId: input.deploymentId, type: input.type || 'deployment.event', message: maskLogLine(input.message), metadata: sanitizeJson(input.metadata || {}) } });
  }

  async listDeploymentLogs(deploymentId: string) { return this.prisma.buildLog.findMany({ where: { deploymentId }, orderBy: { timestamp: 'asc' } }); }
  async listRuntimeLogs(serviceId: string) { return this.prisma.runtimeLog.findMany({ where: { serviceId }, orderBy: { timestamp: 'asc' } }); }
  async listDeploymentEvents(deploymentId: string) { return this.prisma.deploymentEvent.findMany({ where: { deploymentId }, orderBy: { timestamp: 'asc' } }); }

  async runResourceConsoleQuery(resourceId: string, query: string, options: Record<string, any> = {}) {
    const resource = await this.getResource(resourceId);
    if (!resource) {
      const error = new Error(`resource not found: ${resourceId}`);
      (error as any).statusCode = 404;
      throw error;
    }
    const result = await runDbConsoleQuery(await this.resourceForConsole(resource), query, options);
    await this.prisma.auditLog.create({ data: { actorUserId: options.actorUserId || 'system', action: 'resource.console:query', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ queryPreview: redactDbConsoleStatement(query), queryBytes: Buffer.byteLength(String(query || '')), resultRows: (result as any).rowCount || result.rows?.length || 0 }) } });
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
    await this.prisma.auditLog.create({ data: { actorUserId: options.actorUserId || 'system', action: 'resource.console:command', targetType: 'resource', targetId: resourceId, metadata: maskSecrets({ commandPreview: redactDbConsoleStatement(command), commandBytes: Buffer.byteLength(String(command || '')), mode: (result as any).mode }) } });
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
    const secrets = await this.prisma.secretValue.findMany({ where: { scopeType: 'resource-provider-connection', scopeId: resource.id } });
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

  async attachResource({ resourceId, serviceId, envPrefix = null, actorUserId = 'system' }: Record<string, any>) {
    const resource = await this.getResource(resourceId);
    const service = await this.getService(serviceId);
    if (!resource) throw Object.assign(new Error(`resource not found: ${resourceId}`), { statusCode: 404 });
    if (!service) throw Object.assign(new Error(`service not found: ${serviceId}`), { statusCode: 404 });
    if (String(resource.projectId) !== String(service.projectId)) throw Object.assign(new Error('resource and service must be in the same project'), { statusCode: 403 });
    const providerEnv = providerEnvFromConnection(await this.resourceForConsole(resource), resource);
    const injectedEnv = prefixEnv(providerEnv, envPrefix);
    const row = await this.prisma.resourceAttachment.upsert({
      where: { resourceId_serviceId: { resourceId, serviceId } },
      update: { envPrefix, injectedEnv: maskSecrets(injectedEnv) },
      create: { resourceId, serviceId, envPrefix, injectedEnv: maskSecrets(injectedEnv) },
    });
    await this.upsertServiceEnvironment({
      projectId: service.projectId,
      serviceId,
      entries: Object.entries(injectedEnv).map(([key, value]) => ({ key, value: String(value), isSecret: true, source: `resource:${resourceId}` })),
      actorUserId,
      source: `resource:${resourceId}`,
    });
    await this.prisma.auditLog.create({ data: { actorUserId, action: 'resource:attach', targetType: 'service', targetId: serviceId, metadata: maskSecrets({ resourceId, envPrefix, envKeys: Object.keys(injectedEnv) }) } });
    return row;
  }

  async removeResourceInjectedEnvironment(attachment: Record<string, any>) {
    for (const key of Object.keys(attachment.injectedEnv || {})) {
      const row = await this.prisma.environmentVariable.findUnique({ where: { serviceId_key: { serviceId: attachment.serviceId, key } } }).catch(() => null);
      if (row?.source !== `resource:${attachment.resourceId}`) continue;
      if (row.secretRef) await this.prisma.secretValue.delete({ where: { id: row.secretRef } }).catch(() => null);
      await this.prisma.environmentVariable.delete({ where: { serviceId_key: { serviceId: attachment.serviceId, key } } }).catch(() => null);
    }
  }

  async writeDesiredProject(projectSpec: Record<string, any>) {
    const orgInput = projectSpec.organization || null;
    const requestedOrganizationId = projectSpec.organizationId || projectSpec.orgId || null;
    return this.prisma.$transaction(async (tx: any) => {
      const organization = await resolveDesiredOrganization(tx, orgInput, requestedOrganizationId, projectSpec.organizationSlug);
      const projectInput = projectSpec.project || { name: projectSpec.name || projectSpec.slug || 'project', slug: projectSpec.slug || projectSpec.name || 'project', description: projectSpec.description || '' };
      const projectSlug = projectInput.slug || slugInput(projectInput.name);
      const project = await tx.project.upsert({
        where: { organizationId_slug: { organizationId: organization.id, slug: projectSlug } },
        update: { name: projectInput.name || projectSlug, description: projectInput.description || '', status: projectInput.status || 'active' },
        create: { organizationId: organization.id, name: projectInput.name || projectSlug, slug: projectSlug, description: projectInput.description || '', status: projectInput.status || 'active' },
      });
      const services = [];
      for (const service of projectSpec.services || []) {
        services.push(await tx.service.upsert({
          where: { projectId_slug: { projectId: project.id, slug: service.slug || slugInput(service.name) } },
          update: serviceData({ ...service, projectId: project.id }),
          create: { projectId: project.id, name: service.name, slug: service.slug || slugInput(service.name), ...serviceData({ ...service, projectId: project.id }) },
        }));
      }
      const resources = [];
      for (const resource of projectSpec.resources || []) {
        const existing = typeof tx.resource.findUnique === 'function'
          ? await tx.resource.findUnique({
            where: { projectId_name: { projectId: project.id, name: resource.name } },
            select: { connectionSecretName: true },
          }).catch(() => null)
          : null;
        resources.push(await tx.resource.upsert({
          where: { projectId_name: { projectId: project.id, name: resource.name } },
          update: resourceData({ ...resource, projectId: project.id }, { connectionSecretName: existing?.connectionSecretName || null }),
          create: { projectId: project.id, name: resource.name, ...resourceData({ ...resource, projectId: project.id }) },
        }));
      }
      await tx.auditLog.create({ data: { actorUserId: 'system', action: 'desired-state:write', targetType: 'project', targetId: project.id, metadata: maskSecrets(projectSpec) } });
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
      this.prisma.githubIntegration.findMany(),
    ]);
    return deepClone({ organizations, users: users.map(redactUser), members, projects, services, resources, deployments, auditLogs, usageRecords, workflowJobs, quotas, domains, resourceAttachments, resourceBackups, buildLogs, runtimeLogs, deploymentEvents, environmentVariables: environmentVariables.map(maskEnvRow), githubIntegrations });
  }
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

function slugInput(value: any) {
  return String(value || 'item').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function projectUpdateData(input: Record<string, any> = {}) {
  const data: Record<string, any> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.slug !== undefined) data.slug = slugInput(input.slug);
  if (input.description !== undefined) data.description = input.description || '';
  if (input.status !== undefined) data.status = input.status;
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
  return tx.organization.upsert({
    where: { slug: desired.slug || slugInput(desired.name) },
    update: { name: desired.name || desired.slug, plan: desired.plan || 'free' },
    create: { name: desired.name || desired.slug, slug: desired.slug || slugInput(desired.name), plan: desired.plan || 'free' },
  });
}

function serviceData(input: Record<string, any>) {
  const safe = sanitizeTenantServiceInput(input);
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
    status: 'created',
    desiredSpec: sanitizeJson(safe.desiredSpec || safe),
    desiredState: sanitizeJson(safe),
  };
}

function resourceData(input: Record<string, any>, options: Record<string, any> = {}) {
  const safe = sanitizeTenantResourceInput(input);
  const engine = normalizeResourceEngine(safe.engine || input.engine || safe.type);
  const id = input.id || stableId('res', safe.projectId, safe.name);
  const sqlitePath = engine === 'sqlite' ? (input.sqlitePath || input.desiredSpec?.sqlitePath || providerOwnedSqlitePath(id)) : null;
  const desiredSpec = sqlitePath ? { ...(safe.desiredSpec || {}), sqlitePath } : (safe.desiredSpec || {});
  const desiredState = { ...safe, engine, desiredSpec, sqlitePath: sqlitePath || undefined };
  return {
    slug: safe.slug || slugInput(safe.name),
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


function serviceUpdateData(input: Record<string, any> = {}) {
  const inputSafe = sanitizeTenantServiceUpdate(input);
  const allowed = ['name', 'type', 'runtimeType', 'sourceType', 'buildMode', 'repoUrl', 'githubRepositoryId', 'branch', 'rootDirectory', 'buildContext', 'dockerfilePath', 'installCommand', 'buildCommand', 'startCommand', 'outputDirectory', 'image', 'imageUrl', 'port'];
  const data: Record<string, any> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(inputSafe || {}, key)) continue;
    const value = inputSafe[key] === '' ? null : inputSafe[key];
    data[key] = key === 'port' && value !== null && value !== undefined ? Number(value) : value;
  }
  if (inputSafe.slug !== undefined) data.slug = slugInput(inputSafe.slug);
  if (inputSafe.image && !inputSafe.imageUrl) data.imageUrl = inputSafe.image;
  if (inputSafe.imageUrl && !inputSafe.image) data.image = inputSafe.imageUrl;
  if (Object.prototype.hasOwnProperty.call(inputSafe || {}, 'desiredSpec')) data.desiredSpec = sanitizeJson(inputSafe.desiredSpec || {});
  if (Object.keys(inputSafe || {}).length && !data.desiredState) data.desiredState = sanitizeJson(inputSafe);
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
    serviceId: input.serviceId,
    projectId: input.projectId,
    commitSha: input.commitSha || input.commitHash || null,
    commitHash: input.commitHash || input.commitSha || null,
    imageUrl: input.imageUrl || input.image || null,
    imageDigest: input.imageDigest || null,
    status: normalizeDeploymentStatus(input.status || 'queued'),
    deploymentType: input.deploymentType || 'production',
    triggerType: input.triggerType || 'manual',
    branch: input.branch || 'main',
    pullRequestNumber: input.pullRequestNumber ? Number(input.pullRequestNumber) : null,
    previewUrl: input.previewUrl || null,
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
  const { passwordHash, ...rest } = user;
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

function notFoundError(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 404;
  return error;
}

function quotaData(input: Record<string, any>) {
  const keys = ['maxProjects','maxServices','maxDeploymentsPerDay','maxPreviewDeployments','maxCpuMillicores','maxMemoryMb','maxDbStorageMb','maxObjectStorageMb','maxBuildMinutesPerMonth','maxRuntimeHoursPerMonth'];
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, Number(input[key])]));
}

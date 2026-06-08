import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import type { ProjectSpec, ServiceSpec, ResourceSpec } from '@raibitserver/schemas';
import { assertEnvironmentWriteAllowed, assertRateLimit, assertSystemDeploymentActor, createControlPlaneRepository, createFixedWindowRateLimiter, createSessionToken, githubOAuthLoginPlan, issueSignupEmailVerificationCode, normalizeEmail, normalizeEnvEntries, organizationScopeFromProjectInput, parseDotEnv, quotaUsageGauges, quotaWarnings, requireScope, resendEmailVerificationCode, sanitizeDeploymentStatusInput, sanitizeTenantDeploymentCreate, sanitizeTenantResourceApiInput, sanitizeTenantResourceApiUpdate, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate, shouldPromoteFirstLogin, validateServiceSecurity, verifyEmailCodeAndCreateSession, verifyPassword, type InMemoryControlPlaneRepository, type PrismaControlPlaneRepository } from '@raibitserver/core';

/**
 * NestJS-facing desired-state service.
 *
 * Production rule: the API stores desired state in PostgreSQL via Prisma and
 * enqueues durable workflow jobs; Go services reconcile Kubernetes/build/resource
 * actual state asynchronously. Local/dev can keep the same in-memory repository
 * instance for deterministic tests without split-brain state.
 */
const authLimiter = createFixedWindowRateLimiter({ limit: Number(process.env.RAIBITSERVER_AUTH_RATE_LIMIT || 10), windowMs: 60_000 });

function authRateKey(label: string, email: string, context: Record<string, any> = {}) {
  return `${label}:${email}:${authRateSource(context)}`;
}

function authRateSource(context: Record<string, any> = {}) {
  const request = context.request || context.req || null;
  if (!request) return 'direct';
  const headers = request.headers || {};
  const trustedProxy = process.env.RAIBITSERVER_TRUST_PROXY_HEADERS === '1' || process.env.RAIBITSERVER_AUTH_RATE_LIMIT_TRUST_PROXY === '1';
  const forwarded = trustedProxy ? String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '').split(',')[0]?.trim() : '';
  return forwarded || request.ip || request.socket?.remoteAddress || request.connection?.remoteAddress || 'unknown';
}

@Injectable()
export class RAIBITSERVERService implements OnModuleDestroy {
  private readonly repositoryPromise: Promise<InMemoryControlPlaneRepository | PrismaControlPlaneRepository>;

  constructor() {
    this.repositoryPromise = createControlPlaneRepository();
  }

  async onModuleDestroy() {
    const repository = await this.repositoryPromise;
    if ('disconnect' in repository) await repository.disconnect();
  }

  async signup(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    const email = normalizeEmail(input.email);
    assertRateLimit(authLimiter, authRateKey('signup', email, context));
    try {
      const emailVerification = await issueSignupEmailVerificationCode(repository, { ...input, email }, { jwtSecret, issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver', env: process.env });
      return { emailVerification, signup: { email, status: 'verification_required' } };
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async verifyEmail(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    const email = normalizeEmail(input.email);
    const rateKey = authRateKey('email-verify', email, context);
    assertRateLimit(authLimiter, rateKey);
    try {
      const result = await verifyEmailCodeAndCreateSession(repository, input, { jwtSecret, issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver', env: process.env });
      authLimiter.reset(rateKey);
      return { ...result, user: publicUser(result.user) };
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async resendEmailVerification(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    const email = normalizeEmail(input.email);
    assertRateLimit(authLimiter, authRateKey('email-resend', email, context));
    try {
      const emailVerification = await resendEmailVerificationCode(repository, input, { jwtSecret, issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver', env: process.env });
      return { emailVerification };
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async login(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    const email = normalizeEmail(input.email);
    const rateKey = authRateKey('login', email, context);
    let user = repository.findUserByEmail ? await repository.findUserByEmail(email) : repository.store.findUserByEmail(email);
    const passwordValid = user ? verifyPassword(input.password, user.passwordHash) : false;
    if (!user || !passwordValid) {
      assertRateLimit(authLimiter, rateKey);
      throw new ForbiddenException('invalid credentials');
    }
    assertNestEmailVerified(user);
    if (shouldPromoteFirstLogin(user, await usersForRepository(repository))) {
      user = await repository.approveUser(user.id, { accountType: 'NON_CLUB', role: 'ADMIN', actorUserId: 'system' });
    }
    const memberships = repository.listMembershipsForUser ? await repository.listMembershipsForUser(user.id) : repository.store.listMembershipsForUser(user.id);
    authLimiter.reset(rateKey);
    const token = createSessionToken(user, memberships, jwtSecret, { issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver' });
    const { passwordHash, ...publicUser } = user;
    return { user: publicUser, memberships, token };
  }

  async createProject(project: ProjectSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const projectInput = project as any;
    const organizationId = organizationScopeFromProjectInput(projectInput, subject);
    enforceScope(subject, { organizationId });
    if (repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'project:create', metric: 'maxProjects', increment: 1 });
    if (repository.writeDesiredProject) {
      const result = await repository.writeDesiredProject({ ...projectInput, organizationId });
      return result.project || result;
    }
    const organization = repository.store.organizations.get(organizationId)
      ? repository.store.organizations.get(organizationId)
      : await repository.createOrganization({ name: organizationId, slug: organizationId, plan: projectInput.organization?.plan || 'free' });
    const row = await repository.createProject({ organizationId: organization.id || organizationId, name: project.name, slug: project.slug, description: project.description || '' });
    for (const service of project.services || []) await repository.createService({ ...sanitizeTenantServiceInput(service), projectId: row.id });
    for (const resource of project.resources || []) await repository.createResource({ ...sanitizeTenantResourceApiInput(resource), projectId: row.id });
    return row;
  }

  async listProjects(subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const snapshot = await repository.snapshot();
    if (isGlobalSubject(subject)) return snapshot.projects;
    const organizationIds = new Set([subject.organizationId, ...(subject.organizationIds || [])].filter(Boolean).map(String));
    if (!organizationIds.size) return [];
    return snapshot.projects.filter((project: Record<string, any>) => organizationIds.has(String(project.organizationId)));
  }

  async getProject(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = repository.getProject ? await repository.getProject(projectId) : (await repository.snapshot()).projects.find((candidate: Record<string, any>) => String(candidate.id) === String(projectId));
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return project;
  }

  async updateProject(projectId: string, updates: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = repository.updateProject ? await repository.updateProject(projectId, updates || {}) : repository.store.updateProject(projectId, updates || {});
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return project;
  }

  async deleteProject(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = repository.deleteProject ? await repository.deleteProject(projectId) : repository.store.deleteProject(projectId);
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return { deleted: true, projectId: project.id || projectId };
  }

  async listServices(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const services = repository.listServicesForProject ? await repository.listServicesForProject(projectId) : (await repository.snapshot()).services.filter((service: Record<string, any>) => String(service.projectId) === String(projectId));
    return { services };
  }

  async addService(projectId: string, service: ServiceSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    if (repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'service:create', metric: 'maxServices', increment: 1 });
    return repository.createService({ ...sanitizeTenantServiceInput(service), projectId });
  }

  async getService(serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    return service;
  }

  async updateService(serviceId: string, updates: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const current = await repository.getService(serviceId);
    if (!current) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, current.projectId, subject);
    const safeUpdates = sanitizeTenantServiceUpdate(updates || {});
    const service = repository.updateService ? await repository.updateService(serviceId, safeUpdates) : repository.store.updateService(serviceId, safeUpdates);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return service;
  }

  async deleteService(serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const current = await repository.getService(serviceId);
    if (!current) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, current.projectId, subject);
    const service = repository.deleteService ? await repository.deleteService(serviceId) : repository.store.deleteService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return { deleted: true, serviceId: service.id || serviceId };
  }

  async listResources(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const resources = repository.listResourcesForProject ? await repository.listResourcesForProject(projectId) : (await repository.snapshot()).resources.filter((resource: Record<string, any>) => String(resource.projectId) === String(projectId));
    return { resources };
  }

  async addResource(projectId: string, resource: ResourceSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    if (repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'resource:create', metric: String((resource as any).type || '').toLowerCase() === 'storage' ? 'maxObjectStorageMb' : 'maxDbStorageMb', increment: Number((resource as any).storageMb || (resource as any).storageGb || 1) });
    return repository.createResource({ ...sanitizeTenantResourceApiInput(resource), projectId });
  }

  async getResource(resourceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    return resource;
  }

  async updateResource(resourceId: string, updates: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const current = await this.getResource(resourceId, subject);
    const safeUpdates = sanitizeTenantResourceApiUpdate(updates);
    const resource = repository.updateResource ? await repository.updateResource(resourceId, safeUpdates) : repository.store.updateResource(resourceId, safeUpdates);
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    return resource;
  }

  async deleteResource(resourceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const current = await this.getResource(resourceId, subject);
    const resource = repository.deleteResource ? await repository.deleteResource(resourceId) : repository.store.deleteResource(resourceId);
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    return { deleted: true, resourceId: current.id || resourceId };
  }

  async attachResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = await this.getResource(resourceId, subject);
    const service = repository.getService ? await repository.getService(input.serviceId) : (await repository.snapshot()).services.find((candidate: Record<string, any>) => String(candidate.id) === String(input.serviceId));
    if (!service) throw new NotFoundException(`service not found: ${input.serviceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    if (String(service.projectId) !== String(resource.projectId)) throw new ForbiddenException('resource and service must be in the same project');
    return repository.attachResource({ ...input, resourceId, actorUserId: subject.id });
  }

  async provisionResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await this.getResource(resourceId, subject);
    return repository.provisionResourceProvider({ ...input, resourceId, actorUserId: subject.id });
  }

  async listDeployments(projectId: string, serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertServiceInProject(repository, projectId, serviceId);
    await assertProjectAccess(repository, projectId, subject);
    const deployments = repository.listDeploymentsForService ? await repository.listDeploymentsForService(serviceId) : (await repository.snapshot()).deployments.filter((deployment: Record<string, any>) => String(deployment.serviceId) === String(serviceId));
    return { deployments };
  }

  async createDeployment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw new ForbiddenException('service does not belong to project');
    const deploymentType = input.deploymentType || input.type || 'production';
    if (repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxDeploymentsPerDay', increment: 1 });
    if (deploymentType === 'preview' && repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxPreviewDeployments', increment: 1 });
    const security = validateServiceSecurity(service.desiredState || service.desiredSpec || service);
    if (!security.ok) throw new ForbiddenException(`deployment blocked by security policy: ${security.findings.filter((finding: any) => finding.level === 'block').map((finding: any) => finding.code).join(', ')}`);
    const { deployment, workflowJob } = await repository.createDeploymentWorkflow({
      deployment: { ...sanitizeTenantDeploymentCreate(input), serviceId, projectId, status: 'queued', deploymentType },
      workflow: { type: deploymentType === 'preview' ? 'preview-deploy' : 'build-and-deploy', payload: { projectId, serviceId, branch: input.branch || 'main', commitSha: input.commitSha || input.commitHash || null } },
    });
    return {
      ...deployment,
      projectId,
      desiredStateWritten: true,
      workflowJob,
    };
  }

  async getDeployment(deploymentId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    return deployment;
  }

  async updateDeploymentStatus(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const deployment = await this.getDeployment(deploymentId, subject);
    assertSystemDeploymentActor(subject);
    const updates = sanitizeDeploymentStatusInput(input);
    let updated;
    if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
      const { status, ...statusUpdates } = updates;
      updated = repository.transitionDeployment
        ? await repository.transitionDeployment(deploymentId, status, statusUpdates, { actorUserId: subject.id, eventType: input.eventType, message: input.message })
        : repository.store.transitionDeployment(deploymentId, status, statusUpdates, { actorUserId: subject.id, eventType: input.eventType, message: input.message });
    } else {
      updated = repository.updateDeployment
        ? await repository.updateDeployment(deploymentId, updates, { actorUserId: subject.id, eventType: input.eventType, message: input.message })
        : repository.store.updateDeployment(deploymentId, updates, { actorUserId: subject.id, eventType: input.eventType, message: input.message });
    }
    return { ...updated, projectId: deployment.projectId };
  }

  async cancelDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await this.getDeployment(deploymentId, subject);
    return repository.cancelDeployment
      ? repository.cancelDeployment(deploymentId, { ...input, actorUserId: subject.id })
      : repository.store.cancelDeployment(deploymentId, { ...input, actorUserId: subject.id });
  }

  async rollbackDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const deployment = await this.getDeployment(deploymentId, subject);
    if (repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxDeploymentsPerDay', increment: 1 });
    if ((deployment.deploymentType || input.deploymentType || input.type) === 'preview' && repository.enforceUserCan) await repository.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxPreviewDeployments', increment: 1 });
    try {
      return repository.rollbackDeployment
        ? await repository.rollbackDeployment(deploymentId, { ...input, actorUserId: subject.id })
        : repository.store.rollbackDeployment(deploymentId, { ...input, actorUserId: subject.id });
    } catch (error) {
      if ((error as any)?.statusCode === 409) throw new ConflictException(error instanceof Error ? error.message : 'rollback conflict');
      throw error;
    }
  }

  async createDeploymentForService(serviceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return this.createDeployment(service.projectId, serviceId, input, subject);
  }

  async listDeploymentsForService(serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return this.listDeployments(service.projectId, serviceId, subject);
  }

  async listDeploymentLogs(deploymentId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    return { logs: await repository.listDeploymentLogs(deploymentId) };
  }

  async listDeploymentEvents(deploymentId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    return { events: await repository.listDeploymentEvents(deploymentId) };
  }

  async deploymentActivitySnapshot(deploymentId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    return {
      deployment,
      logs: await repository.listDeploymentLogs(deploymentId),
      events: await repository.listDeploymentEvents(deploymentId),
      stream: { mode: 'sse-snapshot', retryMs: 3000 },
    };
  }

  async listRuntimeLogs(serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    return { logs: await repository.listRuntimeLogs(serviceId) };
  }

  async serviceLogSnapshot(serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    return {
      service,
      logs: await repository.listRuntimeLogs(serviceId),
      stream: { mode: 'sse-snapshot', retryMs: 3000 },
    };
  }

  async queryResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    return repository.runResourceConsoleQuery(resourceId, input.query, { ...input, role: subject.role, actorUserId: subject.id });
  }

  async commandResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    return repository.runResourceConsoleCommand(resourceId, input.command || input.query, { ...input, role: subject.role, actorUserId: subject.id });
  }

  async browseResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    return repository.browseResourceConsole(resourceId, input);
  }

  async resourceConsoleView(resourceId: string, view: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    return repository.resourceConsoleView(resourceId, view, { ...input, role: subject.role, actorUserId: subject.id });
  }

  async usageMe(subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const snapshot = await repository.snapshot();
    const usage = (snapshot.usageRecords || []).filter((row: Record<string, any>) => String(row.userId) === String(subject.id));
    const unlimited = subject.userRole === 'ADMIN' || subject.accountType === 'CLUB_MEMBER';
    const quota = unlimited ? null : (snapshot.quotas || []).find((row: Record<string, any>) => String(row.userId) === String(subject.id)) || null;
    const current = repository.quotaUsageForUser ? await repository.quotaUsageForUser(subject.id) : {};
    return { accountType: subject.accountType, approvalStatus: subject.approvalStatus, unlimited, quota, usage, current, gauges: quotaUsageGauges(current, quota), warnings: quotaWarnings(current, quota) };
  }

  async listEnvironment(projectId: string, serviceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    await assertServiceInProject(repository, projectId, serviceId);
    return repository.listServiceEnvironment({ projectId, serviceId });
  }

  async upsertEnvironment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    await assertServiceInProject(repository, projectId, serviceId);
    const entries = normalizeEnvEntries(input.entries || input.environment || input, { source: input.source || 'api' });
    assertNestEnvironmentWriteAllowed(subject, entries);
    return repository.upsertServiceEnvironment({ projectId, serviceId, entries, actorUserId: subject.id, source: input.source || 'api' });
  }

  async importEnvironmentFile(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    await assertServiceInProject(repository, projectId, serviceId);
    const source = input.filename || '.env';
    const parsed = parseDotEnv(String(input.content || input.text || ''), { source });
    assertNestEnvironmentWriteAllowed(subject, parsed.entries);
    const result = await repository.upsertServiceEnvironment({ projectId, serviceId, entries: parsed.entries, actorUserId: subject.id, source });
    return { ...result, source, parsed: { plainCount: parsed.plainCount, secretCount: parsed.secretCount, errors: parsed.errors } };
  }


  async currentUser(subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const snapshot = await repository.snapshot();
    const user = snapshot.users.find((candidate: Record<string, any>) => String(candidate.id) === String(subject.id)) || null;
    const memberships = repository.listMembershipsForUser ? await repository.listMembershipsForUser(subject.id) : [];
    return { user, subject, memberships };
  }

  async approveUser(userId: string, input: Record<string, any>, subject: Record<string, any>) {
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    return repository.approveUser(userId, { ...input, actorUserId: subject.id });
  }

  async rejectUser(userId: string, subject: Record<string, any>) {
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    return repository.rejectUser(userId, { actorUserId: subject.id });
  }

  async setUserQuota(userId: string, input: Record<string, any>, subject: Record<string, any>) {
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    return repository.setQuota({ ...input, userId });
  }

  async connectGitHub(input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const organizationId = input.organizationId || subject.organizationId;
    enforceScope(subject, { organizationId });
    return repository.createGitHubIntegration({ ...input, organizationId, userId: subject.id });
  }

  async listGitHub(organizationId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    enforceScope(subject, { organizationId });
    return { integrations: await repository.listGitHubIntegrations({ organizationId }) };
  }

  async attachGitHub(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    await assertServiceInProject(repository, projectId, serviceId);
    return repository.attachGitHubRepositoryToService({ projectId, serviceId, integrationId: input.integrationId, repoUrl: input.repoUrl || input.repository, branch: input.branch || 'main', actorUserId: subject.id });
  }

  githubLogin(input: Record<string, any> = {}) {
    return githubOAuthLoginPlan(input);
  }

  async githubCallback(input: Record<string, any> = {}) {
    if (input.code && !input.state) throw new BadRequestException('oauth_state_required');
    return {
      provider: 'github',
      received: true,
      codePresent: Boolean(input.code),
      state: input.state || null,
      mode: 'oauth-callback-pending',
      linked: false,
    };
  }

  async listGitHubInstallations(subject: Record<string, any>, organizationId?: string) {
    const repository: any = await this.repositoryPromise;
    const scopedOrganizationId = organizationId || subject.organizationId;
    enforceScope(subject, { organizationId: scopedOrganizationId });
    return repository.listGitHubInstallations({ organizationId: scopedOrganizationId });
  }

  async listGitHubInstallationRepositories(installationId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.listGitHubInstallationRepositories({ installationId, actorUserId: subject.id, organizationId: subject.organizationId, organizationIds: subject.organizationIds });
  }

  async importGitHubRepository(input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, input.projectId, subject);
    return repository.importGitHubRepository({ ...input, actorUserId: subject.id });
  }

  async syncGitHubRepository(repositoryId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.syncGitHubRepository({ ...input, repositoryId, actorUserId: subject.id, organizationId: subject.organizationId, organizationIds: subject.organizationIds });
  }

  async handleGitHubWebhook(input: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.handleGitHubWebhook(input);
  }
}

async function assertProjectAccess(repository: any, projectId: string, subject: Record<string, any>) {
  if (isGlobalSubject(subject)) return;
  let projectScopeError: any = null;
  try {
    requireScope(subject, { projectId });
    return;
  } catch (error) {
    projectScopeError = error;
    // Organization-scoped subjects may operate on projects in their organization.
  }
  if (!subject.organizationId && !Array.isArray(subject.organizationIds)) {
    throw new ForbiddenException(projectScopeError instanceof Error ? projectScopeError.message : 'subject scope does not allow this operation');
  }
  const snapshot = await repository.snapshot();
  const project = snapshot.projects.find((candidate: Record<string, any>) => String(candidate.id) === String(projectId));
  if (!project) throw new NotFoundException(`project not found: ${projectId}`);
  enforceScope(subject, { organizationId: project.organizationId });
}

async function assertServiceInProject(repository: any, projectId: string, serviceId: string) {
  const service = await repository.getService(serviceId);
  if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
  if (String(service.projectId) !== String(projectId)) throw new ForbiddenException('service does not belong to project');
  return service;
}

function enforceScope(subject: Record<string, any>, scope: Record<string, any>) {
  try {
    requireScope(subject, scope);
  } catch (error) {
    throw new ForbiddenException(error instanceof Error ? error.message : 'subject scope does not allow this operation');
  }
}

function isGlobalSubject(subject: Record<string, any>) {
  return subject?.global === true || subject?.authMode === 'disabled';
}

function assertAdmin(subject: Record<string, any>) {
  if (subject?.global === true || subject?.userRole === 'ADMIN' || subject?.claims?.userRole === 'ADMIN') return;
  throw new ForbiddenException('admin required');
}

function publicUser(user: Record<string, any>) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

function assertNestEnvironmentWriteAllowed(subject: Record<string, any>, entries: Array<Record<string, any>>) {
  try {
    return assertEnvironmentWriteAllowed(subject, entries);
  } catch (error) {
    throw new ForbiddenException(error instanceof Error ? error.message : 'role requires env:write to modify secret environment keys');
  }
}

function assertNestEmailVerified(user: Record<string, any>) {
  if (!user.emailVerifiedAt) throw new ForbiddenException('email_not_verified');
}

function nestAuthError(error: any) {
  const message = error instanceof Error ? error.message : 'auth_error';
  if (error?.statusCode === 400) return new BadRequestException(message);
  if (error?.statusCode === 403) return new ForbiddenException(message);
  if (error?.statusCode === 409) return new ConflictException(message);
  if (error?.statusCode === 404) return new NotFoundException(message);
  return error;
}

async function usersForRepository(repository: any) {
  if (repository?.store?.users) return [...repository.store.users.values()];
  const snapshot = repository.snapshot ? await repository.snapshot() : { users: [] };
  return snapshot.users || [];
}

function jwtSecretOrThrow() {
  const secret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  if (!secret) throw new Error('RAIBITSERVER_AUTH_JWT_SECRET is required');
  return secret;
}

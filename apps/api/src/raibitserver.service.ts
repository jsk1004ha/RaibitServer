import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import type { ProjectSpec, ServiceSpec, ResourceSpec } from '@raibitserver/schemas';
import type { IncomingMessage } from 'node:http';
import { consumeGitHubOAuthIdentity, startGitHubOAuth } from '@raibitserver/core';
import { assertCurrentSession, assertEnvironmentWriteAllowed, assertSystemDeploymentActor, authorizeSubject, createControlPlaneRepository, createGitHubAppAuthorizationPlan, createGitHubAppAuthorizationRetryPlan, createGitHubAppInstallationPlan, createSessionToken, enforceAuthAbuseLimits, issueSignupEmailVerificationCode, keysetCursorForRows, normalizeEmail, normalizeEnvEntries, organizationScopeFromProjectInput, parseDotEnv, publicSitesFromSnapshot, quotaUsageGauges, quotaWarnings, requireScope, resendEmailVerificationCode, resolveGitHubAppInstallationSelection, sanitizeDeploymentStatusInput, sanitizeTenantDeploymentCreate, sanitizeTenantResourceApiInput, sanitizeTenantResourceApiUpdate, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate, shouldPromoteFirstLogin, validateServiceSecurity, verifyEmailCodeAndCreateSession, verifyGitHubAppInstallationState, verifyPasswordAsync, type InMemoryControlPlaneRepository, type PrismaControlPlaneRepository } from '@raibitserver/core';

/**
 * NestJS-facing desired-state service.
 *
 * Production rule: the API stores desired state in PostgreSQL via Prisma and
 * enqueues durable workflow jobs; Go services reconcile Kubernetes/build/resource
 * actual state asynchronously. Local/dev can keep the same in-memory repository
 * instance for deterministic tests without split-brain state.
 */
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
    try {
      const email = normalizeEmail(input.email);
      await enforceAuthAbuseLimits(repository, { action: 'signup', email, source: authRateSource(context), env: process.env });
      const emailVerification = await issueSignupEmailVerificationCode(repository, { ...input, email }, { jwtSecret, issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver', env: process.env });
      return { emailVerification, signup: { status: 'verification_requested' } };
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async verifyEmail(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    const email = normalizeEmail(input.email);
    try {
      await enforceAuthAbuseLimits(repository, { action: 'email-verify', email, source: authRateSource(context), env: process.env });
      const result = await verifyEmailCodeAndCreateSession(repository, input, { jwtSecret, issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver', env: process.env });
      return { ...result, user: publicUser(result.user) };
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async resendEmailVerification(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    try {
      const email = normalizeEmail(input.email);
      await enforceAuthAbuseLimits(repository, { action: 'email-resend', email, source: authRateSource(context), env: process.env });
      const emailVerification = await resendEmailVerificationCode(repository, input, { jwtSecret, issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver', env: process.env });
      return { emailVerification };
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async login(input: Record<string, any>, context: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    let email: string;
    try {
      email = normalizeEmail(input.email);
      await enforceAuthAbuseLimits(repository, { action: 'login', email, source: authRateSource(context), env: process.env });
    } catch (error) {
      throw nestAuthError(error);
    }
    let user = repository.findUserByEmail ? await repository.findUserByEmail(email) : repository.store.findUserByEmail(email);
    const passwordValid = await verifyPasswordAsync(input.password, user?.passwordHash);
    if (!user || !passwordValid) {
      throw new ForbiddenException('invalid credentials');
    }
    assertNestEmailVerified(user);
    if (process.env.NODE_ENV !== 'production' && shouldPromoteFirstLogin(user, await usersForRepository(repository))) {
      user = await repository.approveUser(user.id, { accountType: 'NON_CLUB', role: 'ADMIN', actorUserId: 'system' });
    }
    assertNestUserApproved(user);
    const memberships = repository.listMembershipsForUser ? await repository.listMembershipsForUser(user.id) : repository.store.listMembershipsForUser(user.id);
    const token = createSessionToken(user, memberships, jwtSecret, { issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver' });
    const { passwordHash, ...publicUser } = user;
    return { user: publicUser, memberships, token };
  }

  async createProject(project: ProjectSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const projectInput = project as any;
    const organizationId = organizationScopeFromProjectInput(projectInput, subject);
    enforceScope(subject, { organizationId });
    const desiredProject = {
      ...projectInput,
      organizationId,
      actorUserId: subject.id,
      services: (projectInput.services || []).map((service: Record<string, any>) => sanitizeTenantServiceInput(service)),
      resources: (projectInput.resources || []).map((resource: Record<string, any>) => sanitizeTenantResourceApiInput(resource)),
    };
    delete desiredProject.status;
    if (desiredProject.project && typeof desiredProject.project === 'object') {
      desiredProject.project = {
        name: desiredProject.project.name,
        slug: desiredProject.project.slug,
        description: desiredProject.project.description || '',
      };
    }
    const result = await repositoryMutation(() => repository.writeDesiredProject(desiredProject));
    return result.project || result;
  }

  async listProjects(subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    if (isGlobalSubject(subject)) {
      const projects = repository.listProjectsForOrganizations ? await paginationRead(() => repository.listProjectsForOrganizations(undefined, options)) : (await repository.snapshot()).projects;
      return keysetPage('projects', projects, 'createdAt');
    }
    const organizationIds = new Set([subject.organizationId, ...(subject.organizationIds || [])].filter(Boolean).map(String));
    if (!organizationIds.size) return keysetPage('projects', [], 'createdAt');
    const projects = repository.listProjectsForOrganizations
      ? await paginationRead(() => repository.listProjectsForOrganizations([...organizationIds], options))
      : (await repository.snapshot()).projects.filter((project: Record<string, any>) => organizationIds.has(String(project.organizationId)));
    return keysetPage('projects', projects, 'createdAt');
  }

  async listPublicSites(limit: any = 5) {
    const repository: any = await this.repositoryPromise;
    return repository.listPublicSites ? repository.listPublicSites(limit) : publicSitesFromSnapshot(await repository.snapshot(), limit);
  }

  async getProject(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = repository.getProject ? await repository.getProject(projectId) : (await repository.snapshot()).projects.find((candidate: Record<string, any>) => String(candidate.id) === String(projectId));
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return project;
  }

  async projectOverview(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const [project, services, resources, deployments] = await Promise.all([
      repository.getProject(projectId),
      repository.listServicesForProject(projectId),
      repository.listResourcesForProject(projectId),
      repository.listDeploymentsForProject ? repository.listDeploymentsForProject(projectId, { limit: 200 }) : [],
    ]);
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return { project, services, resources, deployments };
  }

  async updateProject(projectId: string, updates: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = await repositoryMutation(() => repository.updateProject ? repository.updateProject(projectId, updates || {}) : repository.store.updateProject(projectId, updates || {}));
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return project;
  }

  async deleteProject(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = repository.deleteProject ? await repository.deleteProject(projectId) : repository.store.deleteProject(projectId);
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    if (isDeletionTombstone(project)) return { deletionRequested: true, status: String(project.status).toUpperCase(), projectId: project.id || projectId };
    return { deleted: true, projectId: project.id || projectId };
  }

  async listServices(projectId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const services = repository.listServicesForProject ? await paginationRead(() => repository.listServicesForProject(projectId, options)) : (await repository.snapshot()).services.filter((service: Record<string, any>) => String(service.projectId) === String(projectId));
    return keysetPage('services', services, 'createdAt');
  }

  async addService(projectId: string, service: ServiceSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    return repositoryMutation(() => repository.createService({ ...sanitizeTenantServiceInput(service), projectId, actorUserId: subject.id }));
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
    const service = await repositoryMutation(() => {
      const safeUpdates = sanitizeTenantServiceUpdate(updates || {});
      return repository.updateService ? repository.updateService(serviceId, safeUpdates, { actorUserId: subject.id }) : repository.store.updateService(serviceId, safeUpdates, { actorUserId: subject.id });
    });
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
    if (isDeletionTombstone(service)) return { deletionRequested: true, status: String(service.status).toUpperCase(), serviceId: service.id || serviceId };
    return { deleted: true, serviceId: service.id || serviceId };
  }

  async listResources(projectId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const resources = repository.listResourcesForProject ? await paginationRead(() => repository.listResourcesForProject(projectId, options)) : (await repository.snapshot()).resources.filter((resource: Record<string, any>) => String(resource.projectId) === String(projectId));
    return keysetPage('resources', resources, 'createdAt');
  }

  async addResource(projectId: string, resource: ResourceSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const safeResource = sanitizeTenantResourceApiInput(resource);
    return repositoryMutation(() => repository.createResource({ ...safeResource, projectId, actorUserId: subject.id }));
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
    const resource = await repositoryMutation(() => {
      const safeUpdates = sanitizeTenantResourceApiUpdate(updates);
      return repository.updateResource ? repository.updateResource(resourceId, safeUpdates) : repository.store.updateResource(resourceId, safeUpdates);
    });
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    return resource;
  }

  async deleteResource(resourceId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const current = await this.getResource(resourceId, subject);
    const resource = repository.deleteResource ? await repository.deleteResource(resourceId) : repository.store.deleteResource(resourceId);
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    if (isDeletionTombstone(resource)) return { deletionRequested: true, status: String(resource.status).toUpperCase(), resourceId: current.id || resourceId };
    return { deleted: true, resourceId: current.id || resourceId };
  }

  async attachResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = await this.getResource(resourceId, subject);
    const service = repository.getService ? await repository.getService(input.serviceId) : (await repository.snapshot()).services.find((candidate: Record<string, any>) => String(candidate.id) === String(input.serviceId));
    if (!service) throw new NotFoundException(`service not found: ${input.serviceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    if (String(service.projectId) !== String(resource.projectId)) throw new ForbiddenException('resource and service must be in the same project');
    return repositoryMutation(() => repository.attachResource({ ...input, resourceId, actorUserId: subject.id }));
  }

  async provisionResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await this.getResource(resourceId, subject);
    return repositoryMutation(() => repository.provisionResourceProvider({ ...input, resourceId, actorUserId: subject.id }));
  }

  async listDeployments(projectId: string, serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertServiceInProject(repository, projectId, serviceId);
    await assertProjectAccess(repository, projectId, subject);
    const deployments = repository.listDeploymentsForService ? await paginationRead(() => repository.listDeploymentsForService(serviceId, options)) : (await repository.snapshot()).deployments.filter((deployment: Record<string, any>) => String(deployment.serviceId) === String(serviceId));
    return keysetPage('deployments', deployments, 'createdAt');
  }

  async createDeployment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw new ForbiddenException('service does not belong to project');
    const deploymentType = input.deploymentType || input.type || 'production';
    const branch = input.branch || service.branch || 'main';
    const security = validateServiceSecurity(service.desiredState || service.desiredSpec || service);
    if (!security.ok) throw new ForbiddenException(`deployment blocked by security policy: ${security.findings.filter((finding: any) => finding.level === 'block').map((finding: any) => finding.code).join(', ')}`);
    const { deployment, workflowJob } = await repositoryMutation(() => repository.createDeploymentWorkflow({
      actorUserId: subject.id,
      deployment: { ...sanitizeTenantDeploymentCreate(input), serviceId, projectId, status: 'queued', deploymentType, branch },
      workflow: { type: deploymentType === 'preview' ? 'preview-deploy' : 'build-and-deploy', payload: { projectId, serviceId, branch, commitSha: input.commitSha || input.commitHash || null } },
    }));
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
    try {
      return repository.cancelDeployment
        ? await repository.cancelDeployment(deploymentId, { ...input, actorUserId: subject.id })
        : await repository.store.cancelDeployment(deploymentId, { ...input, actorUserId: subject.id });
    } catch (error) {
      if ((error as any)?.statusCode === 409) throw new ConflictException(error instanceof Error ? error.message : 'deployment_cancellation_conflict');
      throw error;
    }
  }

  async rollbackDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>) {
    if (input?.confirmed !== true && input?.confirmed !== 'true') throw new BadRequestException('confirmation_required');
    const repository: any = await this.repositoryPromise;
    const deployment = await this.getDeployment(deploymentId, subject);
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

  async listDeploymentsForService(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return this.listDeployments(service.projectId, serviceId, subject, options);
  }

  async listDeploymentLogs(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    return paginationRead(async () => activityPage('logs', await repository.listDeploymentLogs(deploymentId, options)));
  }

  async listDeploymentEvents(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    return paginationRead(async () => activityPage('events', await repository.listDeploymentEvents(deploymentId, options)));
  }

  async deploymentActivitySnapshot(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    const [logs, events] = await paginationRead(() => Promise.all([
      repository.listDeploymentLogs(deploymentId, { cursor: options.logCursor, limit: options.limit }),
      repository.listDeploymentEvents(deploymentId, { cursor: options.eventCursor, limit: options.limit }),
    ]));
    const deploymentCursor = entityVersion(deployment);
    return {
      deployment: !options.deploymentCursor || options.deploymentCursor !== deploymentCursor ? deployment : null,
      logs,
      events,
      deploymentCursor,
      logCursor: keysetCursorForRows(logs, 'timestamp') || options.logCursor || null,
      eventCursor: keysetCursorForRows(events, 'timestamp') || options.eventCursor || null,
      stream: sseStreamConfig(),
    };
  }

  async listRuntimeLogs(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    return paginationRead(async () => activityPage('logs', await repository.listRuntimeLogs(serviceId, options)));
  }

  async serviceLogSnapshot(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    const logs = await paginationRead<Array<Record<string, any>>>(() => repository.listRuntimeLogs(serviceId, { cursor: options.logCursor, limit: options.limit }));
    const serviceCursor = entityVersion(service);
    return {
      service: !options.serviceCursor || options.serviceCursor !== serviceCursor ? service : null,
      logs,
      serviceCursor,
      logCursor: keysetCursorForRows(logs, 'timestamp') || options.logCursor || null,
      stream: sseStreamConfig(),
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
    const snapshot = repository.listUsageRecordsForUser && repository.getQuotaForUser ? null : await repository.snapshot();
    const usage = repository.listUsageRecordsForUser
      ? await repository.listUsageRecordsForUser(subject.id, { limit: 200 })
      : (snapshot?.usageRecords || []).filter((row: Record<string, any>) => String(row.userId) === String(subject.id));
    const unlimited = subject.userRole === 'ADMIN' || subject.accountType === 'CLUB_MEMBER';
    const quota = unlimited ? null : repository.getQuotaForUser
      ? await repository.getQuotaForUser(subject.id)
      : (snapshot?.quotas || []).find((row: Record<string, any>) => String(row.userId) === String(subject.id)) || null;
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
    const user = repository.findUserById
      ? publicUser(await repository.findUserById(subject.id))
      : (await repository.snapshot()).users.find((candidate: Record<string, any>) => String(candidate.id) === String(subject.id)) || null;
    const memberships = repository.listMembershipsForUser ? await repository.listMembershipsForUser(subject.id) : [];
    return { user, subject, memberships };
  }

  async logout(subject: Record<string, any>) {
    await this.validateSessionSubject(subject);
    if (subject?.authMode !== 'jwt' || subject?.global === true || subject?.claims?.global === true) return { ok: true };
    const repository: any = await this.repositoryPromise;
    if (repository.incrementSessionVersion) await repository.incrementSessionVersion(subject.id);
    else repository.store.incrementSessionVersion(subject.id);
    return { ok: true };
  }

  async validateSessionSubject(subject: Record<string, any>) {
    if (subject?.authMode !== 'jwt' || subject?.global === true || subject?.claims?.global === true) return true;
    const repository: any = await this.repositoryPromise;
    const user = repository.findUserById
      ? await repository.findUserById(subject.id)
      : repository.store?.findUserById(subject.id);
    try {
      return assertCurrentSession(subject, user);
    } catch (error) {
      throw new UnauthorizedException(error instanceof Error ? error.message : 'session is not valid');
    }
  }

  async approveUser(userId: string, input: Record<string, any>, subject: Record<string, any>) {
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    return repository.approveUser(userId, { ...input, actorUserId: subject.id });
  }

  async rejectUser(userId: string, input: Record<string, any>, subject: Record<string, any>) {
    if (input?.confirmed !== true && input?.confirmed !== 'true') throw new BadRequestException('confirmation_required');
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    return repository.rejectUser(userId, { ...input, actorUserId: subject.id });
  }

  async banUser(userId: string, input: Record<string, any>, subject: Record<string, any>) {
    assertAdmin(subject);
    if (String(userId) === String(subject.id)) throw new BadRequestException('cannot_ban_self');
    const repository: any = await this.repositoryPromise;
    return repository.banUser(userId, { ...input, actorUserId: subject.id });
  }

  async unbanUser(userId: string, input: Record<string, any>, subject: Record<string, any>) {
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    return repository.unbanUser(userId, { ...input, actorUserId: subject.id });
  }

  async adminOverview(subject: Record<string, any>, options: Record<string, any> = {}) {
    assertAdmin(subject);
    const repository: any = await this.repositoryPromise;
    if (repository.adminOverview) return repository.adminOverview(options);
    const snapshot = await repository.snapshot();
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 200)));
    return {
      users: (snapshot.users || []).slice(-limit).map(publicUser),
      quotas: (snapshot.quotas || []).slice(-limit),
      auditLogs: (snapshot.auditLogs || []).slice(-limit).reverse(),
    };
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

  githubAppInstall(subject: Record<string, any>) {
    const organizationId = githubOrganizationId(subject);
    enforceScope(subject, { organizationId });
    try {
      return createGitHubAppInstallationPlan({ userId: subject.id, organizationId });
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  githubAppAuthorize(input: Record<string, any>, subject: Record<string, any>) {
    const organizationId = githubOrganizationId(subject);
    enforceScope(subject, { organizationId });
    try {
      return createGitHubAppAuthorizationPlan({ ...input, userId: subject.id, organizationId });
    } catch (error) {
      throw nestAuthError(error);
    }
  }

  async githubAppComplete(input: Record<string, any>, subject: Record<string, any>) {
    const organizationId = githubOrganizationId(subject);
    enforceScope(subject, { organizationId });
    try {
      let callbackState;
      try {
        callbackState = verifyGitHubAppInstallationState(input.state, {
          userId: subject.id,
          organizationId,
          purpose: 'github-app-authorize',
        });
      } catch (error) {
        if ((error as any)?.code !== 'github_install_state_expired') throw error;
        const retry = createGitHubAppAuthorizationRetryPlan({
          state: input.state,
          userId: subject.id,
          organizationId,
        });
        return {
          connected: false,
          resumeRequired: true,
          authorizationUrl: retry.authorizationUrl,
        };
      }
      const selection = await resolveGitHubAppInstallationSelection({
        code: input.code,
        installationId: callbackState.installationId,
      });
      const repository: any = await this.repositoryPromise;
      const integration = await repository.connectVerifiedGitHubInstallation({
        organizationId,
        userId: subject.id,
        installationId: selection.installationId,
        accountLogin: selection.accountLogin,
        accountType: selection.accountType,
        verifiedBy: subject.id,
      });
      const catalog = await repository.replaceGitHubInstallationRepositories({
        installationId: selection.installationId,
        repositories: selection.repositories,
        actorUserId: subject.id,
      });
      return {
        connected: true,
        integration: {
          id: integration.id,
          installationId: integration.installationId,
          accountLogin: integration.accountLogin,
          verifiedAt: integration.verifiedAt,
        },
        repositoryCount: catalog.repositoryCount,
      };
    } catch (error) {
      throw nestAuthError(error);
    }
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
    return repository.attachGitHubRepositoryToService({
      projectId,
      serviceId,
      integrationId: input.integrationId,
      repositoryId: input.repositoryId || input.githubRepositoryId,
      repository: input.repository,
      repoUrl: input.repoUrl,
      branch: input.branch,
      actorUserId: subject.id,
    });
  }

  async githubLogin(input: Record<string, unknown>, request: IncomingMessage) {
    try {
      return await startGitHubOAuth(await this.repositoryPromise, input, {
        source: request.socket.remoteAddress || '', jwtSecret: process.env.RAIBITSERVER_AUTH_JWT_SECRET,
      });
    } catch (error) { throw nestAuthError(error); }
  }

  async githubCallback(input: Record<string, unknown>, request: IncomingMessage) {
    const repository = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    let identity;
    try {
      identity = await consumeGitHubOAuthIdentity(repository, input, { source: request.socket.remoteAddress || '', jwtSecret });
    } catch (error) {
      throw nestAuthError(error);
    }
    let user = await repository.findUserByGitHubId(identity.githubId);
    if (!user) user = await repository.findUserByEmail(identity.email);
    if (!user) throw new ForbiddenException('github_account_not_registered');
    assertNestEmailVerified(user);
    assertNestUserApproved(user);
    try {
      user = await repository.linkGitHubUser(user.id, {
        githubId: identity.githubId,
        githubLogin: identity.githubLogin,
        avatarUrl: identity.avatarUrl,
        name: user.name ? null : identity.name,
        actorUserId: user.id,
      });
    } catch (error) {
      throw nestAuthError(error);
    }
    const memberships = await repository.listMembershipsForUser(user.id);
    const token = createSessionToken(user, memberships, jwtSecret, { issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver' });
    return {
      provider: 'github',
      received: true,
      codePresent: true,
      mode: 'oauth-complete',
      linked: true,
      user: publicUser(user),
      memberships,
      token,
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
    let authorizedTargets: Record<string, any> = {
      organizationId: subject.organizationId,
      organizationIds: subject.organizationIds,
      serviceIds: null,
    };
    if (!isGlobalSubject(subject)) {
      const services = await repository.listServicesForGitHubRepository(repositoryId, {
        organizationId: subject.organizationId,
        organizationIds: subject.organizationIds,
      });
      const organizationIds = new Set<string>();
      for (const service of services) {
        const project = service.project || await repository.getProject(service.projectId);
        if (!project?.organizationId) throw new NotFoundException(`project not found: ${service.projectId}`);
        enforceActionScope(subject, 'deploy:run', { organizationId: project.organizationId });
        organizationIds.add(String(project.organizationId));
      }
      authorizedTargets = {
        organizationId: null,
        organizationIds: [...organizationIds],
        serviceIds: services.map((service: Record<string, any>) => service.id),
      };
    }
    return repository.syncGitHubRepository({
      ...input,
      repository: repositoryId,
      repositoryId,
      actorUserId: subject.id,
      ...authorizedTargets,
    });
  }

  async handleGitHubWebhook(input: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.handleGitHubWebhook(input);
  }
}

async function assertProjectAccess(repository: any, projectId: string, subject: Record<string, any>) {
  if (isGlobalSubject(subject)) return;
  const project = repository.getProject
    ? await repository.getProject(projectId)
    : (await repository.snapshot()).projects.find((candidate: Record<string, any>) => String(candidate.id) === String(projectId));
  if (!project) throw new NotFoundException(`project not found: ${projectId}`);
  if (subject.projectId || Array.isArray(subject.projectIds)) enforceScope(subject, { projectId });
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

function enforceActionScope(subject: Record<string, any>, action: string, scope: Record<string, any>) {
  try {
    authorizeSubject({ ...subject }, action, scope);
  } catch (error) {
    throw new ForbiddenException(error instanceof Error ? error.message : `subject cannot perform ${action} in this scope`);
  }
}

function isGlobalSubject(subject: Record<string, any>) {
  return subject?.global === true || subject?.claims?.global === true || subject?.authMode === 'disabled';
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

function assertNestUserApproved(user: Record<string, any>) {
  if (isActiveUserBan(user)) throw new ForbiddenException('account_banned');
  if (String(user?.approvalStatus || 'PENDING').toUpperCase() !== 'APPROVED') {
    throw new ForbiddenException('account_not_approved');
  }
}

function githubOrganizationId(subject: Record<string, any>) {
  const organizationId = String(subject?.organizationId || '').trim();
  if (!organizationId) throw new BadRequestException('organization_scope_required');
  return organizationId;
}

function isActiveUserBan(user: Record<string, any>, now = Date.now()) {
  if (!user?.bannedAt) return false;
  if (!user.banExpiresAt) return true;
  const expiresAt = new Date(user.banExpiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function authRateLimitError(resetAt: number) {
  const error = new Error('rate_limit_exceeded');
  (error as any).statusCode = 429;
  (error as any).retryAfterSeconds = Math.max(1, Math.ceil((Number(resetAt) - Date.now()) / 1000));
  return error;
}

function isDeletionTombstone(row: Record<string, any> | null | undefined) {
  return ['DELETE_REQUESTED', 'DELETING'].includes(String(row?.status || '').toUpperCase());
}

async function repositoryMutation<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw nestAuthError(error);
  }
}

function nestAuthError(error: any) {
  const message = error instanceof Error ? error.message : 'auth_error';
  if (error?.statusCode === 400) return new BadRequestException(message);
  if (error?.statusCode === 403) return new ForbiddenException(message);
  if (error?.statusCode === 409) return new ConflictException(message);
  if (error?.statusCode === 404) return new NotFoundException(message);
  if (error?.statusCode === 401) return new UnauthorizedException(message);
  if (error?.statusCode === 429) return new HttpException(message, 429);
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) return new HttpException(message, error.statusCode);
  return error;
}

async function usersForRepository(repository: any) {
  if (repository?.store?.users) return [...repository.store.users.values()];
  if (repository?.listUsers) return repository.listUsers();
  const snapshot = repository.snapshot ? await repository.snapshot() : { users: [] };
  return snapshot.users || [];
}

function activityPage(key: 'logs' | 'events', rows: Array<Record<string, any>>) {
  return { [key]: rows, nextCursor: keysetCursorForRows(rows, 'timestamp') };
}

function keysetPage(key: 'projects' | 'services' | 'resources' | 'deployments', rows: Array<Record<string, any>>, timestampField: string) {
  return { [key]: rows, nextCursor: keysetCursorForRows(rows, timestampField) };
}

async function paginationRead<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if ((error as any)?.statusCode === 400) throw new BadRequestException(error instanceof Error ? error.message : 'invalid cursor');
    throw error;
  }
}

function entityVersion(row: Record<string, any>) {
  return `${row?.updatedAt || row?.createdAt || ''}:${row?.status || ''}:${row?.id || ''}`;
}

function sseStreamConfig() {
  return {
    mode: 'sse-keyset-delta',
    retryMs: Number(process.env.RAIBITSERVER_SSE_RETRY_MS || 3_000),
    heartbeatMs: Number(process.env.RAIBITSERVER_SSE_HEARTBEAT_MS || 15_000),
    maxLifetimeMs: Number(process.env.RAIBITSERVER_SSE_MAX_LIFETIME_MS || 15 * 60_000),
    slowClientTimeoutMs: Number(process.env.RAIBITSERVER_SSE_SLOW_CLIENT_TIMEOUT_MS || 5_000),
  };
}

function jwtSecretOrThrow() {
  const secret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
  if (!secret) throw new Error('RAIBITSERVER_AUTH_JWT_SECRET is required');
  return secret;
}

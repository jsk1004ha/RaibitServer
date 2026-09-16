import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { decodeDeploymentActivityResumeToken, decodeServiceLogResumeToken, DeploymentActivityResumeTokenError, DeploymentOperationError, DomainLifecycleError, EnvironmentError, GitHubSourceConflict, parseDeploymentHistoryQuery, parseDeploymentOperationBody, parseEnvironmentSelector, roleForOrganization } from '@raibitserver/core';
import { projectObservationPayload } from '@raibitserver/core';
import { ProjectSettingsError } from '@raibitserver/core';
import { EnvironmentCreateSchema, EnvironmentDeleteSchema, PasswordRecoveryCompleteSchema, PasswordRecoveryRequestSchema, ResourceBackupListSchema, type CustomDomainCreate, type CustomDomainMutation, type CustomDomainRotate, type EnvironmentCreate, type EnvironmentDelete, type ProjectDeletionScheduled, type ProjectSettingsUpdate, type ProjectSettingsView, type ResourceBackupCreate, type ResourceBackupDelete, type ResourceBackupList, type ResourceRestoreCreate, type ProjectSpec, type ServiceReplacementInput, type ServiceSettingsMutation, type ServiceSpec, type ResourceSpec } from '@raibitserver/schemas';
import type { IncomingMessage } from 'node:http';
import { consumeGitHubOAuthIdentity, startGitHubOAuth, oauthAttempt, OAuthPublicError } from '@raibitserver/core';
import { assertCurrentSession, assertEnvironmentWriteAllowed, assertSystemDeploymentActor, authorizeSubject, completePasswordRecovery, createControlPlaneRepository, createGitHubAppAuthorizationPlan, createGitHubAppAuthorizationRetryPlan, createGitHubAppInstallationPlan, createSessionToken, enforceAuthAbuseLimits, issueSignupEmailVerificationCode, keysetCursorForRows, normalizeEmail, normalizeEnvEntries, organizationScopeFromProjectInput, parseDotEnv, publicSitesFromSnapshot, quotaUsageGauges, quotaWarnings, requestPasswordRecovery, requireScope, resendEmailVerificationCode, resolveGitHubAppInstallationSelection, sanitizeDeploymentStatusInput, sanitizeTenantDeploymentCreate, sanitizeTenantResourceApiInput, sanitizeTenantResourceApiUpdate, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate, shouldPromoteFirstLogin, validateServiceSecurity, verifyEmailCodeAndCreateSession, verifyGitHubAppInstallationState, verifyPasswordAsync, type InMemoryControlPlaneRepository, type PrismaControlPlaneRepository } from '@raibitserver/core';
import { RecoveryError, ResourceCapabilityUnavailable, ResourceIntentInvalid, publicRecovery, resourceAvailability, resourceStorageMb, can, listCatalog } from '@raibitserver/core';
import { acceptOrganizationInvite, assertInteractiveOrganizationCreator, OrganizationCreationError, issueOrganizationInvite, listOrganizationInvites } from '@raibitserver/core';
import { changeOrganizationMembershipRole, leaveOrganization, listOrganizationMembers, removeOrganizationMember, revokeOrganizationInvite } from '@raibitserver/core';
import type { OrganizationCreateRequest, OrganizationInviteCreate, OrganizationMembershipRoleChange, OrganizationMembershipSnapshot } from '@raibitserver/schemas';
import type { ResourceRecoveryRepository, RecoveryScope } from '@raibitserver/core';

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

type PasswordResetContext = Readonly<{ request?: IncomingMessage; response?: import('node:http').ServerResponse }>;

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

  async requireOperationalPrismaClient() {
    const repository = await this.repositoryPromise;
    return repository.requireOperationalPrismaClient();
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

  async requestPasswordReset(input: Record<string, unknown>, context: PasswordResetContext = {}) {
    const parsed = PasswordRecoveryRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('password_reset_input_invalid');
    const repository = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    try {
      await enforceAuthAbuseLimits(repository, { action: 'password-reset', email: parsed.data.email, source: authRateSource(context), env: process.env });
      return await requestPasswordRecovery(repository, parsed.data, { jwtSecret, env: process.env });
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 429) {
        context.response?.setHeader('Retry-After', String('retryAfterSeconds' in error ? error.retryAfterSeconds : 60));
      }
      throw nestAuthError(error);
    }
  }

  async completePasswordReset(input: Record<string, unknown>, context: PasswordResetContext = {}) {
    const parsed = PasswordRecoveryCompleteSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('password_reset_input_invalid');
    const repository = await this.repositoryPromise;
    const jwtSecret = jwtSecretOrThrow();
    try {
      await enforceAuthAbuseLimits(repository, { action: 'password-reset-complete', email: parsed.data.email, source: authRateSource(context), env: process.env });
      return await completePasswordRecovery(repository, parsed.data, { jwtSecret, env: process.env });
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
    delete desiredProject.environmentId;
    delete desiredProject.environmentKind;
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

  async listEnvironments(projectId: string, subject: Record<string, unknown>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    return { environments: await repository.listEnvironments(projectId) };
  }

  async createEnvironment(projectId: string, input: EnvironmentCreate, subject: Record<string, unknown>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    if (!can(subject.role, 'environment:manage')) throw new ForbiddenException('role requires environment:manage');
    if (process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED !== '1') throw new ConflictException('ENVIRONMENT_FEATURE_DISABLED');
    const parsed = EnvironmentCreateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('ENVIRONMENT_INPUT_INVALID');
    return repositoryMutation(() => repository.createEnvironment({ ...parsed.data, projectId, actorUserId: subject.id }));
  }

  async deleteEnvironment(projectId: string, environmentId: string, input: EnvironmentDelete, subject: Record<string, unknown>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    if (!can(subject.role, 'environment:manage')) throw new ForbiddenException('role requires environment:manage');
    if (process.env.RAIBITSERVER_OPERATIONAL_FEATURES_ENABLED !== '1') throw new ConflictException('ENVIRONMENT_FEATURE_DISABLED');
    const parsed = EnvironmentDeleteSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('ENVIRONMENT_INPUT_INVALID');
    return repositoryMutation(() => repository.deleteEnvironment({ ...parsed.data, projectId, environmentId, actorUserId: subject.id }));
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

  async createOrganization(input: OrganizationCreateRequest, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    const actorUserId = assertInteractiveOrganizationCreator(subject);
    return repositoryMutation(() => repository.createOrganizationForUser({ ...input, actorUserId }));
  }

  async issueOrganizationInvite(organizationId: string, input: OrganizationInviteCreate, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    enforceScope(subject, { organizationId });
    return repositoryMutation(() => issueOrganizationInvite(repository, { organizationId, email: input.email, role: input.role, actorUserId: String(subject.id) }));
  }

  async listOrganizationInvites(organizationId: string, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    enforceScope(subject, { organizationId });
    return repositoryMutation(() => listOrganizationInvites(repository, { organizationId, actorUserId: String(subject.id) }));
  }

  async acceptOrganizationInvite(token: string, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => acceptOrganizationInvite(repository, { token, userId: String(subject.id) }));
  }

  async listOrganizationMembers(organizationId: string, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => listOrganizationMembers(repository, { organizationId, actorUserId: String(subject.id) }));
  }

  async changeOrganizationMembershipRole(input: OrganizationMembershipRoleChange & { readonly organizationId: string; readonly membershipId: string }, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => changeOrganizationMembershipRole(repository, { ...input, actorUserId: String(subject.id) }));
  }

  async removeOrganizationMember(input: OrganizationMembershipSnapshot & { readonly organizationId: string; readonly membershipId: string }, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => removeOrganizationMember(repository, { ...input, actorUserId: String(subject.id) }));
  }

  async leaveOrganization(organizationId: string, input: OrganizationMembershipSnapshot, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => leaveOrganization(repository, { organizationId, actorUserId: String(subject.id), ...input }));
  }

  async revokeOrganizationInvite(input: { readonly organizationId: string; readonly inviteId: string }, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => revokeOrganizationInvite(repository, { ...input, actorUserId: String(subject.id) }));
  }

  async getProject(projectId: string, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = repository.getProject ? await repository.getProject(projectId) : (await repository.snapshot()).projects.find((candidate: Record<string, any>) => String(candidate.id) === String(projectId));
    if (!project) throw new NotFoundException(`project not found: ${projectId}`);
    return project;
  }

  async assertScopedRequestAccess(params: Readonly<Record<string, unknown>>, selector: Readonly<Record<string, unknown>>, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    if (typeof params.projectId === 'string') await assertProjectAccess(repository, params.projectId, subject);
    const readers = {
      serviceId: (id: string) => repository.getService(id),
      resourceId: (id: string) => repository.getResource(id),
      deploymentId: (id: string) => repository.getDeployment(id),
      domainId: async (id: string) => {
        const domain = await repository.getCustomDomain(id);
        return domain ? assertServiceInProject(repository, domain.projectId, domain.serviceId) : null;
      },
      backupId: (id: string) => this.recoveryRequestResource('backup', id, subject),
      restoreId: (id: string) => this.recoveryRequestResource('restore', id, subject),
    };
    for (const [param, read] of Object.entries(readers)) {
      const id = params[param];
      if (typeof id !== 'string') continue;
      const entity = await read(id);
      if (!entity || (typeof params.projectId === 'string' && params.projectId !== entity.projectId)) throw new NotFoundException('SCOPE_NOT_FOUND');
      await assertProjectAccess(repository, entity.projectId, subject);
      await assertEntityEnvironment(repository, entity, selector);
    }
  }

  private async recoveryRequestResource(kind: 'backup' | 'restore', id: string, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(() => this.withRecoveryScope(repository, subject, (recovery: ResourceRecoveryRepository, scope: RecoveryScope) => recovery.transaction.run(scope.organizationId, state => {
      let resourceId: string | undefined;
      switch (kind) {
        case 'backup':
          resourceId = state.backups.find(row => row.id === id && row.organizationId === scope.organizationId)?.resourceId
            ?? state.legacyBackups.find(row => row.id === id)?.resourceId;
          break;
        case 'restore':
          resourceId = state.restores.find(row => row.id === id && row.organizationId === scope.organizationId)?.targetResourceId;
          break;
        default:
          throw new NotFoundException(kind satisfies never);
      }
      const resource = state.resources.find(row => row.id === resourceId);
      if (!resource || !state.projects.some(project => project.id === resource.projectId && project.organizationId === scope.organizationId)) throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
      return resource;
    })));
  }

  async projectOverview(projectId: string, subject: Record<string, any>, selector: Record<string, unknown> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const environment = await repositoryMutation(() => repository.resolveEnvironment(projectId, parseEnvironmentSelector(selector)));
    const scope = { environmentId: environment.id };
    const [project, services, resources, deployments] = await Promise.all([
      repository.getProject(projectId),
      repository.listServicesForProject(projectId, scope),
      repository.listResourcesForProject(projectId, scope),
      repository.listDeploymentsForProject(projectId, { ...scope, limit: 200 }),
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

  async getProjectSettings(projectId: string, subject: Record<string, unknown>): Promise<ProjectSettingsView> {
    const repository = await this.repositoryPromise;
    const project = await assertProjectAccess(repository, projectId, subject);
    const settings = await repository.getProjectSettings(projectId, String(project.organizationId));
    if (!settings) throw new NotFoundException(`project not found: ${projectId}`);
    return settings;
  }

  async updateProjectSettings(projectId: string, input: ProjectSettingsUpdate, subject: Record<string, unknown>): Promise<ProjectSettingsView> {
    const repository = await this.repositoryPromise;
    const project = await assertProjectAccess(repository, projectId, subject);
    const settings = await repositoryMutation(() => repository.updateProjectSettings({
      projectId,
      organizationId: String(project.organizationId),
      actorUserId: typeof subject.id === 'string' ? subject.id : null,
      ...input,
    }));
    if (!settings) throw new NotFoundException(`project not found: ${projectId}`);
    return settings;
  }

  async scheduleProjectDeletion(projectId: string, subject: Record<string, unknown>): Promise<ProjectDeletionScheduled> {
    const repository = await this.repositoryPromise;
    const project = await assertProjectAccess(repository, projectId, subject);
    const scheduled = await repositoryMutation(() => repository.scheduleProjectDeletion({
      projectId,
      organizationId: String(project.organizationId),
      actorUserId: typeof subject.id === 'string' ? subject.id : null,
    }));
    if (!scheduled) throw new NotFoundException(`project not found: ${projectId}`);
    return scheduled;
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
    const services = repository.listServicesForProject ? await repositoryMutation(() => paginationRead(() => repository.listServicesForProject(projectId, options))) : (await repository.snapshot()).services.filter((service: Record<string, any>) => String(service.projectId) === String(projectId));
    return keysetPage('services', services, 'createdAt');
  }

  async addService(projectId: string, service: ServiceSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const selector = parseEnvironmentSelector({ environmentId: service.environmentId, kind: service.kind, environmentKind: service.environmentKind,
      ...(typeof service.environment === 'object' && service.environment !== null && !Array.isArray(service.environment) ? {} : { environment: service.environment }) });
    const environment = await repositoryMutation(() => repository.resolveEnvironment(projectId, selector));
    return repositoryMutation(() => repository.createService({ ...sanitizeTenantServiceInput(service), environmentId: environment.id, environmentKind: environment.kind, projectId, actorUserId: subject.id }));
  }

  async getService(serviceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, selector);
    return service;
  }

  async updateService(serviceId: string, updates: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const current = await repository.getService(serviceId);
    if (!current) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, current.projectId, subject);
    await assertEntityEnvironment(repository, current, selector);
    const service = await repositoryMutation(() => {
      const safeUpdates = sanitizeTenantServiceUpdate(updates || {});
      return repository.updateService ? repository.updateService(serviceId, safeUpdates, { actorUserId: subject.id }) : repository.store.updateService(serviceId, safeUpdates, { actorUserId: subject.id });
    });
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return service;
  }

  async getServiceSettings(serviceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, selector);
    return repository.getServiceSettings(serviceId);
  }

  async previewServiceSettings(serviceId: string, input: ServiceSettingsMutation, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, selector);
    return repositoryMutation(() => repository.previewServiceSettings(serviceId, input, { actorUserId: subject.id }));
  }

  async updateServiceSettings(serviceId: string, input: ServiceSettingsMutation, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, selector);
    return repositoryMutation(() => repository.updateServiceSettings(serviceId, input, { actorUserId: subject.id }));
  }

  async createServiceReplacement(serviceId: string, input: ServiceReplacementInput, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, selector);
    return repositoryMutation(() => repository.createServiceReplacement(serviceId, input, { actorUserId: subject.id }));
  }

  async deleteService(serviceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const current = await repository.getService(serviceId);
    if (!current) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, current.projectId, subject);
    await assertEntityEnvironment(repository, current, selector);
    const service = repository.deleteService ? await repository.deleteService(serviceId) : repository.store.deleteService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    if (isDeletionTombstone(service)) return { deletionRequested: true, status: String(service.status).toUpperCase(), serviceId: service.id || serviceId };
    return { deleted: true, serviceId: service.id || serviceId };
  }

  async listDomains(projectId: string, subject: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const repository = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    return { domains: await repositoryMutation(() => repository.listCustomDomainsForProject(projectId, options)) };
  }

  async createDomain(projectId: string, input: CustomDomainCreate, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const project = await repository.getProject(projectId);
    try {
      const environment = await repositoryMutation(() => repository.resolveEnvironment(projectId, input));
      const service = await repository.getService(input.serviceId);
      if (!service || service.projectId !== projectId || service.environmentId !== environment.id) throw new NotFoundException('DOMAIN_SCOPE_NOT_FOUND');
      return await repository.createCustomDomain({
        ...input, environmentId: environment.id, organizationId: project.organizationId, projectId, actorUserId: subject.id,
        platformZones: [process.env.RAIBITSERVER_BASE_DOMAIN || 'raibitserver.app'],
      });
    } catch (error) {
      throw nestDomainError(error);
    }
  }

  async getDomain(domainId: string, subject: Record<string, unknown>, selector: Record<string, unknown> = {}) {
    const repository = await this.repositoryPromise;
    return this.assertDomainAccess(repository, domainId, subject, selector);
  }

  async rotateDomain(domainId: string, input: CustomDomainRotate, subject: Record<string, unknown>, selector: Record<string, unknown> = {}) {
    const repository = await this.repositoryPromise;
    await this.assertDomainAccess(repository, domainId, subject, selector);
    try {
      return await repository.rotateCustomDomainChallenge(domainId, { ...input, actorUserId: subject.id });
    } catch (error) {
      throw nestDomainError(error);
    }
  }

  async verifyDomain(domainId: string, input: CustomDomainMutation, subject: Record<string, unknown>, selector: Record<string, unknown> = {}) {
    const repository = await this.repositoryPromise;
    await this.assertDomainAccess(repository, domainId, subject, selector);
    try {
      return await repository.requestCustomDomainVerification(domainId, { ...input, actorUserId: subject.id });
    } catch (error) {
      throw nestDomainError(error);
    }
  }

  async deleteDomain(domainId: string, input: CustomDomainMutation, subject: Record<string, unknown>, selector: Record<string, unknown> = {}) {
    const repository = await this.repositoryPromise;
    await this.assertDomainAccess(repository, domainId, subject, selector);
    try {
      return await repository.requestCustomDomainDeletion(domainId, { ...input, actorUserId: subject.id });
    } catch (error) {
      throw nestDomainError(error);
    }
  }

  private async assertDomainAccess(repository: InMemoryControlPlaneRepository | PrismaControlPlaneRepository, domainId: string, subject: Record<string, unknown>, selector: Record<string, unknown> = {}) {
    const domain = await repository.getCustomDomain(domainId);
    if (!domain) throw new NotFoundException('DOMAIN_NOT_FOUND');
    try {
      await assertProjectAccess(repository, domain.projectId, subject);
      const service = await assertServiceInProject(repository, domain.projectId, domain.serviceId);
      await assertEntityEnvironment(repository, service, selector);
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw new NotFoundException('DOMAIN_NOT_FOUND');
      throw error;
    }
    return domain;
  }

  async listResources(projectId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const resources = repository.listResourcesForProject ? await repositoryMutation(() => paginationRead(() => repository.listResourcesForProject(projectId, options))) : (await repository.snapshot()).resources.filter((resource: Record<string, any>) => String(resource.projectId) === String(projectId));
    return { ...keysetPage('resources', resources, 'createdAt'), resourceOptions: listCatalog().map(entry => ({ engine: entry.key, ...resourceAvailability(entry.key), permitted: can(subject.role, 'db:create') })) };
  }

  async addResource(projectId: string, resource: ResourceSpec, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const environment = parseEnvironmentSelector(resource);
    return repositoryMutation(() => repository.createResource({ ...sanitizeTenantResourceApiInput(resource), ...environment, projectId, actorUserId: subject.id }));
  }

  async getResource(resourceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    await assertEntityEnvironment(repository, resource, selector);
    return { ...resource, availability: { ...resourceAvailability(resource.engine), permitted: can(subject.role, 'db:create') } };
  }

  async createResourceBackup(resourceId: string, input: ResourceBackupCreate, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await this.getResource(resourceId, subject, selector);
    return repositoryMutation(() => this.withRecoveryScope(repository, subject, async (recovery, scope) => {
      const result = await recovery.createBackup({ ...scope, sourceId: resourceId, body: input });
      return publicRecovery(result.operation);
    }));
  }

  async listResourceBackups(resourceId: string, input: Record<string, unknown>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await this.getResource(resourceId, subject, selector);
    return repositoryMutation(() => {
      const options = parseRecoveryListOptions(input);
      return this.withRecoveryScope(repository, subject, (recovery, scope) => recovery.listBackups(scope, resourceId, options));
    });
  }

  async deleteResourceBackup(backupId: string, input: ResourceBackupDelete, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    return repositoryMutation(() => this.withRecoveryScope(repository, subject, async (recovery, scope) => {
      const backup = await recovery.getBackup(scope, backupId);
      await this.getResource(backup.resourceId, subject, selector);
      return recovery.requestBackupDeletion(scope, backupId, input);
    }));
  }

  async createBackupRestore(backupId: string, input: ResourceRestoreCreate, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    return repositoryMutation(() => this.withRecoveryScope(repository, subject, async (recovery, scope) => {
      const backup = await recovery.getBackup(scope, backupId);
      await this.getResource(backup.resourceId, subject, selector);
      const result = await recovery.createRestore({ ...scope, sourceId: backupId, body: input });
      return publicRecovery(result.operation);
    }));
  }

  async getRecoveryRestore(restoreId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    return repositoryMutation(() => this.withRecoveryScope(repository, subject, async (recovery, scope) => {
      const restore = await recovery.getRestore(scope, restoreId);
      await this.getResource(restore.targetResourceId, subject, selector);
      return publicRecovery(restore);
    }));
  }

  async updateResource(resourceId: string, updates: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const current = await this.getResource(resourceId, subject, selector);
    const resource = await repositoryMutation(() => {
      const safeUpdates = sanitizeTenantResourceApiUpdate(updates, current.engine);
      return repository.updateResource ? repository.updateResource(resourceId, safeUpdates) : repository.store.updateResource(resourceId, safeUpdates);
    });
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    return resource;
  }

  async deleteResource(resourceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const current = await this.getResource(resourceId, subject, selector);
    const resource = repository.deleteResource ? await repository.deleteResource(resourceId) : repository.store.deleteResource(resourceId);
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    if (isDeletionTombstone(resource)) return { deletionRequested: true, status: String(resource.status).toUpperCase(), resourceId: current.id || resourceId };
    return { deleted: true, resourceId: current.id || resourceId };
  }

  async attachResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const resource = await this.getResource(resourceId, subject, selector);
    const service = repository.getService ? await repository.getService(input.serviceId) : (await repository.snapshot()).services.find((candidate: Record<string, any>) => String(candidate.id) === String(input.serviceId));
    if (!service) throw new NotFoundException(`service not found: ${input.serviceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    if (String(service.projectId) !== String(resource.projectId)) throw new NotFoundException('service not found');
    if (resource.environmentId && service.environmentId && String(resource.environmentId) !== String(service.environmentId)) throw new NotFoundException('ENVIRONMENT_NOT_FOUND');
    const result = await repositoryMutation(() => repository.attachResource({ ...input, resourceId, actorUserId: subject.id }));
    return { ...result, operationId: result.id, status: 'ATTACHED' };
  }

  async provisionResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await this.getResource(resourceId, subject, selector);
    const result = await repositoryMutation(() => repository.provisionResourceProvider({ ...input, resourceId, actorUserId: subject.id }));
    return input.intent === 'live-provision'
      ? { ...result, operationId: `resource-provision:${resourceId}`, status: result.resource?.status || result.result?.status }
      : result;
  }

  async listDeployments(projectId: string, serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertServiceInProject(repository, projectId, serviceId);
    await assertProjectAccess(repository, projectId, subject);
    const service = await repository.getService(serviceId);
    await assertEntityEnvironment(repository, service, options);
    const deployments = repository.listDeploymentsForService ? await paginationRead(() => repository.listDeploymentsForService(serviceId, options)) : (await repository.snapshot()).deployments.filter((deployment: Record<string, any>) => String(deployment.serviceId) === String(serviceId));
    return keysetPage('deployments', deployments, 'createdAt');
  }

  async listDeploymentHistory(projectId: string, queryInput: Record<string, unknown>, subject: Record<string, unknown>) {
    const repository = await this.repositoryPromise;
    const project = await assertProjectAccess(repository, projectId, subject);
    const { environmentId, environmentKind, ...historyInput } = queryInput;
    const environment = await repositoryMutation(() => repository.resolveEnvironment(projectId, parseEnvironmentSelector({ environmentId, environmentKind })));
    const query = parseDeploymentHistoryQuery(historyInput);
    const execute = isGlobalSubject(subject) || can(roleForOrganization(subject, project.organizationId), 'deploy:run');
    const history = await repository.listDeploymentHistory({ organizationId: project.organizationId, projectId, environmentId: environment.id, environmentKind: environment.kind, cursorSecret: jwtSecretOrThrow(), query, execute });
    if (!history) throw new NotFoundException(`project not found: ${projectId}`);
    return history;
  }

  async createDeployment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertEntityEnvironment(repository, service, selector);
    const deploymentType = input.deploymentType || input.type || 'production';
    const branch = input.branch || service.branch || 'main';
    const security = validateServiceSecurity(service.desiredState || service.desiredSpec || service);
    if (!security.ok) throw new ForbiddenException(`deployment blocked by security policy: ${security.findings.filter((finding: any) => finding.level === 'block').map((finding: any) => finding.code).join(', ')}`);
    const { deployment, workflowJob } = await repositoryMutation(() => repository.createDeploymentWorkflow({
      actorUserId: subject.id,
      deployment: { ...sanitizeTenantDeploymentCreate(input), serviceId, projectId, environmentId: service.environmentId, status: 'queued', deploymentType, branch },
      workflow: { environmentId: service.environmentId, type: deploymentType === 'preview' ? 'preview-deploy' : 'build-and-deploy', payload: { projectId, serviceId, environmentId: service.environmentId, branch, commitSha: input.commitSha || input.commitHash || null } },
    }));
    return {
      ...deployment,
      projectId,
      desiredStateWritten: true,
      workflowJob,
      operationId: workflowJob.id,
      streamHref: `/deployments/${deployment.id}/stream`,
    };
  }

  async getDeployment(deploymentId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    const project = await assertProjectAccess(repository, deployment.projectId, subject);
    const environment = await assertEntityEnvironment(repository, deployment, selector);
    const execute = isGlobalSubject(subject) || can(roleForOrganization(subject, project.organizationId), 'deploy:run');
    const history = await repository.getDeploymentHistoryItem(deploymentId, { organizationId: project.organizationId, projectId: deployment.projectId, environmentId: environment.id, environmentKind: environment.kind, execute });
    if (!history) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    return { ...deployment, ...history };
  }

  async updateDeploymentStatus(deploymentId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = await this.getDeployment(deploymentId, subject, selector);
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

  async cancelDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await this.getDeployment(deploymentId, subject, selector);
    try {
      const result = repository.cancelDeployment
        ? await repository.cancelDeployment(deploymentId, { ...input, actorUserId: subject.id })
        : await repository.store.cancelDeployment(deploymentId, { ...input, actorUserId: subject.id });
      return { ...result, operationId: `deployment-cancel:${deploymentId}`, status: result.deployment?.status, streamHref: `/deployments/${deploymentId}/stream` };
    } catch (error) {
      if ((error as any)?.statusCode === 409) throw typedOperationException(409, error instanceof Error ? error.message : 'DEPLOYMENT_CANCELLATION_CONFLICT', false);
      throw error;
    }
  }

  async rollbackDeployment(deploymentId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    if (input?.confirmed !== true && input?.confirmed !== 'true') throw new BadRequestException('confirmation_required');
    const repository: any = await this.repositoryPromise;
    const deployment = await this.getDeployment(deploymentId, subject, selector);
    try {
      const result = repository.rollbackDeployment
        ? await repository.rollbackDeployment(deploymentId, { ...input, actorUserId: subject.id })
        : repository.store.rollbackDeployment(deploymentId, { ...input, actorUserId: subject.id });
      return { ...result, operationId: result.workflowJob?.id || `deployment-rollback:${deploymentId}`, status: result.deployment?.status, streamHref: `/deployments/${result.deployment?.id || deploymentId}/stream` };
    } catch (error) {
      if ((error as any)?.statusCode === 409) throw typedOperationException(409, error instanceof Error ? error.message : 'ROLLBACK_CONFLICT', false);
      throw error;
    }
  }

  async requestPreviewCleanup(deploymentId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    if (input?.confirmed !== true && input?.confirmed !== 'true') throw typedOperationException(400, 'CONFIRMATION_REQUIRED', false);
    const repository: any = await this.repositoryPromise;
    await this.getDeployment(deploymentId, subject, selector);
    return repositoryMutation(() => repository.requestPreviewCleanup(deploymentId, { actorUserId: subject.id }));
  }

  async createDeploymentForService(serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    return this.createDeployment(service.projectId, serviceId, input, subject, selector);
  }

  async createDeploymentOperation(target: { readonly operation: 'retry' | 'redeploy'; readonly id: string }, input: unknown, subject: { readonly id: string }, selector: Record<string, any> = {}) {
    const repository = await this.repositoryPromise;
    return repositoryMutation(async () => {
      const source = target.operation === 'retry' ? await repository.getDeployment(target.id) : null;
      const service = await repository.getService(source?.serviceId || target.id);
      if (!service || (target.operation === 'retry' && !source)) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
      try { await assertProjectAccess(repository, service.projectId, subject); }
      catch (error) { if (error instanceof ForbiddenException) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404); throw error; }
      await assertEntityEnvironment(repository, service, selector);
      const result = await repository.createDeploymentOperation({ ...parseDeploymentOperationBody(input), operation: target.operation, serviceId: service.id, ...(source ? { sourceDeploymentId: source.id } : {}), requestedByUserId: subject.id });
      return { ...result, operationId: result.workflowJob.id, status: result.deployment.status, streamHref: `/deployments/${result.deployment.id}/stream` };
    });
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
    await assertEntityEnvironment(repository, deployment, options);
    return paginationRead(async () => {
      const logs = await repository.listDeploymentLogs(deploymentId, options);
      return activityPage('logs', logs, options, await logPemContext(repository, logs));
    });
  }

  async listDeploymentEvents(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    await assertEntityEnvironment(repository, deployment, options);
    return paginationRead(async () => activityPage('events', await repository.listDeploymentEvents(deploymentId, options), options));
  }

  async deploymentActivitySnapshot(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    await assertEntityEnvironment(repository, deployment, options);
    const [logs, events] = await paginationRead(() => Promise.all([
      repository.listDeploymentLogs(deploymentId, { cursor: options.logCursor, limit: options.limit }),
      repository.listDeploymentEvents(deploymentId, { cursor: options.eventCursor, limit: options.limit }),
    ]));
    const deploymentCursor = entityVersion(deployment);
    const logContexts = await logPemContext(repository, logs);
    return projectObservationPayload({
      deployment: !options.deploymentCursor || options.deploymentCursor !== deploymentCursor ? deployment : null,
      logs,
      events,
      deploymentCursor,
      logCursor: options.logCursor || null,
      eventCursor: options.eventCursor || null,
      stream: sseStreamConfig(),
    }, observationProjectionOptions(options, logContexts));
  }

  async openDeploymentActivityStream(deploymentId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const deployment = repository.getDeployment ? await repository.getDeployment(deploymentId) : (await repository.snapshot()).deployments.find((candidate: Record<string, any>) => String(candidate.id) === String(deploymentId));
    if (!deployment) throw new NotFoundException(`deployment not found: ${deploymentId}`);
    await assertProjectAccess(repository, deployment.projectId, subject);
    await assertEntityEnvironment(repository, deployment, options);
    const resumeScope = { projectId: String(deployment.projectId), deploymentId: String(deployment.id) };
    let resume = null;
    if (options.lastEventId !== undefined) {
      try { resume = decodeDeploymentActivityResumeToken(options.lastEventId, resumeScope); }
      catch (error) {
        if (error instanceof DeploymentActivityResumeTokenError) throw typedOperationException(400, error.code, false);
        throw error;
      }
    }
    const snapshot = await this.deploymentActivitySnapshot(deploymentId, subject, {
      ...options,
      deploymentCursor: resume?.deploymentCursor || undefined,
      logCursor: resume?.logCursorToken || undefined,
      eventCursor: resume?.eventCursorToken || undefined,
      observationContinuation: options.observationContinuation,
    });
    return { snapshot, resumeScope };
  }

  async listRuntimeLogs(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, options);
    return paginationRead(async () => {
      const logs = await repository.listRuntimeLogs(serviceId, options);
      return activityPage('logs', logs, options, await logPemContext(repository, logs));
    });
  }

  async serviceLogSnapshot(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, options);
    const logs = await paginationRead<Array<Record<string, any>>>(() => repository.listRuntimeLogs(serviceId, { cursor: options.logCursor, limit: options.limit }));
    const serviceCursor = entityVersion(service);
    const logContexts = await logPemContext(repository, logs);
    return projectObservationPayload({
      service: !options.serviceCursor || options.serviceCursor !== serviceCursor ? service : null,
      logs,
      serviceCursor,
      logCursor: options.logCursor || null,
      stream: sseStreamConfig(),
    }, observationProjectionOptions(options, logContexts));
  }

  async openServiceLogStream(serviceId: string, subject: Record<string, any>, options: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const service = await repository.getService(serviceId);
    if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
    await assertProjectAccess(repository, service.projectId, subject);
    await assertEntityEnvironment(repository, service, options);
    const resumeScope = { projectId: String(service.projectId), serviceId: String(service.id) };
    const resume = options.lastEventId === undefined
      ? null
      : await paginationRead(async () => decodeServiceLogResumeToken(options.lastEventId, resumeScope));
    const logs = await paginationRead<Array<Record<string, any>>>(() => repository.listRuntimeLogs(serviceId, {
      cursor: resume?.logCursorToken || undefined,
      limit: options.limit,
    }));
    const serviceCursor = entityVersion(service);
    const logContexts = await logPemContext(repository, logs);
    const snapshot = projectObservationPayload({
      service: resume?.serviceCursor === serviceCursor ? null : service,
      logs,
      serviceCursor,
      logCursor: resume?.logCursorToken || null,
      stream: sseStreamConfig(),
    }, observationProjectionOptions(options, logContexts));
    return { snapshot, resumeScope };
  }

  async queryResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    await assertEntityEnvironment(repository, resource, selector);
    return repository.runResourceConsoleQuery(resourceId, input.query, { ...input, role: subject.role, actorUserId: subject.id });
  }

  async commandResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    await assertEntityEnvironment(repository, resource, selector);
    return repository.runResourceConsoleCommand(resourceId, input.command || input.query, { ...input, role: subject.role, actorUserId: subject.id });
  }

  async browseResource(resourceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    await assertEntityEnvironment(repository, resource, selector);
    return repository.browseResourceConsole(resourceId, input);
  }

  async resourceConsoleView(resourceId: string, view: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    const resource = repository.getResource ? await repository.getResource(resourceId) : (await repository.snapshot()).resources.find((candidate: Record<string, any>) => String(candidate.id) === String(resourceId));
    if (!resource) throw new NotFoundException(`resource not found: ${resourceId}`);
    await assertProjectAccess(repository, resource.projectId, subject);
    await assertEntityEnvironment(repository, resource, input);
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

  async listEnvironment(projectId: string, serviceId: string, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await assertServiceInProject(repository, projectId, serviceId);
    await assertEntityEnvironment(repository, service, selector);
    return repository.listServiceEnvironment({ projectId, serviceId });
  }

  async upsertEnvironment(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await assertServiceInProject(repository, projectId, serviceId);
    await assertEntityEnvironment(repository, service, selector);
    const entries = normalizeEnvEntries(input.entries || input.environment || input, { source: input.source || 'api' });
    assertNestEnvironmentWriteAllowed(subject, entries);
    return repository.upsertServiceEnvironment({ projectId, serviceId, entries, actorUserId: subject.id, source: input.source || 'api' });
  }

  async importEnvironmentFile(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await assertServiceInProject(repository, projectId, serviceId);
    await assertEntityEnvironment(repository, service, selector);
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
        integration,
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

  async disconnectGitHubIntegration(organizationId: string, integrationId: string, input: Record<string, any>, subject: Record<string, any>) {
    enforceActionScope(subject, 'github:disconnect', { organizationId });
    const repository = await this.repositoryPromise;
    return repository.disconnectGitHubIntegration({ organizationId, integrationId, expectedVersion: input.expectedVersion, actorUserId: subject.id });
  }

  async attachGitHub(projectId: string, serviceId: string, input: Record<string, any>, subject: Record<string, any>, selector: Record<string, any> = {}) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, projectId, subject);
    const service = await assertServiceInProject(repository, projectId, serviceId);
    await assertEntityEnvironment(repository, service, selector);
    return repositoryMutation(() => repository.attachGitHubRepositoryToService({
      projectId,
      serviceId,
      integrationId: input.integrationId,
      repositoryId: input.repositoryId || input.githubRepositoryId,
      repository: input.repository,
      repoUrl: input.repoUrl,
      branch: input.branch,
      expectedDefaultBranch: input.expectedDefaultBranch,
      expectedCatalogGeneration: input.expectedCatalogGeneration,
      idempotencyKey: input.idempotencyKey,
      actorUserId: subject.id,
    }));
  }

  async githubLogin(input: Record<string, unknown>, request: IncomingMessage) {
    const repository = await this.repositoryPromise;
    return oauthAttempt(repository, 'github-oauth-start', () => startGitHubOAuth(repository, input, {
        source: request.socket.remoteAddress || '', rawHeaders: request.rawHeaders, jwtSecret: process.env.RAIBITSERVER_AUTH_JWT_SECRET,
      }));
  }

  async githubCallback(input: Record<string, unknown>, request: IncomingMessage) {
    const repository = await this.repositoryPromise;
    return oauthAttempt(repository, 'github-oauth-callback', async () => {
    const jwtSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET;
    if (!jwtSecret) throw new OAuthPublicError('github_oauth_not_configured');
    const identity = await consumeGitHubOAuthIdentity(repository, input, { source: request.socket.remoteAddress || '', rawHeaders: request.rawHeaders, jwtSecret });
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
    });
  }

  async listGitHubInstallations(subject: Record<string, any>, organizationId?: string) {
    const repository: any = await this.repositoryPromise;
    const scopedOrganizationId = organizationId || subject.organizationId;
    enforceScope(subject, { organizationId: scopedOrganizationId });
    return repository.listGitHubInstallations({ organizationId: scopedOrganizationId });
  }

  async listGitHubInstallationRepositories(installationId: string, query: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.listGitHubInstallationRepositories({ installationId, actorUserId: subject.id, organizationId: subject.organizationId, organizationIds: subject.organizationIds, cursor: query.cursor, q: query.q });
  }

  async refreshGitHubInstallationRepositories(installationId: string, input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.refreshGitHubInstallationRepositories({ installationId, organizationId: subject.organizationId, expectedIntegrationVersion: input.expectedIntegrationVersion, expectedGeneration: input.expectedGeneration, actorUserId: subject.id });
  }

  async importGitHubRepository(input: Record<string, any>, subject: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    await assertProjectAccess(repository, input.projectId, subject);
    const environment = await repositoryMutation(() => repository.resolveEnvironment(input.projectId, parseEnvironmentSelector(input)));
    return repositoryMutation(() => repository.importGitHubRepository({ ...input, environmentId: environment.id, environmentKind: environment.kind, actorUserId: subject.id }));
  }

  async syncGitHubRepository(repositoryId: string, input: Record<string, any>, subject: Record<string, any>, selectorInput: Record<string, unknown> = {}) {
    const repository = await this.repositoryPromise;
    const selector = parseEnvironmentSelector(selectorInput);
    const candidates = await repository.listServicesForGitHubRepository(repositoryId, isGlobalSubject(subject) ? {} : {
      organizationId: subject.organizationId, organizationIds: subject.organizationIds,
    });
    const serviceIds: string[] = [];
    const organizationIds = new Set<string>();
    for (const candidate of candidates) {
      const service = await repository.getService(candidate.id);
      if (!service) continue;
      const environment = await repository.resolveEnvironment(service.projectId, selector).catch((error: unknown) => {
        if (error instanceof EnvironmentError && error.code === 'ENVIRONMENT_NOT_FOUND') return null;
        throw error;
      });
      if (!environment) continue;
      if (service.environmentId ? service.environmentId !== environment.id : environment.kind !== 'prod') continue;
      const project = await assertProjectAccess(repository, service.projectId, subject);
      enforceActionScope(subject, 'deploy:run', { organizationId: project.organizationId });
      organizationIds.add(String(project.organizationId));
      serviceIds.push(String(service.id));
    }
    if (serviceIds.length === 0) throw new NotFoundException('ENVIRONMENT_NOT_FOUND');
    return repositoryMutation(() => repository.syncGitHubRepository({
      ...input,
      repository: repositoryId,
      repositoryId,
      actorUserId: subject.id,
      organizationId: null,
      organizationIds: [...organizationIds],
      serviceIds,
    }));
  }

  async handleGitHubWebhook(input: Record<string, any>) {
    const repository: any = await this.repositoryPromise;
    return repository.handleGitHubWebhook(input);
  }

  async applyNextPreviewObservation(input: { readonly workerId: string }) {
    const repository: any = await this.repositoryPromise;
    return repository.applyNextPreviewObservation(input);
  }

  private async withRecoveryScope<T>(repository: any, subject: Record<string, any>, work: (recovery: any, scope: { readonly organizationId: string; readonly actorUserId: string }) => Promise<T>): Promise<T> {
    for (const organizationId of recoveryOrganizationIds(subject)) {
      const scope = { organizationId, actorUserId: String(subject.id) };
      const recovery = repository.resourceRecovery((state: any, request: any, kind: 'backup' | 'restore') => this.enforceRecoveryQuota(repository, state, request, kind));
      try {
        return await work(recovery, scope);
      } catch (error) {
        if (error instanceof RecoveryError && error.code === 'RECOVERY_NOT_FOUND') continue;
        throw error;
      }
    }
    throw new RecoveryError('RECOVERY_NOT_FOUND', 404);
  }

  private async enforceRecoveryQuota(repository: any, state: any, request: any, kind: 'backup' | 'restore') {
    await repository.enforceUserCan({ userId: request.actorUserId, action: kind === 'backup' ? 'resource.backup:create' : 'resource.restore:create' });
    if (kind !== 'restore') return;
    const backup = state.backups.find((candidate: Record<string, unknown>) => candidate.id === request.sourceId);
    await repository.enforceUserCan({
      userId: request.actorUserId,
      action: 'resource.restore:create',
      metric: 'maxDbStorageMb',
      increment: resourceStorageMb(backup?.sourceSpec ?? {}, { includeDesiredState: true }),
    });
  }
}

async function assertProjectAccess(repository: any, projectId: string, subject: Record<string, any>) {
  const project = repository.getProject
    ? await repository.getProject(projectId)
    : (await repository.snapshot()).projects.find((candidate: Record<string, any>) => String(candidate.id) === String(projectId));
  if (!project) throw new NotFoundException(`project not found: ${projectId}`);
  if (isGlobalSubject(subject)) return project;
  try {
    if (subject.projectId || Array.isArray(subject.projectIds)) enforceScope(subject, { projectId });
    enforceScope(subject, { organizationId: project.organizationId });
  } catch (error) {
    if (error instanceof ForbiddenException) throw new NotFoundException('project not found');
    throw error;
  }
  return project;
}

async function assertServiceInProject(repository: any, projectId: string, serviceId: string) {
  const service = await repository.getService(serviceId);
  if (!service) throw new NotFoundException(`service not found: ${serviceId}`);
  if (String(service.projectId) !== String(projectId)) throw new NotFoundException('service not found');
  return service;
}

async function assertEntityEnvironment(repository: any, entity: Record<string, any>, selectorInput: Record<string, any> = {}) {
  const environment = await repositoryMutation(() => repository.resolveEnvironment(entity.projectId, parseEnvironmentSelector(selectorInput)));
  if (entity.environmentId ? String(entity.environmentId) !== String(environment.id) : environment.kind !== 'prod') {
    throw new NotFoundException('ENVIRONMENT_NOT_FOUND');
  }
  return environment;
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
  if (error instanceof OrganizationCreationError) {
    return typedOperationException(error.statusCode, error.code, false, error.statusCode === 401 || error.statusCode === 403);
  }
  if (error instanceof ProjectSettingsError) return typedOperationException(409, error.code, false);
  if (error instanceof GitHubSourceConflict) return new HttpException({ statusCode: 409, message: error.code, error: error.code, code: error.code, retryable: false, terminal: true, permission: false, recovery: error.recovery }, 409);
  if (error instanceof RecoveryError) return new HttpException({ statusCode: error.statusCode, code: error.code, message: error.code }, error.statusCode);
  if (error instanceof DeploymentOperationError) return typedOperationException(error.statusCode, error.code, error.code === 'ACTIVE_DEPLOYMENT');
  if (error instanceof ResourceCapabilityUnavailable) return new BadRequestException({ ...typedOperationBody(400, error.code, false), reasonCode: error.reasonCode });
  if (error instanceof ResourceIntentInvalid) return new BadRequestException(typedOperationBody(400, error.code, false));
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

function nestDomainError(error: unknown) {
  if (error instanceof DomainLifecycleError) return typedOperationException(error.statusCode, error.code, false);
  throw error;
}

function parseRecoveryListOptions(input: Record<string, unknown>): ResourceBackupList {
  const limit = input.limit;
  const candidate = {
    ...input,
    ...(typeof limit === 'string' && /^[0-9]+$/.test(limit) ? { limit: Number(limit) } : {}),
  };
  const parsed = ResourceBackupListSchema.safeParse(candidate);
  if (!parsed.success) throw new RecoveryError('RECOVERY_INPUT_INVALID', 400);
  return parsed.data;
}

function recoveryOrganizationIds(subject: Record<string, any>): readonly string[] {
  return [...new Set([subject.organizationId, ...(Array.isArray(subject.organizationIds) ? subject.organizationIds : [])]
    .filter((organizationId): organizationId is string => typeof organizationId === 'string' && organizationId.length > 0))];
}

function typedOperationBody(statusCode: number, code: string, retryable: boolean, permission = false) {
  return { statusCode, message: code, code, retryable, terminal: !retryable, permission };
}

function typedOperationException(statusCode: number, code: string, retryable: boolean, permission = false) {
  return new HttpException(typedOperationBody(statusCode, code, retryable, permission), statusCode);
}

async function usersForRepository(repository: any) {
  if (repository?.store?.users) return [...repository.store.users.values()];
  if (repository?.listUsers) return repository.listUsers();
  const snapshot = repository.snapshot ? await repository.snapshot() : { users: [] };
  return snapshot.users || [];
}

function activityPage(key: 'logs' | 'events', rows: Array<Record<string, any>>, options: Record<string, any> = {}, logContexts: readonly any[] = []) {
  return projectObservationPayload(
    { [key]: rows, nextCursor: keysetCursorForRows(rows, 'timestamp'), logContinuationUnknown: key === 'logs' },
    key === 'logs' ? observationProjectionOptions(options, logContexts) : {},
  );
}

function observationProjectionOptions(options: Record<string, any>, logContexts: readonly any[] = []) {
  const continuation = options.observationContinuation;
  return { ...(continuation?.v === 1 ? { continuation } : {}), logContexts, unknownLogState: true };
}

async function logPemContext(repository: any, rows: Array<Record<string, any>>) {
  return repository.logPemContext ? repository.logPemContext(rows) : [];
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

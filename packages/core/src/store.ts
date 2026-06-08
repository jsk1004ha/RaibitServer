import { deepClone, nowIso, stableId, slugify } from './ids.ts';
import { maskSecretValue, maskSecrets } from './secrets.ts';
import { redactDbConsoleStatement, sanitizeLogRecord } from './security.ts';
import { claimNextWorkflowJobFromList, completeWorkflowJobRecord, createWorkflowJobRecord, failWorkflowJobRecord, processNextWorkflowJob } from './workflows.ts';
import { normalizeEnvEntries, parseDotEnv, maskEnvEntries } from './env-file.ts';
import { githubIntegrationSummary, githubWebhookActionPlan, githubWebhookOutboundPlan, parseGitHubRepository, verifyGitHubWebhookSignature } from './github-integration.ts';
import { openSecret, publicSecretRecord, sealSecret, secureRandomSecret } from './secret-vault.ts';
import { runDbConsoleQuery, browseDbConsole, resourceConsoleView } from './db-console.ts';
import { providerConnectionEnvForResource, provisionResourceProvider as provisionAnyResourceProvider } from './resource-providers.ts';
import { providerOwnedSqlitePath, sanitizeTenantResourceInput } from './resource-sanitizer.ts';
import { normalizeResourceEngine } from './catalog.ts';
import { assertDeploymentTransition, normalizeDeploymentStatus } from './deployments.ts';
import { previewRuntimePlan } from './preview-deployments.ts';
import { normalizeAccountType } from './identity.ts';
import {
  dateMs,
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

export class ControlPlaneStore {
  organizations: Map<string, any>;
  users: Map<string, any>;
  members: any[];
  projects: Map<string, any>;
  services: Map<string, any>;
  deployments: Map<string, any>;
  resources: Map<string, any>;
  domains: Map<string, any>;
  usageRecords: any[];
  auditLogs: any[];
  workflowJobs: any[];
  secrets: Map<string, any>;
  environmentVariables: Map<string, any>;
  githubIntegrations: Map<string, any>;
  webhookEvents: Map<string, any>;
  buildLogs: any[];
  runtimeLogs: any[];
  deploymentEvents: any[];
  quotas: Map<string, any>;
  resourceAttachments: any[];
  emailVerificationCodes: any[];
  emailDeliveries: any[];

  constructor() {
    this.organizations = new Map();
    this.users = new Map();
    this.members = [];
    this.projects = new Map();
    this.services = new Map();
    this.deployments = new Map();
    this.resources = new Map();
    this.domains = new Map();
    this.usageRecords = [];
    this.auditLogs = [];
    this.workflowJobs = [];
    this.secrets = new Map();
    this.environmentVariables = new Map();
    this.githubIntegrations = new Map();
    this.webhookEvents = new Map();
    this.buildLogs = [];
    this.runtimeLogs = [];
    this.deploymentEvents = [];
    this.quotas = new Map();
    this.resourceAttachments = [];
    this.emailVerificationCodes = [];
    this.emailDeliveries = [];
  }

  createOrganization({ name, slug, plan = 'free' }: Record<string, any>) {
    const org = { id: stableId('org', slug || name), name, slug: slugify(slug || name), plan, createdAt: nowIso() };
    this.organizations.set(org.id, org);
    this.audit('system', 'organization:create', 'organization', org.id, { slug: org.slug, plan });
    return deepClone(org);
  }

  findOrganizationBySlug(slug: string) {
    const normalized = slugify(slug);
    const organization = [...this.organizations.values()].find((candidate) => candidate.slug === normalized);
    return organization ? deepClone(organization) : null;
  }

  createUser({ name, email, githubId = null, passwordHash = null, role = 'USER', accountType = 'NON_CLUB', approvalStatus = 'PENDING', avatarUrl = null, emailVerifiedAt = undefined }: Record<string, any>) {
    const timestamp = nowIso();
    const user = {
      id: stableId('usr', email || name),
      name,
      email: String(email || '').toLowerCase(),
      avatarUrl,
      githubId,
      passwordHash,
      role,
      accountType: normalizeAccountType(accountType),
      approvalStatus,
      emailVerifiedAt: emailVerifiedAt === undefined ? timestamp : emailVerifiedAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.users.set(user.id, user);
    return deepClone(redactUser(user));
  }

  findUserByEmail(email: string) {
    const normalized = String(email || '').toLowerCase();
    const user = [...this.users.values()].find((candidate) => candidate.email === normalized);
    return user ? deepClone(user) : null;
  }

  createEmailVerificationCode(input: Record<string, any>) {
    const row = {
      id: stableId('evc', input.userId, input.email, Date.now(), this.emailVerificationCodes.length),
      userId: input.userId || null,
      email: String(input.email || '').toLowerCase(),
      purpose: input.purpose || 'signup',
      payload: input.payload || null,
      codeHash: input.codeHash,
      codeSalt: input.codeSalt,
      expiresAt: input.expiresAt,
      sentAt: input.sentAt || nowIso(),
      consumedAt: null,
      attempts: Number(input.attempts || 0),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.emailVerificationCodes.push(row);
    return deepClone(row);
  }

  invalidatePendingEmailVerificationCodes(email: string) {
    const normalized = String(email || '').toLowerCase();
    const consumedAt = nowIso();
    for (const row of this.emailVerificationCodes) {
      if (row.email === normalized && !row.consumedAt) {
        row.consumedAt = consumedAt;
        row.updatedAt = consumedAt;
      }
    }
    return true;
  }

  findPendingEmailVerificationCode(email: string, purpose = 'signup') {
    const normalized = String(email || '').toLowerCase();
    const normalizedPurpose = String(purpose || 'signup');
    const now = Date.now();
    const row = [...this.emailVerificationCodes]
      .filter((candidate) => {
        const expiresAt = Date.parse(candidate.expiresAt || '');
        return candidate.email === normalized
          && !candidate.consumedAt
          && String(candidate.purpose || 'signup') === normalizedPurpose
          && Number.isFinite(expiresAt)
          && expiresAt > now;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    return row ? deepClone(row) : null;
  }

  incrementEmailVerificationAttempts(id: string) {
    const row = this.emailVerificationCodes.find((candidate) => String(candidate.id) === String(id));
    if (!row) throw notFound(`email verification code not found: ${id}`);
    row.attempts = Number(row.attempts || 0) + 1;
    row.updatedAt = nowIso();
    return deepClone(row);
  }

  consumeEmailVerificationCode(id: string, consumedAt = nowIso()) {
    const row = this.emailVerificationCodes.find((candidate) => String(candidate.id) === String(id));
    if (!row) throw notFound(`email verification code not found: ${id}`);
    row.consumedAt = consumedAt;
    row.updatedAt = consumedAt;
    return deepClone(row);
  }

  markUserEmailVerified(userId: string, verifiedAt = nowIso()) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    user.emailVerifiedAt = verifiedAt;
    user.updatedAt = verifiedAt;
    this.audit(userId, 'user.email:verify', 'user', userId, {});
    return redactUser(deepClone(user));
  }

  recordEmailDelivery(input: Record<string, any>) {
    const row = {
      id: stableId('eml', input.to, input.purpose || 'email', Date.now(), this.emailDeliveries.length),
      from: input.from || null,
      to: String(input.to || '').toLowerCase(),
      subject: input.subject,
      text: input.text,
      purpose: input.purpose || 'email',
      deliveryMode: input.deliveryMode || 'console',
      messageId: input.messageId || null,
      sentAt: input.sentAt || nowIso(),
      createdAt: nowIso(),
    };
    this.emailDeliveries.push(row);
    return deepClone(row);
  }

  findUserByGitHubId(githubId: string) {
    const id = String(githubId || '').trim();
    if (!id) return null;
    const user = [...this.users.values()].find((candidate) => String(candidate.githubId || '') === id);
    return user ? deepClone(user) : null;
  }

  linkGitHubUser(userId: string, { githubId = null, avatarUrl = null, name = null, actorUserId = 'system', githubLogin = null }: Record<string, any> = {}) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    const existing = githubId ? this.findUserByGitHubId(githubId) : null;
    if (existing && String(existing.id) !== String(userId)) throw forbidden('github account is already linked to another user');
    if (githubId !== null && githubId !== undefined && String(githubId).trim()) user.githubId = String(githubId);
    if (avatarUrl !== null && avatarUrl !== undefined && String(avatarUrl).trim()) user.avatarUrl = String(avatarUrl);
    if (name !== null && name !== undefined && String(name).trim()) user.name = String(name);
    user.updatedAt = nowIso();
    this.audit(actorUserId, 'user.github:link', 'user', userId, { githubId: user.githubId || null, githubLogin: githubLogin || null });
    return redactUser(deepClone(user));
  }

  addMember({ organizationId, userId, role = 'developer' }: Record<string, any>) {
    const existing = this.members.find((member) => member.organizationId === organizationId && member.userId === userId);
    if (existing) {
      existing.role = role || existing.role;
      return deepClone(existing);
    }
    const member = { organizationId, userId, role, createdAt: nowIso() };
    this.members.push(member);
    this.audit(userId, 'organization.member:add', 'organization', organizationId, { role });
    return deepClone(member);
  }

  listMembershipsForUser(userId: string) {
    return deepClone(this.members.filter((member) => String(member.userId) === String(userId)));
  }

  createProject({ organizationId, name, slug, description = '', status = 'active' }: Record<string, any>) {
    const project = { id: stableId('prj', organizationId, slug || name), organizationId, name, slug: slugify(slug || name), description, status, createdAt: nowIso(), updatedAt: nowIso() };
    this.projects.set(project.id, project);
    this.audit('system', 'project:create', 'project', project.id, { organizationId, slug: project.slug });
    return deepClone(project);
  }

  getProject(projectId: string) {
    return deepClone(this.projects.get(projectId) || null);
  }

  updateProject(projectId: string, updates: Record<string, any> = {}) {
    const current = this.projects.get(projectId);
    if (!current) return null;
    const next = {
      ...current,
      ...maskSecrets(updates),
      slug: updates.slug ? slugify(updates.slug) : current.slug,
      updatedAt: nowIso(),
    };
    this.projects.set(projectId, next);
    this.audit('system', 'project:update', 'project', projectId, maskSecrets(updates));
    return deepClone(next);
  }

  deleteProject(projectId: string) {
    const current = this.projects.get(projectId);
    if (!current) return null;
    for (const service of [...this.services.values()].filter((service) => String(service.projectId) === String(projectId))) this.deleteService(service.id);
    for (const resource of [...this.resources.values()].filter((resource) => String(resource.projectId) === String(projectId))) this.deleteResource(resource.id);
    this.projects.delete(projectId);
    this.audit('system', 'project:delete', 'project', projectId, { organizationId: current.organizationId });
    return deepClone(current);
  }

  createService({ projectId, name, type = 'web', runtimeType = 'container', sourceType = 'github', image = null, imageUrl = null, ...rest }: Record<string, any>) {
    delete rest.id;
    delete rest.projectId;
    delete rest.desiredState;
    const resolvedImageUrl = imageUrl || image || undefined;
    const service = {
      id: stableId('svc', projectId, name),
      projectId,
      name,
      slug: slugify(name),
      type,
      runtimeType,
      sourceType,
      image: image || imageUrl || undefined,
      imageUrl: resolvedImageUrl,
      status: 'created',
      createdAt: nowIso(),
      ...rest,
    };
    this.services.set(service.id, service);
    this.audit('system', 'service:create', 'service', service.id, { projectId, type });
    return deepClone(service);
  }

  getService(serviceId: string) {
    return deepClone(this.services.get(serviceId) || null);
  }

  updateService(serviceId: string, updates: Record<string, any>) {
    const current = this.services.get(serviceId);
    if (!current) return null;
    const normalized = maskSecrets({ ...updates });
    delete normalized.id;
    delete normalized.projectId;
    delete normalized.desiredState;
    if (normalized.slug) normalized.slug = slugify(normalized.slug);
    if (normalized.image && !normalized.imageUrl) normalized.imageUrl = normalized.image;
    if (normalized.imageUrl && !normalized.image) normalized.image = normalized.imageUrl;
    const next = { ...current, ...normalized, updatedAt: nowIso() };
    this.services.set(serviceId, next);
    this.audit('system', 'service:update', 'service', serviceId, maskSecrets(updates));
    return deepClone(next);
  }

  deleteService(serviceId: string) {
    const current = this.services.get(serviceId);
    if (!current) return null;
    const deploymentIds = new Set([...this.deployments.values()]
      .filter((deployment) => String(deployment.serviceId) === String(serviceId))
      .map((deployment) => String(deployment.id)));
    for (const deploymentId of deploymentIds) this.deployments.delete(deploymentId);
    this.buildLogs = this.buildLogs.filter((row) => !deploymentIds.has(String(row.deploymentId)));
    this.deploymentEvents = this.deploymentEvents.filter((row) => !deploymentIds.has(String(row.deploymentId)));
    this.runtimeLogs = this.runtimeLogs.filter((row) => String(row.serviceId) !== String(serviceId));
    for (const [id, row] of this.environmentVariables.entries()) if (String(row.serviceId) === String(serviceId)) this.environmentVariables.delete(id);
    this.resourceAttachments = this.resourceAttachments.filter((row) => String(row.serviceId) !== String(serviceId));
    this.services.delete(serviceId);
    this.audit('system', 'service:delete', 'service', serviceId, { projectId: current.projectId });
    return deepClone(current);
  }

  createResource({ projectId, name, type = 'database', engine, provider = 'shared-provider', plan = 'shared-small', region = 'local', status = 'provisioning', ...rest }: Record<string, any>) {
    const safe = sanitizeTenantResourceInput({ projectId, name, type, engine, provider, plan, region, status, ...rest });
    const normalizedEngine = normalizeResourceEngine(safe.engine || safe.type);
    const id = stableId('res', safe.projectId, safe.name);
    const sqlitePath = normalizedEngine === 'sqlite' ? providerOwnedSqlitePath(id) : null;
    const desiredSpec = sqlitePath ? { ...(safe.desiredSpec || {}), sqlitePath } : { ...(safe.desiredSpec || {}) };
    const desiredState = { ...safe, engine: normalizedEngine, desiredSpec, sqlitePath: sqlitePath || undefined };
    const resource = {
      id,
      projectId: safe.projectId,
      type: safe.type || resourceTypeForEngine(normalizedEngine),
      name: safe.name,
      slug: slugify(safe.slug || safe.name),
      engine: normalizedEngine,
      provider: safe.provider || provider,
      status: safe.status || status,
      plan: safe.plan || plan,
      region: safe.region || region,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...safe,
      desiredSpec,
      desiredState,
      sqlitePath: sqlitePath || undefined,
    };
    this.resources.set(resource.id, resource);
    this.attachProviderConnectionSecrets({ resourceId: resource.id, env: providerConnectionEnvForResource(resource), actorUserId: 'system', live: false, providerMode: 'provider-contract' });
    this.audit('system', 'resource:create', 'resource', resource.id, { projectId: resource.projectId, engine: resource.engine, provider: resource.provider });
    return deepClone(this.resources.get(resource.id));
  }

  getResource(resourceId: string) {
    return deepClone(this.resources.get(resourceId) || null);
  }

  updateResource(resourceId: string, updates: Record<string, any> = {}) {
    const current = this.resources.get(resourceId);
    if (!current) return null;
    const safe = sanitizeTenantResourceInput({ ...updates, projectId: current.projectId, name: updates.name || current.name, engine: updates.engine || current.engine, type: updates.type || current.type });
    const engine = normalizeResourceEngine(safe.engine || current.engine);
    const sqlitePath = engine === 'sqlite' ? (current.sqlitePath || providerOwnedSqlitePath(resourceId)) : undefined;
    const desiredSpec = sqlitePath ? { ...(current.desiredSpec || {}), ...(safe.desiredSpec || {}), sqlitePath } : { ...(current.desiredSpec || {}), ...(safe.desiredSpec || {}) };
    const next = {
      ...current,
      ...safe,
      engine,
      slug: safe.slug ? slugify(safe.slug) : (safe.name ? slugify(safe.name) : current.slug),
      desiredSpec,
      desiredState: { ...(current.desiredState || {}), ...safe, desiredSpec, sqlitePath },
      sqlitePath,
      updatedAt: nowIso(),
    };
    this.resources.set(resourceId, next);
    if (updates.engine || updates.name || updates.provider || updates.desiredSpec) this.attachProviderConnectionSecrets({ resourceId, env: providerConnectionEnvForResource(next), actorUserId: 'system', live: false, providerMode: 'provider-contract' });
    this.audit('system', 'resource:update', 'resource', resourceId, maskSecrets(updates));
    return deepClone(this.resources.get(resourceId));
  }

  deleteResource(resourceId: string) {
    const current = this.resources.get(resourceId);
    if (!current) return null;
    const attachments = this.resourceAttachments.filter((row) => String(row.resourceId) === String(resourceId));
    for (const attachment of attachments) this.removeResourceInjectedEnvironment(attachment);
    this.resourceAttachments = this.resourceAttachments.filter((row) => String(row.resourceId) !== String(resourceId));
    for (const [id, secret] of [...this.secrets.entries()]) {
      if (secret.scopeType === 'resource-provider-connection' && String(secret.scopeId) === String(resourceId)) this.secrets.delete(id);
    }
    this.resources.delete(resourceId);
    this.audit('system', 'resource:delete', 'resource', resourceId, { projectId: current.projectId, engine: current.engine });
    return deepClone(current);
  }

  attachResource({ resourceId, serviceId, envPrefix = null, actorUserId = 'system' }: Record<string, any>) {
    const resource = this.resources.get(resourceId);
    const service = this.services.get(serviceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    if (!service) throw notFound(`service not found: ${serviceId}`);
    if (resource.projectId !== service.projectId) throw forbidden('resource and service must be in the same project');
    const providerEnv = providerEnvFromConnection(this.resourceForConsole(resource), resource);
    const injectedEnv = prefixEnv(providerEnv, envPrefix);
    const row = { id: stableId('attach', resourceId, serviceId), resourceId, serviceId, envPrefix, injectedEnv: maskSecrets(injectedEnv), createdAt: nowIso(), updatedAt: nowIso() };
    const existingIndex = this.resourceAttachments.findIndex((candidate) => String(candidate.resourceId) === String(resourceId) && String(candidate.serviceId) === String(serviceId));
    if (existingIndex === -1) this.resourceAttachments.push(row);
    else this.resourceAttachments[existingIndex] = { ...this.resourceAttachments[existingIndex], ...row, createdAt: this.resourceAttachments[existingIndex].createdAt || row.createdAt };
    this.upsertServiceEnvironment({
      projectId: service.projectId,
      serviceId,
      entries: Object.entries(injectedEnv).map(([key, value]) => ({ key, value: String(value), isSecret: true, source: `resource:${resourceId}` })),
      actorUserId,
      source: `resource:${resourceId}`,
    });
    this.audit(actorUserId, 'resource:attach', 'service', serviceId, { resourceId, envPrefix, envKeys: Object.keys(injectedEnv) });
    return deepClone(existingIndex === -1 ? row : this.resourceAttachments[existingIndex]);
  }

  createDeployment({ id = null, serviceId, commitHash = null, commitSha = null, imageUrl, image = null, imageDigest = null, status = 'queued', deploymentType = 'production', branch = 'main', previewUrl = null, triggerType = 'manual', pullRequestNumber = null, errorCode = null, errorMessage = null, ...rest }: Record<string, any>) {
    const service = this.services.get(serviceId);
    const sha = commitSha || commitHash || null;
    const resolvedImageUrl = imageUrl || image || null;
    const deployment = {
      id: id || stableId('dep', serviceId, sha || resolvedImageUrl || Date.now()),
      serviceId,
      projectId: rest.projectId || service?.projectId || null,
      commitHash: commitHash || sha,
      commitSha: sha,
      imageUrl: resolvedImageUrl,
      imageDigest,
      status: normalizeDeploymentStatus(status),
      deploymentType,
      branch,
      previewUrl,
      triggerType,
      pullRequestNumber: pullRequestNumber ? Number(pullRequestNumber) : null,
      errorCode,
      errorMessage: errorMessage ? sanitizeLogRecord(errorMessage) : null,
      buildStartedAt: null,
      buildFinishedAt: null,
      deployedAt: null,
      startedAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      ...maskSecrets(rest),
    };
    this.deployments.set(deployment.id, deployment);
    this.audit('system', 'deployment:create', 'deployment', deployment.id, { serviceId, status });
    this.appendDeploymentEvent({ deploymentId: deployment.id, type: 'deployment.queued', message: `Deployment queued for ${serviceId}` });
    return deepClone(deployment);
  }

  getDeployment(deploymentId: string) {
    return deepClone(this.deployments.get(deploymentId) || null);
  }



  updateDeployment(deploymentId: string, updates: Record<string, any>, options: Record<string, any> = {}) {
    const current = this.deployments.get(deploymentId);
    if (!current) return null;
    const safeUpdates = maskSecrets(updates || {});
    const nextUpdates = normalizeDeploymentUpdates(safeUpdates, current);
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'status')) {
      const nextStatus = normalizeDeploymentStatus(nextUpdates.status);
      if (options.validateTransition === true) assertDeploymentTransition(current.status, nextStatus);
      nextUpdates.status = nextStatus;
    }
    if (Object.prototype.hasOwnProperty.call(nextUpdates, 'errorMessage')) nextUpdates.errorMessage = sanitizeLogRecord(nextUpdates.errorMessage || '');
    const next = { ...current, ...nextUpdates, updatedAt: nowIso() };
    this.deployments.set(deploymentId, next);
    this.audit(options.actorUserId || 'system', 'deployment:update', 'deployment', deploymentId, { updates: nextUpdates });
    const statusChanged = Object.prototype.hasOwnProperty.call(nextUpdates, 'status') && normalizeDeploymentStatus(current.status) !== normalizeDeploymentStatus(next.status);
    if ((statusChanged || options.eventType) && options.appendEvent !== false) {
      this.appendDeploymentEvent({
        deploymentId,
        type: options.eventType || 'deployment.status.changed',
        message: options.message || `Deployment status changed: ${normalizeDeploymentStatus(current.status)} -> ${normalizeDeploymentStatus(next.status)}`,
        metadata: { from: normalizeDeploymentStatus(current.status), to: normalizeDeploymentStatus(next.status), imageUrl: next.imageUrl || null, imageDigest: next.imageDigest || null, errorCode: next.errorCode || null, ...(options.metadata || {}) },
      });
    }
    return deepClone(next);
  }

  transitionDeployment(deploymentId: string, status: string, updates: Record<string, any> = {}, options: Record<string, any> = {}) {
    const current = this.deployments.get(deploymentId);
    if (!current) throw notFound(`deployment not found: ${deploymentId}`);
    const nextStatus = normalizeDeploymentStatus(status);
    assertDeploymentTransition(current.status, nextStatus);
    const deployment = this.updateDeployment(deploymentId, { ...updates, status: nextStatus }, { ...options, validateTransition: false, appendEvent: false });
    this.appendDeploymentEvent({
      deploymentId,
      type: options.eventType || 'deployment.status.changed',
      message: options.message || `Deployment status changed: ${normalizeDeploymentStatus(current.status)} -> ${nextStatus}`,
      metadata: { from: normalizeDeploymentStatus(current.status), to: nextStatus, ...(options.metadata || {}) },
    });
    return deployment;
  }

  cancelDeployment(deploymentId: string, input: Record<string, any> = {}) {
    const deployment = this.transitionDeployment(deploymentId, 'CANCELLED', {
      finishedAt: nowIso(),
      errorCode: input.errorCode || 'DEPLOYMENT_CANCELLED',
      errorMessage: input.reason || input.errorMessage || 'Deployment cancellation requested',
    }, {
      actorUserId: input.actorUserId || 'system',
      eventType: 'deployment.cancelled',
      message: input.reason || 'Deployment cancellation requested',
    });
    const workflowJob = this.enqueueWorkflowJob({
      type: 'deployment-cancel',
      targetType: 'deployment',
      targetId: deployment.id,
      payload: { deploymentId: deployment.id, serviceId: deployment.serviceId, projectId: deployment.projectId, reason: input.reason || 'requested' },
    });
    return { deployment, workflowJob };
  }

  rollbackDeployment(deploymentId: string, input: Record<string, any> = {}) {
    const current = this.deployments.get(deploymentId);
    if (!current) throw notFound(`deployment not found: ${deploymentId}`);
    const previous = input.previousDeploymentId
      ? this.deployments.get(String(input.previousDeploymentId))
      : latestReadyDeploymentForService([...this.deployments.values()], current);
    validateRollbackSource(current, previous, input.previousDeploymentId);
    const imageUrl = previous?.imageUrl || previous?.image || null;
    if (!imageUrl) {
      throw conflict('no previous READY deployment image is available for rollback');
    }
    const imageDigest = previous?.imageDigest || null;
    const rollback = this.createDeployment({
      id: stableId('dep', current.serviceId, 'rollback', current.id, nowIso()),
      serviceId: current.serviceId,
      projectId: current.projectId,
      commitSha: previous?.commitSha || current.commitSha || null,
      imageUrl,
      imageDigest,
      status: 'IMAGE_READY',
      deploymentType: current.deploymentType || 'production',
      triggerType: 'rollback',
      branch: input.branch || current.branch || previous?.branch || 'main',
      previousDeploymentId: previous?.id || null,
      rollbackOfDeploymentId: current.id,
    });
    this.appendDeploymentEvent({ deploymentId: current.id, type: 'deployment.rollback.requested', message: `Rollback requested to ${imageUrl}`, metadata: { rollbackDeploymentId: rollback.id, previousDeploymentId: previous?.id || null, imageUrl, imageDigest } });
    this.appendDeploymentEvent({ deploymentId: rollback.id, type: 'deployment.rollback.created', message: `Rollback deployment created from ${current.id}`, metadata: { rollbackOfDeploymentId: current.id, previousDeploymentId: previous?.id || null, imageUrl, imageDigest } });
    const workflowJob = this.enqueueWorkflowJob({
      type: 'rollback-deploy',
      targetType: 'deployment',
      targetId: rollback.id,
      payload: { deploymentId: rollback.id, rollbackOfDeploymentId: current.id, previousDeploymentId: previous?.id || null, serviceId: rollback.serviceId, projectId: rollback.projectId, imageUrl, imageDigest },
    });
    return { deployment: rollback, rollbackOfDeploymentId: current.id, previousDeployment: previous ? deepClone(previous) : null, workflowJob };
  }

  appendBuildLog({ deploymentId, step = 'build', line, level = 'info' }: Record<string, any>) {
    const row = { id: stableId('blog', deploymentId, this.buildLogs.length), deploymentId, step, line: sanitizeLogRecord(String(line ?? '')), level, timestamp: nowIso() };
    this.buildLogs.push(row);
    return deepClone(row);
  }

  appendRuntimeLog({ serviceId, deploymentId = null, podName = 'local-pod', containerName = 'app', line, level = 'info' }: Record<string, any>) {
    const row = { id: stableId('rlog', serviceId, this.runtimeLogs.length), serviceId, deploymentId, podName, containerName, line: sanitizeLogRecord(String(line ?? '')), level, timestamp: nowIso() };
    this.runtimeLogs.push(row);
    return deepClone(row);
  }

  appendDeploymentEvent({ deploymentId, type, message, metadata = {} }: Record<string, any>) {
    const row = { id: stableId('devevt', deploymentId, this.deploymentEvents.length), deploymentId, type, message: sanitizeLogRecord(String(message ?? '')), metadata: maskSecrets(metadata), timestamp: nowIso() };
    this.deploymentEvents.push(row);
    return deepClone(row);
  }

  listDeploymentLogs(deploymentId: string) {
    return deepClone(this.buildLogs.filter((row) => row.deploymentId === deploymentId));
  }

  listRuntimeLogs(serviceId: string) {
    return deepClone(this.runtimeLogs.filter((row) => row.serviceId === serviceId));
  }

  listDeploymentEvents(deploymentId: string) {
    return deepClone(this.deploymentEvents.filter((row) => row.deploymentId === deploymentId));
  }

  enqueueWorkflowJob(input: Record<string, any>) {
    const row = createWorkflowJobRecord(input);
    this.workflowJobs.push(row);
    this.audit('system', 'workflow:enqueue', row.targetType, row.targetId, { workflowJobId: row.id, type: row.type, status: row.status });
    return deepClone(row);
  }

  claimNextWorkflowJob(options: Record<string, any> = {}) {
    const claimed = claimNextWorkflowJobFromList(this.workflowJobs, options);
    if (claimed) this.audit(options.workerId || options.worker || 'workflow-worker', 'workflow:claim', claimed.targetType, claimed.targetId, { workflowJobId: claimed.id, type: claimed.type, attempt: claimed.attempts });
    return claimed;
  }

  completeWorkflowJob(jobId: string, result: any = {}, options: Record<string, any> = {}) {
    const current = this.workflowJobs.find((job) => String(job.id) === String(jobId));
    if (!current) throw notFound(`workflow job not found: ${jobId}`);
    const next = options.record || completeWorkflowJobRecord(current, result, options);
    this.replaceWorkflowJob(next);
    this.audit(options.workerId || options.worker || 'workflow-worker', 'workflow:complete', next.targetType, next.targetId, { workflowJobId: next.id, type: next.type, status: next.status });
    return deepClone(next);
  }

  failWorkflowJob(jobId: string, error: any, options: Record<string, any> = {}) {
    const current = this.workflowJobs.find((job) => String(job.id) === String(jobId));
    if (!current) throw notFound(`workflow job not found: ${jobId}`);
    const next = options.record || failWorkflowJobRecord(current, error, options);
    this.replaceWorkflowJob(next);
    this.audit(options.workerId || options.worker || 'workflow-worker', 'workflow:fail', next.targetType, next.targetId, { workflowJobId: next.id, type: next.type, status: next.status, retryAt: next.runAfter });
    return deepClone(next);
  }

  async processNextWorkflowJob(handlers: Record<string, any>, options: Record<string, any> = {}) {
    return processNextWorkflowJob(this, handlers, options);
  }

  createSecret({ scopeType = 'service', scopeId, key, value, actorUserId = 'system', metadata = {} }: Record<string, any>) {
    const existing = [...this.secrets.values()].find((secret) => secret.scopeType === scopeType && secret.scopeId === scopeId && secret.key === key);
    const id = existing?.id || `sec_${secureRandomSecret(18)}`;
    const row = { id, scopeType, scopeId, key, sealedValue: sealSecret(value), valueMasked: maskSecretValue(value), metadata: maskSecrets(metadata), createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso() };
    this.secrets.set(id, row);
    this.audit(actorUserId, 'secret:upsert', scopeType, scopeId, { key, secretId: id });
    return publicSecret(row);
  }

  getSecretValue(secretId: string) {
    const secret = this.secrets.get(secretId);
    return secret?.sealedValue ? openSecret(secret.sealedValue) : null;
  }


  async provisionResourceProvider({ resourceId, actorUserId = 'provider', ...options }: Record<string, any>) {
    const resource = this.resources.get(resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    const result = await provisionAnyResourceProvider(resource, options);
    const attached = this.attachProviderConnectionSecrets({ resourceId, env: (result as any).connectionEnv || providerConnectionEnvForResource(resource), actorUserId, live: result.dryRun !== true, providerMode: result.dryRun ? 'provider-contract' : 'live-provider' });
    const next = { ...attached, status: 'ready', provider: result.provider, desiredState: { ...(attached.desiredState || {}), providerResult: result.plan }, updatedAt: nowIso() };
    this.resources.set(resourceId, next);
    this.audit(actorUserId, 'resource.provider:provision', 'resource', resourceId, { engine: result.engine, provider: result.provider, dryRun: result.dryRun, connectionSecret: result.connectionSecret });
    return { resource: deepClone(next), result: maskSecrets({ ...result, databaseUrl: undefined, connectionEnv: undefined }) };
  }

  attachProviderConnectionSecret({ resourceId, databaseUrl, connectionUrl, actorUserId = 'provider', key = 'DATABASE_URL', live = true }: Record<string, any>) {
    const value = databaseUrl || connectionUrl;
    if (!value) throw new Error('provider connection URL is required');
    return this.attachProviderConnectionSecrets({ resourceId, env: { [key]: value }, actorUserId, live, providerMode: live === false ? 'provider-contract' : 'live-provider' });
  }

  attachProviderConnectionSecrets({ resourceId, env = {}, actorUserId = 'provider', live = false, providerMode = 'provider-contract' }: Record<string, any>) {
    const resource = this.resources.get(resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    const entries = Object.entries(env || {}).filter(([, value]) => value !== undefined && value !== null && String(value).length > 0);
    if (!entries.length) throw new Error('provider connection env is required');
    let firstSecretId = resource.connectionSecretName || null;
    for (const [key, value] of entries) {
      const secret = this.createSecret({ scopeType: 'resource-provider-connection', scopeId: resourceId, key, value: String(value), actorUserId, metadata: { providerOwned: true, live: live === true, providerMode } });
      if (!firstSecretId) firstSecretId = secret.id;
    }
    const next = { ...resource, connectionSecretName: firstSecretId, updatedAt: nowIso() };
    this.resources.set(resourceId, next);
    this.audit(actorUserId, 'resource.provider-connection:attach', 'resource', resourceId, { connectionSecretName: firstSecretId, envKeys: entries.map(([key]) => key), providerMode });
    return deepClone(next);
  }

  upsertServiceEnvironment({ projectId, serviceId, entries, actorUserId = 'system', source = 'api' }: Record<string, any>) {
    const service = this.services.get(serviceId);
    if (!service) throw notFound(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw forbidden('service does not belong to project');
    const normalizedEntries = normalizeEnvEntries(entries, { source });
    const environment = { ...(service.environment || {}) };
    const publicRows = [];
    for (const entry of normalizedEntries) {
      let secretId = null;
      if (entry.isSecret) {
        const secret = this.createSecret({ scopeType: 'service', scopeId: serviceId, key: entry.key, value: entry.value, actorUserId, metadata: { source: entry.source } });
        secretId = secret.id;
      }
      environment[entry.key] = entry.isSecret ? `secret:${secretId}` : entry.value;
      const id = stableId('env', serviceId, entry.key);
      const row = { id, projectId, serviceId, key: entry.key, value: entry.isSecret ? null : entry.value, isSecret: entry.isSecret, secretId, valueMasked: entry.valueMasked, source: entry.source || source, updatedAt: nowIso() };
      this.environmentVariables.set(id, row);
      publicRows.push(row);
    }
    this.updateService(serviceId, { environment });
    this.audit(actorUserId, 'service.env:upsert', 'service', serviceId, { keys: normalizedEntries.map((entry) => entry.key), source });
    return { serviceId, entries: maskEnvEntries(publicRows), plainCount: publicRows.filter((row) => !row.isSecret).length, secretCount: publicRows.filter((row) => row.isSecret).length };
  }

  importServiceEnvFile({ projectId, serviceId, content, actorUserId = 'system', source = '.env' }: Record<string, any>) {
    const parsed = parseDotEnv(String(content || ''), { source });
    const result = this.upsertServiceEnvironment({ projectId, serviceId, entries: parsed.entries, actorUserId, source });
    return { ...result, source, parsed: { plainCount: parsed.plainCount, secretCount: parsed.secretCount, errors: parsed.errors } };
  }

  listServiceEnvironment({ projectId, serviceId }: Record<string, any>) {
    const service = this.services.get(serviceId);
    if (!service) throw notFound(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw forbidden('service does not belong to project');
    const rows = [...this.environmentVariables.values()].filter((row) => String(row.serviceId) === String(serviceId));
    return { serviceId, entries: maskEnvEntries(rows), plainCount: rows.filter((row) => !row.isSecret).length, secretCount: rows.filter((row) => row.isSecret).length };
  }

  createGitHubIntegration({ organizationId, userId = null, accountLogin, installationId = null, token = null, scopes = ['repo:read'], defaultBranch = 'main' }: Record<string, any>) {
    if (!organizationId) throw new Error('organizationId is required for GitHub integration');
    const summary = githubIntegrationSummary({ accountLogin, installationId, token, scopes });
    const id = stableId('ghi', organizationId, summary.accountLogin || installationId || summary.tokenFingerprint || Date.now());
    let tokenSecretId = null;
    if (token) {
      const secret = this.createSecret({ scopeType: 'github-integration', scopeId: id, key: 'GITHUB_TOKEN', value: token, actorUserId: userId || 'system' });
      tokenSecretId = secret.id;
    }
    const row = { id, organizationId, userId, ...summary, tokenSecretId, defaultBranch, createdAt: nowIso(), updatedAt: nowIso() };
    this.githubIntegrations.set(id, row);
    this.audit(userId || 'system', 'github:connect', 'organization', organizationId, { integrationId: id, accountLogin: summary.accountLogin, installationId });
    return deepClone(row);
  }

  listGitHubIntegrations({ organizationId }: Record<string, any>) {
    return deepClone([...this.githubIntegrations.values()].filter((row) => String(row.organizationId) === String(organizationId)));
  }

  attachGitHubRepositoryToService({ projectId, serviceId, integrationId, repoUrl, branch = 'main', actorUserId = 'system' }: Record<string, any>) {
    const service = this.services.get(serviceId);
    if (!service) throw notFound(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw forbidden('service does not belong to project');
    const project = this.projects.get(projectId);
    if (!project) throw notFound(`project not found: ${projectId}`);
    const integration = integrationId ? this.githubIntegrations.get(integrationId) : null;
    if (integration && String(integration.organizationId) !== String(project.organizationId)) throw forbidden('GitHub integration does not belong to project organization');
    const repo = parseGitHubRepository(repoUrl);
    const updated = this.updateService(serviceId, {
      sourceType: 'github',
      repoUrl: repo.repoUrl,
      branch,
      githubIntegrationId: integration?.id || integrationId || null,
      githubRepository: repo.fullName,
    });
    this.audit(actorUserId, 'github:attach-repository', 'service', serviceId, { integrationId: integration?.id || integrationId || null, repository: repo.fullName, branch });
    return { service: updated, github: { integrationId: integration?.id || integrationId || null, repository: repo.fullName, repoUrl: repo.repoUrl, branch } };
  }

  listGitHubInstallations({ organizationId }: Record<string, any>) {
    const integrations = this.listGitHubIntegrations({ organizationId });
    const installations = integrations
      .filter((integration: Record<string, any>) => integration.installationId)
      .map((integration: Record<string, any>) => {
        const repositories = this.githubRepositoriesForIntegration(integration.id);
        return { id: String(integration.installationId), installationId: String(integration.installationId), integrationId: integration.id, accountLogin: integration.accountLogin, organizationId: integration.organizationId, repositoryCount: repositories.length };
      });
    return { installations };
  }

  listGitHubInstallationRepositories({ installationId, organizationId = null, organizationIds = null }: Record<string, any>) {
    const allowedOrganizationIds = organizationScopeSet({ organizationId, organizationIds });
    const integrations = [...this.githubIntegrations.values()]
      .filter((integration) => String(integration.installationId) === String(installationId))
      .filter((integration) => allowedOrganizationIds.size === 0 || allowedOrganizationIds.has(String(integration.organizationId)));
    const repositories = uniqueRepositories(integrations.flatMap((integration) => this.githubRepositoriesForIntegration(integration.id)));
    return { installationId: String(installationId), repositories };
  }

  importGitHubRepository({ projectId, integrationId = null, repository, repoUrl, branch = 'main', serviceName = null, actorUserId = 'system' }: Record<string, any>) {
    const project = this.projects.get(projectId);
    if (!project) throw notFound(`project not found: ${projectId}`);
    const repo = parseGitHubRepository(repoUrl || repository);
    const integration = integrationId ? this.githubIntegrations.get(integrationId) : null;
    if (integration && String(integration.organizationId) !== String(project.organizationId)) throw forbidden('GitHub integration does not belong to project organization');
    const service = this.createService({
      projectId,
      name: serviceName || repo.repo,
      type: 'web',
      runtimeType: 'container',
      sourceType: 'github',
      repoUrl: repo.repoUrl,
      branch,
      githubIntegrationId: integration?.id || integrationId || null,
      githubRepository: repo.fullName,
      desiredState: { github: { repository: repo.fullName, integrationId: integration?.id || integrationId || null, imported: true } },
    });
    this.audit(actorUserId, 'github:import-repository', 'project', projectId, { repository: repo.fullName, integrationId: integration?.id || integrationId || null });
    return { service, github: { integrationId: integration?.id || integrationId || null, repository: repo.fullName, repoUrl: repo.repoUrl, branch } };
  }

  syncGitHubRepository({ repositoryId, repository, actorUserId = 'system', organizationId = null, organizationIds = null }: Record<string, any>) {
    const normalized = normalizeRepositoryId(repository || repositoryId);
    const services = this.servicesForGitHubRepository(normalized, { organizationId, organizationIds });
    const workflowJob = this.enqueueWorkflowJob({ type: 'github-repository-sync', targetType: 'github-repository', targetId: normalized, payload: { repository: normalized, serviceIds: services.map((service) => service.id) } });
    this.audit(actorUserId, 'github:repository-sync', 'github-repository', normalized, { serviceIds: services.map((service) => service.id) });
    return { repository: normalized, services: deepClone(services), workflowJob };
  }

  handleGitHubWebhook({ event, deliveryId, signature, body, payload, secret = process.env.RAIBITSERVER_GITHUB_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET || '' }: Record<string, any>) {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(payload || {});
    if (!secret) {
      const error = new Error('GitHub webhook secret is not configured');
      (error as any).statusCode = 503;
      throw error;
    }
    if (!verifyGitHubWebhookSignature(rawBody, signature, secret)) throw unauthorized('invalid GitHub webhook signature');
    const id = String(deliveryId || stableId('ghdel', event, rawBody));
    if (this.webhookEvents.has(id)) return { accepted: true, duplicate: true, deliveryId: id, actions: [] };
    const actionPlan = githubWebhookActionPlan(event, payload || {});
    const row = { id: stableId('whe', 'github', id), provider: 'github', eventType: String(event || 'unknown'), deliveryId: id, payload: maskSecrets(payload || {}), handled: true, createdAt: nowIso() };
    this.webhookEvents.set(id, row);
    const services = this.servicesForGitHubRepository(actionPlan.repository);
    const actions: any[] = [];
    for (const service of services) {
      if (actionPlan.kind === 'production-deploy') {
        const deployment = this.createDeployment({ serviceId: service.id, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'production', triggerType: 'github_push', branch: actionPlan.branch });
        const workflowJob = this.enqueueWorkflowJob({ type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook' } });
        actions.push({ type: 'production-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id });
      } else if (actionPlan.kind === 'preview-deploy') {
        const project = this.projects.get(service.projectId);
        const organization = project ? this.organizations.get(project.organizationId) : null;
        const previewPlan = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber });
        const deployment = this.createDeployment({ serviceId: service.id, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'preview', triggerType: 'github_pull_request', branch: actionPlan.branch, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: previewPlan.url });
        const preview = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id });
        const workflowJob = this.enqueueWorkflowJob({ type: 'preview-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, pullRequestNumber: actionPlan.pullRequestNumber, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook', preview, kubernetes: preview.kubernetes } });
        this.appendDeploymentEvent({ deploymentId: deployment.id, type: 'preview.workload.queued', message: `Preview Kubernetes workload queued for PR #${actionPlan.pullRequestNumber}`, metadata: { previewUrl: preview.url, workloadName: preview.kubernetes.workloadName, namespace: preview.kubernetes.namespace } });
        actions.push({ type: 'preview-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: preview.url, previewWorkloadName: preview.kubernetes.workloadName });
      } else if (actionPlan.kind === 'preview-cleanup') {
        const project = this.projects.get(service.projectId);
        const organization = project ? this.organizations.get(project.organizationId) : null;
        const preview = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber, action: 'delete' });
        const workflowJob = this.enqueueWorkflowJob({ type: 'preview-cleanup', targetType: 'service', targetId: service.id, payload: { serviceId: service.id, projectId: service.projectId, repository: actionPlan.repository, pullRequestNumber: actionPlan.pullRequestNumber, branch: actionPlan.branch, source: 'github-webhook', preview, kubernetes: preview.kubernetes } });
        const deployments = [...this.deployments.values()].filter((deployment) => deployment.serviceId === service.id && deployment.deploymentType === 'preview' && Number(deployment.pullRequestNumber) === Number(actionPlan.pullRequestNumber));
        for (const deployment of deployments) {
          const cleanupPlan = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id, action: 'delete' });
          this.deployments.set(deployment.id, { ...deployment, status: 'PREVIEW_CLEANUP_REQUESTED', updatedAt: nowIso() });
          this.appendDeploymentEvent({ deploymentId: deployment.id, type: 'preview.cleanup.requested', message: `Preview cleanup requested for PR #${actionPlan.pullRequestNumber}`, metadata: { repository: actionPlan.repository, workloadName: cleanupPlan.kubernetes.workloadName, cleanupSelector: cleanupPlan.kubernetes.cleanupSelector } });
        }
        actions.push({ type: 'preview-cleanup-enqueued', serviceId: service.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, deploymentIds: deployments.map((deployment) => deployment.id) });
      }
    }
    const outbound = githubWebhookOutboundPlan(actionPlan, actions);
    this.audit('github-webhook', 'github:webhook', 'github-delivery', id, { event, repository: actionPlan.repository, action: actionPlan.action, actions: actions.map((action) => action.type) });
    return { accepted: true, duplicate: false, deliveryId: id, event, action: actionPlan.action, repository: actionPlan.repository, matchedServiceCount: services.length, actions, outbound };
  }

  githubRepositoriesForIntegration(integrationId: string) {
    return [...this.services.values()]
      .filter((service) => String(service.githubIntegrationId || service.desiredState?.github?.integrationId || '') === String(integrationId))
      .map((service) => repositorySummaryFromService(service))
      .filter(Boolean);
  }

  servicesForGitHubRepository(repository: any, scope: Record<string, any> = {}) {
    const normalized = normalizeRepositoryId(repository);
    const allowedOrganizationIds = organizationScopeSet(scope);
    return [...this.services.values()]
      .filter((service) => normalizeRepositoryId(service.githubRepository || service.desiredState?.github?.repository || service.repoUrl || '') === normalized)
      .filter((service) => {
        if (allowedOrganizationIds.size === 0) return true;
        const project = this.projects.get(service.projectId);
        return project ? allowedOrganizationIds.has(String(project.organizationId)) : false;
      });
  }

  attachDomain({ projectId, serviceId, domain, verified = false, tlsStatus = 'pending' }: Record<string, any>) {
    const row = { id: stableId('dom', domain), projectId, serviceId, domain, verified, tlsStatus, createdAt: nowIso() };
    this.domains.set(row.id, row);
    return deepClone(row);
  }

  recordUsage(record: Record<string, any>) {
    const row = { id: stableId('use', record.organizationId, record.metric, Date.now()), ...record, recordedAt: record.recordedAt || nowIso() };
    this.usageRecords.push(row);
    return deepClone(row);
  }

  setQuota({ userId, accountType = 'NON_CLUB', ...limits }: Record<string, any>) {
    const normalizedAccountType = normalizeAccountType(accountType);
    const id = stableId('quota', userId, normalizedAccountType);
    const row = { id, userId, accountType: normalizedAccountType, maxProjects: 1, maxServices: 2, maxDeploymentsPerDay: 3, maxPreviewDeployments: 1, maxCpuMillicores: 500, maxMemoryMb: 512, maxDbStorageMb: 512, maxObjectStorageMb: 1024, maxBuildMinutesPerMonth: 60, maxRuntimeHoursPerMonth: 120, ...limits, createdAt: this.quotas.get(id)?.createdAt || nowIso(), updatedAt: nowIso() };
    this.quotas.set(id, row);
    this.audit('system', 'quota:set', 'user', userId, { accountType: normalizedAccountType, limits });
    return deepClone(row);
  }

  approveUser(userId: string, { accountType = undefined, role = null, actorUserId = 'system' }: Record<string, any> = {}) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    const nextAccountType = normalizeAccountType(accountType, user.accountType || 'NON_CLUB');
    user.approvalStatus = 'APPROVED';
    user.accountType = nextAccountType;
    if (role) user.role = role;
    user.updatedAt = nowIso();
    if (nextAccountType === 'NON_CLUB') this.setQuota({ userId, accountType: nextAccountType });
    this.audit(actorUserId, 'user:approve', 'user', userId, { accountType: nextAccountType });
    return redactUser(deepClone(user));
  }

  rejectUser(userId: string, { actorUserId = 'system' }: Record<string, any> = {}) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    user.approvalStatus = 'REJECTED';
    user.updatedAt = nowIso();
    this.audit(actorUserId, 'user:reject', 'user', userId, {});
    return redactUser(deepClone(user));
  }

  enforceUserCan({ userId, action, metric = null, increment = 1 }: Record<string, any>) {
    const user = this.users.get(userId);
    if (!user) return true;
    if (user.role === 'ADMIN' || user.accountType === 'CLUB_MEMBER') return true;
    if (user.approvalStatus !== 'APPROVED') {
      this.audit(userId, 'quota:block', action || 'action', metric || action || 'unknown', { reason: user.approvalStatus || 'PENDING' });
      throw forbidden(`user ${userId} is ${user.approvalStatus || 'PENDING'} and cannot ${action}`);
    }
    const quota = [...this.quotas.values()].find((row) => row.userId === userId) || this.setQuota({ userId, accountType: user.accountType || 'NON_CLUB' });
    if (metric && quota[metric] !== undefined) {
      const current = this.quotaUsageForUser(userId)[metric] || 0;
      const requested = current + Number(increment || 0);
      if (requested > Number(quota[metric])) {
        this.audit(userId, 'quota:block', action || 'action', metric, { current, increment: Number(increment || 0), limit: quota[metric] });
        throw forbidden(`quota exceeded: ${metric} (${requested}/${quota[metric]})`);
      }
    }
    return true;
  }

  quotaUsageForUser(userId: string) {
    const organizationIds = new Set(this.members.filter((member) => String(member.userId) === String(userId)).map((member) => String(member.organizationId)));
    const projects = [...this.projects.values()].filter((project) => organizationIds.has(String(project.organizationId)));
    const projectIds = new Set(projects.map((project) => String(project.id)));
    const services = [...this.services.values()].filter((service) => projectIds.has(String(service.projectId)));
    const serviceIds = new Set(services.map((service) => String(service.id)));
    const resources = [...this.resources.values()].filter((resource) => projectIds.has(String(resource.projectId)));
    const deployments = [...this.deployments.values()].filter((deployment) => serviceIds.has(String(deployment.serviceId)) && isSameUtcDay(deployment.createdAt || deployment.startedAt, nowIso()));
    const scopedUsage = this.usageRecords.filter((record) => String(record.userId || '') === String(userId) || organizationIds.has(String(record.organizationId)) || projectIds.has(String(record.projectId)) || serviceIds.has(String(record.serviceId)) || resources.some((resource) => String(resource.id) === String(record.resourceId)));
    const allDeployments = [...this.deployments.values()].filter((deployment) => serviceIds.has(String(deployment.serviceId)));
    return {
      maxProjects: projects.length,
      maxServices: services.length,
      maxDeploymentsPerDay: deployments.length,
      maxPreviewDeployments: deployments.filter((deployment) => deployment.deploymentType === 'preview').length,
      maxDbStorageMb: resources.filter((resource) => resourceQuotaMetric(resource) === 'maxDbStorageMb').reduce((sum, resource) => sum + resourceStorageMb(resource), 0),
      maxObjectStorageMb: resources.filter((resource) => resourceQuotaMetric(resource) === 'maxObjectStorageMb').reduce((sum, resource) => sum + resourceStorageMb(resource), 0),
      maxBuildMinutesPerMonth: usageMetricSum(scopedUsage, ['build-minutes', 'build_minutes', 'buildMinutes', 'maxBuildMinutesPerMonth']) + allDeployments.reduce((sum, deployment) => sum + deploymentBuildMinutes(deployment), 0),
      maxRuntimeHoursPerMonth: usageMetricSum(scopedUsage, ['runtime-hours', 'runtime_hours', 'runtimeHours', 'app-runtime-hours', 'maxRuntimeHoursPerMonth']) + allDeployments.reduce((sum, deployment) => sum + deploymentRuntimeHours(deployment), 0),
      maxCpuMillicores: services.reduce((sum, service) => sum + serviceCpuMillicores(service), 0),
      maxMemoryMb: services.reduce((sum, service) => sum + serviceMemoryMb(service), 0),
    };
  }

  async runResourceConsoleQuery(resourceId: string, query: string, options: Record<string, any> = {}) {
    const resource = this.resources.get(resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    const result = await runDbConsoleQuery(this.resourceForConsole(resource), query, options);
    this.audit(options.actorUserId || 'system', 'resource.console:query', 'resource', resourceId, { queryPreview: redactDbConsoleStatement(query), queryBytes: Buffer.byteLength(String(query || '')), resultRows: (result as any).rowCount || result.rows?.length || 0 });
    return result;
  }

  async runResourceConsoleCommand(resourceId: string, command: string, options: Record<string, any> = {}) {
    const resource = this.resources.get(resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    const result = await runDbConsoleQuery(this.resourceForConsole(resource), command, { ...options, providerCommand: true });
    this.audit(options.actorUserId || 'system', 'resource.console:command', 'resource', resourceId, { commandPreview: redactDbConsoleStatement(command), commandBytes: Buffer.byteLength(String(command || '')), mode: (result as any).mode, rowCount: (result as any).rowCount || result.rows?.length || 0 });
    return result;
  }

  async browseResourceConsole(resourceId: string, options: Record<string, any> = {}) {
    const resource = this.resources.get(resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    return browseDbConsole(this.resourceForConsole(resource), options);
  }

  async resourceConsoleView(resourceId: string, view: string, options: Record<string, any> = {}) {
    const resource = this.resources.get(resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);
    return resourceConsoleView(this.resourceForConsole(resource), view, options);
  }

  removeResourceInjectedEnvironment(attachment: Record<string, any>) {
    const service = this.services.get(attachment.serviceId);
    const environment = { ...(service?.environment || {}) };
    for (const key of Object.keys(attachment.injectedEnv || {})) {
      const id = stableId('env', attachment.serviceId, key);
      const row = this.environmentVariables.get(id);
      if (row?.source === `resource:${attachment.resourceId}`) {
        if (row.secretRef || row.secretId) this.secrets.delete(row.secretRef || row.secretId);
        this.environmentVariables.delete(id);
        delete environment[key];
      }
    }
    if (service) this.services.set(service.id, { ...service, environment, updatedAt: nowIso() });
  }

  resourceForConsole(resource: Record<string, any>) {
    const env: Record<string, string> = {};
    let live = false;
    for (const secret of this.secrets.values()) {
      if (!isProviderConnectionSecret(secret, resource.id)) continue;
      if (secret.sealedValue) env[secret.key] = openSecret(secret.sealedValue);
      if (secret.metadata?.live === true) live = true;
    }
    if (!Object.keys(env).length) return resource;
    return { ...resource, providerConnection: providerConnectionFromEnv(env, resource.engine, live) };
  }

  audit(actorUserId: any, action: string, targetType: string, targetId: any, metadata: Record<string, any> = {}) {
    const row = { id: stableId('aud', action, targetId, Date.now(), this.auditLogs.length), actorUserId, action, targetType, targetId, metadata: maskSecrets(metadata), createdAt: nowIso() };
    this.auditLogs.push(row);
    return deepClone(row);
  }

  snapshot() {
    return deepClone({
      organizations: [...this.organizations.values()],
      users: [...this.users.values()].map(redactUser),
      members: this.members,
      projects: [...this.projects.values()],
      services: [...this.services.values()],
      deployments: [...this.deployments.values()],
      resources: [...this.resources.values()],
      domains: [...this.domains.values()],
      usageRecords: this.usageRecords,
      auditLogs: this.auditLogs,
      workflowJobs: this.workflowJobs,
      secrets: [...this.secrets.values()].map(publicSecret),
      environmentVariables: maskEnvEntries([...this.environmentVariables.values()]),
      githubIntegrations: [...this.githubIntegrations.values()],
      webhookEvents: [...this.webhookEvents.values()],
      buildLogs: this.buildLogs,
      runtimeLogs: this.runtimeLogs,
      deploymentEvents: this.deploymentEvents,
      quotas: [...this.quotas.values()],
      resourceAttachments: this.resourceAttachments,
    });
  }

  private replaceWorkflowJob(next: Record<string, any>) {
    const index = this.workflowJobs.findIndex((job) => String(job.id) === String(next.id));
    if (index === -1) throw notFound(`workflow job not found: ${next.id}`);
    this.workflowJobs[index] = next;
    return next;
  }
}

function validateRollbackSource(current: Record<string, any>, previous: Record<string, any> | undefined, explicitPreviousDeploymentId: any) {
  if (!previous) {
    if (explicitPreviousDeploymentId) throw notFound(`rollback source deployment not found: ${explicitPreviousDeploymentId}`);
    throw conflict('no previous READY deployment image is available for rollback');
  }
  if (String(previous.projectId || '') !== String(current.projectId || '') || String(previous.serviceId || '') !== String(current.serviceId || '')) {
    throw forbidden('rollback source deployment must belong to the same service and project');
  }
  if (String(previous.status || '').toUpperCase() !== 'READY' || !(previous.imageUrl || previous.image)) {
    throw conflict('rollback source deployment must be READY and have an image');
  }
}


function publicSecret(row: Record<string, any>) {
  return publicSecretRecord(row);
}

function redactUser(user: Record<string, any>) {
  const { passwordHash, ...rest } = user;
  return rest;
}

function normalizeDeploymentUpdates(updates: Record<string, any>, current: Record<string, any>) {
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(updates || {})) {
    normalized[key] = value === '' ? null : value;
  }
  if (normalized.image && !normalized.imageUrl) normalized.imageUrl = normalized.image;
  if (Object.prototype.hasOwnProperty.call(normalized, 'status')) {
    const status = normalizeDeploymentStatus(normalized.status);
    normalized.status = status;
    const timestamp = nowIso();
    if (status === 'BUILDING' && !current.buildStartedAt && !normalized.buildStartedAt) normalized.buildStartedAt = timestamp;
    if (status === 'IMAGE_READY' && !normalized.buildFinishedAt) normalized.buildFinishedAt = timestamp;
    if (status === 'DEPLOYING' && !current.deployedAt && !normalized.deployedAt) normalized.deployedAt = timestamp;
    if (status === 'READY') {
      if (!normalized.deployedAt) normalized.deployedAt = current.deployedAt || timestamp;
      if (!normalized.finishedAt) normalized.finishedAt = timestamp;
      if (!Object.prototype.hasOwnProperty.call(updates, 'errorCode')) normalized.errorCode = null;
      if (!Object.prototype.hasOwnProperty.call(updates, 'errorMessage')) normalized.errorMessage = null;
    }
    if ((status === 'FAILED' || status === 'BUILD_FAILED' || status === 'CANCELLED') && !normalized.finishedAt) normalized.finishedAt = timestamp;
  }
  return normalized;
}

function latestReadyDeploymentForService(deployments: Array<Record<string, any>>, current: Record<string, any>) {
  return deployments
    .filter((deployment) => String(deployment.id) !== String(current.id)
      && String(deployment.serviceId) === String(current.serviceId)
      && normalizeDeploymentStatus(deployment.status) === 'READY'
      && (deployment.imageUrl || deployment.image))
    .sort((left, right) => dateMs(right.deployedAt || right.finishedAt || right.createdAt) - dateMs(left.deployedAt || left.finishedAt || left.createdAt))[0] || null;
}

function isSameUtcDay(left: any, right: any) {
  const a = new Date(left);
  const b = new Date(right);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function notFound(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 404;
  return error;
}

function forbidden(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 403;
  return error;
}

function conflict(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 409;
  return error;
}

function unauthorized(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 401;
  return error;
}

function normalizeRepositoryId(value: any) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return parseGitHubRepository(text).fullName.toLowerCase();
  } catch {
    return text.toLowerCase().replace(/^github:/, '');
  }
}

function organizationScopeSet(scope: Record<string, any> = {}) {
  const ids = [
    scope.organizationId,
    ...(Array.isArray(scope.organizationIds) ? scope.organizationIds : []),
  ].filter((value) => value !== null && value !== undefined && String(value).trim());
  return new Set(ids.map((value) => String(value)));
}

function repositorySummaryFromService(service: Record<string, any>) {
  const repository = normalizeRepositoryId(service.githubRepository || service.desiredState?.github?.repository || service.repoUrl || '');
  if (!repository) return null;
  const parsed = parseGitHubRepository(repository);
  return { id: stableId('ghr', parsed.fullName), fullName: parsed.fullName, repoUrl: parsed.repoUrl, defaultBranch: service.branch || 'main', serviceIds: [service.id] };
}

function uniqueRepositories(repositories: Array<Record<string, any> | null>) {
  const byName = new Map();
  for (const repository of repositories) {
    if (!repository) continue;
    const key = normalizeRepositoryId(repository.fullName || repository.repoUrl);
    const existing = byName.get(key);
    byName.set(key, existing ? { ...existing, serviceIds: [...new Set([...(existing.serviceIds || []), ...(repository.serviceIds || [])])] } : repository);
  }
  return [...byName.values()];
}

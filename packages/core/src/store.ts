import { deepClone, nowIso, stableId, slugify } from './ids.ts';
import { maskSecretValue, maskSecrets } from './secrets.ts';
import { assertNoTenantGitHubBinding, redactDbConsoleStatement, sanitizeLogRecord } from './security.ts';
import { claimNextWorkflowJobFromList, completeWorkflowJobRecord, createWorkflowJobRecord, failWorkflowJobRecord, processNextWorkflowJob } from './workflows.ts';
import { normalizeEnvEntries, parseDotEnv, maskEnvEntries } from './env-file.ts';
import { githubIntegrationSummary, githubWebhookActionPlan, githubWebhookOutboundPlan, parseGitHubRepository, verifyGitHubWebhookSignature } from './github-integration.ts';
import { openSecret, publicSecretRecord, sealSecret, secureRandomSecret } from './secret-vault.ts';
import { runDbConsoleQuery, browseDbConsole, resourceConsoleView } from './db-console.ts';
import { buildResourceProviderPlan, publicResourceProviderPlan } from './resource-providers.ts';
import { canonicalizeProviderDesiredSpec, providerOwnedSqlitePath, sanitizeTenantResourceInput } from './resource-sanitizer.ts';
import { normalizeResourceEngine } from './catalog.ts';
import { assertDeploymentTransition, canCancelDeployment, normalizeDeploymentStatus } from './deployments.ts';
import { previewRuntimePlan } from './preview-deployments.ts';
import { normalizeAccountType } from './identity.ts';
import {
  boundedActivityRows,
  dateMs,
  deploymentBuildMinutesWithin,
  deploymentRuntimeHoursWithin,
  isProviderConnectionSecret,
    kubernetesExternalSecretRef,
    providerConnectionFromEnv,
    providerSecretEnvRefs,
  resourceQuotaMetric,
  resourceStorageMb,
  resourceTypeForEngine,
  serviceCpuMillicores,
  serviceMemoryMb,
  usageMetricSum,
  utcMonthBounds,
} from './store-helpers.ts';

export const AUTH_RETENTION_PRUNE_BATCH_SIZE = 256;

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
  githubRepositories: Map<string, any>;
  webhookEvents: Map<string, any>;
  buildLogs: any[];
  runtimeLogs: any[];
  deploymentEvents: any[];
  quotas: Map<string, any>;
  resourceAttachments: any[];
  emailVerificationCodes: any[];
  emailDeliveries: any[];
  authRateLimits: Map<string, any>;

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
    this.githubRepositories = new Map();
    this.webhookEvents = new Map();
    this.buildLogs = [];
    this.runtimeLogs = [];
    this.deploymentEvents = [];
    this.quotas = new Map();
    this.resourceAttachments = [];
    this.emailVerificationCodes = [];
    this.emailDeliveries = [];
    this.authRateLimits = new Map();
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

  createUser({ name, studentId = '', clubMemberClaim = false, email, githubId = null, passwordHash = null, role = 'USER', accountType = 'NON_CLUB', approvalStatus = 'PENDING', avatarUrl = null, emailVerifiedAt = undefined, bannedAt = null, banExpiresAt = null, banReason = null, bannedByUserId = null }: Record<string, any>) {
    const timestamp = nowIso();
    const id = stableId('usr', email || name);
    const existing = this.users.get(id);
    const passwordChanged = Boolean(existing && passwordHash && passwordHash !== existing.passwordHash);
    const user = {
      id,
      name,
      studentId,
      clubMemberClaim: Boolean(clubMemberClaim),
      email: String(email || '').toLowerCase(),
      avatarUrl,
      githubId,
      passwordHash,
      role,
      accountType: normalizeAccountType(accountType),
      approvalStatus,
      sessionVersion: Number(existing?.sessionVersion || 0) + (passwordChanged ? 1 : 0),
      bannedAt: existing?.bannedAt ?? bannedAt,
      banExpiresAt: existing?.banExpiresAt ?? banExpiresAt,
      banReason: existing?.banReason ?? banReason,
      bannedByUserId: existing?.bannedByUserId ?? bannedByUserId,
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

  countUsers(limit = 1) {
    const requestedLimit = Math.floor(Number(limit));
    const boundedLimit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 1;
    return Math.min(this.users.size, boundedLimit);
  }

  findUserById(userId: string) {
    const user = this.users.get(userId);
    return user ? deepClone(user) : null;
  }

  incrementSessionVersion(userId: string) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = nowIso();
    return deepClone(redactUser(user));
  }

  consumeAuthRateLimit({ key, limit = 10, windowMs = 60_000, now = Date.now() }: Record<string, any>) {
    const normalizedKey = String(key || 'global');
    const timestamp = Number(now);
    let pruned = 0;
    for (const [candidateKey, candidate] of this.authRateLimits) {
      if (pruned >= AUTH_RETENTION_PRUNE_BATCH_SIZE) break;
      if (Number(candidate?.expiresAt) > timestamp) continue;
      this.authRateLimits.delete(candidateKey);
      pruned += 1;
    }
    const current = this.authRateLimits.get(normalizedKey);
    const resetWindow = !current || current.expiresAt <= timestamp;
    const allowed = resetWindow || Number(current.count || 0) < Number(limit);
    const row = resetWindow
      ? { key: normalizedKey, count: 1, windowStartedAt: timestamp, expiresAt: timestamp + Number(windowMs) }
      : allowed
        ? { ...current, count: current.count + 1 }
        : current;
    this.authRateLimits.set(normalizedKey, row);
    return { allowed, count: row.count, remaining: Math.max(0, Number(limit) - row.count), resetAt: row.expiresAt };
  }

  peekAuthRateLimit({ key, limit = 10, now = Date.now() }: Record<string, any>) {
    const normalizedKey = String(key || 'global');
    const timestamp = Number(now);
    const row = this.authRateLimits.get(normalizedKey);
    if (!row || Number(row.expiresAt) <= timestamp) {
      return { allowed: true, count: 0, remaining: Number(limit), resetAt: timestamp };
    }
    const count = Number(row.count || 0);
    return {
      allowed: count < Number(limit),
      count,
      remaining: Math.max(0, Number(limit) - count),
      resetAt: Number(row.expiresAt),
    };
  }

  resetAuthRateLimit(key: string) {
    this.authRateLimits.delete(String(key || 'global'));
    return true;
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

  replaceEmailVerificationCode(input: Record<string, any>) {
    const now = Date.now();
    let pruned = 0;
    this.emailVerificationCodes = this.emailVerificationCodes.filter((row) => {
      if (pruned >= AUTH_RETENTION_PRUNE_BATCH_SIZE || Date.parse(row.expiresAt || '') > now) return true;
      pruned += 1;
      return false;
    });
    const replacement = this.createEmailVerificationCode(input);
    const consumedAt = nowIso();
    for (const row of this.emailVerificationCodes) {
      if (row.id !== replacement.id
        && row.email === replacement.email
        && row.purpose === replacement.purpose
        && !row.consumedAt) {
        row.consumedAt = consumedAt;
        row.updatedAt = consumedAt;
      }
    }
    return replacement;
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
      const nextRole = role || existing.role;
      if (existing.role !== nextRole) {
        existing.role = nextRole;
        existing.updatedAt = nowIso();
        if (this.users.has(userId)) this.incrementSessionVersion(userId);
        this.audit(userId, 'organization.member:role-change', 'organization', organizationId, { role: nextRole });
      }
      return deepClone(existing);
    }
    const member = { organizationId, userId, role, createdAt: nowIso() };
    this.members.push(member);
    this.audit(userId, 'organization.member:add', 'organization', organizationId, { role });
    return deepClone(member);
  }

  removeMember({ organizationId, userId }: Record<string, any>) {
    const index = this.members.findIndex((member) => member.organizationId === organizationId && member.userId === userId);
    if (index < 0) return null;
    const [member] = this.members.splice(index, 1);
    if (this.users.has(userId)) this.incrementSessionVersion(userId);
    this.audit(userId, 'organization.member:remove', 'organization', organizationId, { role: member.role });
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
    if (updates.slug !== undefined && slugify(updates.slug) !== current.slug) throw conflict('project slug is immutable after creation');
    const mutableUpdates: Record<string, any> = {};
    if (updates.name !== undefined) mutableUpdates.name = updates.name;
    if (updates.description !== undefined) mutableUpdates.description = updates.description;
    const next = {
      ...current,
      ...maskSecrets(mutableUpdates),
      updatedAt: nowIso(),
    };
    this.projects.set(projectId, next);
    this.audit('system', 'project:update', 'project', projectId, maskSecrets(mutableUpdates));
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

  createService({ projectId, name, type = 'web', runtimeType = 'container', sourceType = 'github', image = null, imageUrl = null, ...rest }: Record<string, any>, options: Record<string, any> = {}) {
    if (options.allowGitHubBinding !== true) assertNoTenantGitHubBinding(rest);
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

  updateService(serviceId: string, updates: Record<string, any>, options: Record<string, any> = {}) {
    const current = this.services.get(serviceId);
    if (!current) return null;
    if (options.allowGitHubBinding !== true) assertNoTenantGitHubBinding(updates);
    assertImmutableGitHubRepositoryBinding(current, updates);
    const normalized = maskSecrets({ ...updates });
    delete normalized.id;
    delete normalized.projectId;
    if (options.allowDesiredState !== true) delete normalized.desiredState;
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
      const existing = this.resources.get(id);
      if (String(existing?.status || '').toUpperCase() === 'READY') return deepClone(existing);
    const sqlitePath = normalizedEngine === 'sqlite' ? providerOwnedSqlitePath(id) : null;
  const canonicalSpec = canonicalizeProviderDesiredSpec(safe, { rejectUnknown: false });
  const desiredSpec = sqlitePath ? { ...canonicalSpec, sqlitePath } : canonicalSpec;
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
    this.audit('system', 'resource:create', 'resource', resource.id, { projectId: resource.projectId, engine: resource.engine, provider: resource.provider });
    return deepClone(this.resources.get(resource.id));
  }

  getResource(resourceId: string) {
    return deepClone(this.resources.get(resourceId) || null);
  }

  updateResource(resourceId: string, updates: Record<string, any> = {}) {
    const current = this.resources.get(resourceId);
    if (!current) return null;
      if (String(current.status || '').toUpperCase() === 'READY') throw conflict('READY managed resources cannot be updated in place; delete and recreate the resource');
  if (String(current.status || '').toUpperCase() === 'RECONCILING' && Object.keys(updates).length > 0) throw conflict('RECONCILING managed resources cannot be updated while the provisioner claim is active');
    const safe = sanitizeTenantResourceInput({ ...updates, projectId: current.projectId, name: updates.name || current.name, engine: updates.engine || current.engine, type: updates.type || current.type });
    const engine = normalizeResourceEngine(safe.engine || current.engine);
    const sqlitePath = engine === 'sqlite' ? (current.sqlitePath || providerOwnedSqlitePath(resourceId)) : undefined;
  const canonicalSpec = canonicalizeProviderDesiredSpec(safe, { baseSpec: current.desiredSpec || {}, rejectUnknown: false });
  const desiredSpec = sqlitePath ? { ...canonicalSpec, sqlitePath } : canonicalSpec;
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
      const injectedEnv = providerSecretEnvRefs(resource, envPrefix);
      const row = { id: stableId('attach', resourceId, serviceId), resourceId, serviceId, envPrefix, injectedEnv, createdAt: nowIso(), updatedAt: nowIso() };
    const existingIndex = this.resourceAttachments.findIndex((candidate) => String(candidate.resourceId) === String(resourceId) && String(candidate.serviceId) === String(serviceId));
      const previousKeys = existingIndex === -1 ? [] : Object.keys(this.resourceAttachments[existingIndex].injectedEnv || {});
    if (existingIndex === -1) this.resourceAttachments.push(row);
    else this.resourceAttachments[existingIndex] = { ...this.resourceAttachments[existingIndex], ...row, createdAt: this.resourceAttachments[existingIndex].createdAt || row.createdAt };
      const secretEnv = mergeSecretEnv(service.desiredSpec?.secretEnv, injectedEnv, previousKeys);
      this.services.set(serviceId, { ...service, desiredSpec: { ...(service.desiredSpec || {}), secretEnv }, updatedAt: nowIso() });
      for (const [key, reference] of Object.entries(injectedEnv)) {
        const id = stableId('env', serviceId, key);
        this.environmentVariables.set(id, {
          id, projectId: service.projectId, serviceId, key, value: null, isSecret: true,
          secretRef: kubernetesExternalSecretRef(reference), valueMasked: '****', source: `resource:${resourceId}`, updatedAt: nowIso(),
        });
      }
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
    const current = this.deployments.get(deploymentId);
    if (!current) throw notFound(`deployment not found: ${deploymentId}`);
    const currentStatus = normalizeDeploymentStatus(current.status);
    if (currentStatus === 'CANCELLED') {
      return { deployment: deepClone(current) };
    }
    if (!canCancelDeployment(currentStatus)) {
      throw conflict('deployment_cancellation_conflict: deployment cannot be cancelled after runtime reconciliation has started or reached a terminal state');
    }
    cancelActiveBuildWorkflowJobs(this.workflowJobs, deploymentId, input.reason || 'Deployment cancelled');
    const deployment = this.transitionDeployment(deploymentId, 'CANCELLED', {
      errorCode: input.errorCode || 'DEPLOYMENT_CANCELLED',
      errorMessage: input.reason || input.errorMessage || 'Deployment cancelled',
      reconcileAction: null,
      reconcileLockedBy: null,
      reconcileLockedAt: null,
    }, {
      actorUserId: input.actorUserId || 'system',
      eventType: 'deployment.cancelled',
      message: input.reason || 'Deployment cancelled',
    });
    return { deployment };
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

  listDeploymentLogs(deploymentId: string, options: Record<string, any> = {}) {
    return deepClone(boundedActivityRows(this.buildLogs.filter((row) => row.deploymentId === deploymentId), options));
  }

  listRuntimeLogs(serviceId: string, options: Record<string, any> = {}) {
    return deepClone(boundedActivityRows(this.runtimeLogs.filter((row) => row.serviceId === serviceId), options));
  }

  listDeploymentEvents(deploymentId: string, options: Record<string, any> = {}) {
    return deepClone(boundedActivityRows(this.deploymentEvents.filter((row) => row.deploymentId === deploymentId), options));
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
      if (options.execute === true || options.dryRun === false) throw conflict('live provider execution is handled exclusively by the authoritative Go provisioner');
      if (String(resource.status || '').toUpperCase() === 'READY') throw conflict('READY managed resources cannot be reprovisioned or rotate credentials through the planning endpoint');
      const plan = buildResourceProviderPlan(resource, providerPlanPlaceholders());
      const publicPlan = publicResourceProviderPlan(plan);
      const result = { engine: plan.engine, provider: plan.provider, status: 'provisioning', dryRun: true, connectionSecret: plan.connectionSecret, plan: publicPlan };
      const planned = { ...resource, status: 'provisioning', connectionSecretName: resource.connectionSecretName, desiredState: { ...(resource.desiredState || {}), providerPlan: publicPlan }, updatedAt: nowIso() };
      this.resources.set(resourceId, planned);
      this.audit(actorUserId, 'resource.provider:plan', 'resource', resourceId, { engine: result.engine, provider: result.provider, dryRun: true, executor: 'go-provisioner' });
      return { resource: deepClone(planned), result: maskSecrets(result) };
  }

  attachProviderConnectionSecret({ resourceId, databaseUrl, connectionUrl, actorUserId = 'provider', key = 'DATABASE_URL', live = true }: Record<string, any>) {
      void resourceId; void databaseUrl; void connectionUrl; void actorUserId; void key; void live;
      throw forbidden('provider credentials are written only by the Go provisioner to a Kubernetes Secret');
  }

  attachProviderConnectionSecrets({ resourceId, env = {}, actorUserId = 'provider', live = false, providerMode = 'provider-contract' }: Record<string, any>) {
      void resourceId; void env; void actorUserId; void live; void providerMode;
      throw forbidden('provider credentials are written only by the Go provisioner to a Kubernetes Secret');
  }

  upsertServiceEnvironment({ projectId, serviceId, entries, actorUserId = 'system', source = 'api' }: Record<string, any>) {
    const service = this.services.get(serviceId);
    if (!service) throw notFound(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw forbidden('service does not belong to project');
    const normalizedEntries = normalizeEnvEntries(entries, { source });
    const environment = { ...(service.environment || {}) };
    const desiredSpec = { ...(service.desiredSpec || {}) };
    const runtimeEnv = desiredSpec.env && typeof desiredSpec.env === 'object' && !Array.isArray(desiredSpec.env)
      ? { ...desiredSpec.env }
      : {};
    const publicRows = [];
    for (const entry of normalizedEntries) {
      let secretId = null;
      if (entry.isSecret) {
        const secret = this.createSecret({ scopeType: 'service', scopeId: serviceId, key: entry.key, value: entry.value, actorUserId, metadata: { source: entry.source } });
        secretId = secret.id;
      }
      environment[entry.key] = entry.isSecret ? `secret:${secretId}` : entry.value;
      if (entry.isSecret) delete runtimeEnv[entry.key];
      else runtimeEnv[entry.key] = entry.value;
      const id = stableId('env', serviceId, entry.key);
      const row = { id, projectId, serviceId, key: entry.key, value: entry.isSecret ? null : entry.value, isSecret: entry.isSecret, secretId, valueMasked: entry.valueMasked, source: entry.source || source, updatedAt: nowIso() };
      this.environmentVariables.set(id, row);
      publicRows.push(row);
    }
    if (Object.keys(runtimeEnv).length) desiredSpec.env = runtimeEnv;
    else delete desiredSpec.env;
    this.services.set(serviceId, { ...service, environment, desiredSpec, updatedAt: nowIso() });
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
    const row = { id, organizationId, userId, ...summary, tokenSecretId, defaultBranch, verifiedAt: null, createdAt: nowIso(), updatedAt: nowIso() };
    this.githubIntegrations.set(id, row);
    this.audit(userId || 'system', 'github:connect', 'organization', organizationId, { integrationId: id, accountLogin: summary.accountLogin, installationId });
    return deepClone(row);
  }

  listGitHubIntegrations({ organizationId }: Record<string, any>) {
    return deepClone([...this.githubIntegrations.values()].filter((row) => String(row.organizationId) === String(organizationId)));
  }

  verifyGitHubIntegration({ integrationId, installationId, accountLogin = null, verifiedBy = 'github-app' }: Record<string, any>) {
    const integration = this.githubIntegrations.get(integrationId);
    if (!integration) throw notFound(`GitHub integration not found: ${integrationId}`);
    const authoritativeInstallationId = String(installationId || '').trim();
    if (!authoritativeInstallationId) throw conflict('verified GitHub integration requires an installationId');
    if (integration.verifiedAt && String(integration.installationId) !== authoritativeInstallationId) throw conflict('verified GitHub installation binding is immutable');
    const conflictRow = [...this.githubIntegrations.values()].find((candidate) => candidate.id !== integration.id && candidate.verifiedAt && String(candidate.installationId) === authoritativeInstallationId);
    if (conflictRow) throw conflict(String(conflictRow.organizationId) === String(integration.organizationId) ? 'GitHub installation is already verified by another integration' : 'GitHub installation is already verified for another organization');
    const next = { ...integration, installationId: authoritativeInstallationId, accountLogin: accountLogin || integration.accountLogin, verifiedAt: nowIso(), updatedAt: nowIso() };
    this.githubIntegrations.set(integrationId, next);
    this.audit(verifiedBy, 'github:verify-installation', 'github-integration', integrationId, { organizationId: integration.organizationId, installationId: authoritativeInstallationId });
    return deepClone(next);
  }

  registerGitHubRepository({ installationId, githubRepoId, repositoryId = null, fullName = null, owner = null, name = null, defaultBranch = 'main', private: privateRepository = false }: Record<string, any>) {
    const normalizedInstallationId = String(installationId || '').trim();
    if (![...this.githubIntegrations.values()].some((integration) => integration.verifiedAt && String(integration.installationId) === normalizedInstallationId)) {
      throw forbidden('repository catalog updates require a verified GitHub installation');
    }
    const repository = canonicalGitHubRepositoryRecord({ installationId: normalizedInstallationId, githubRepoId: githubRepoId || repositoryId, fullName, owner, name, defaultBranch, private: privateRepository });
    const existing = [...this.githubRepositories.values()].find((candidate) => String(candidate.githubRepoId) === repository.githubRepoId);
    if (existing && String(existing.installationId) !== normalizedInstallationId) throw conflict('GitHub repository is already bound to another installation');
    const row = { id: existing?.id || stableId('ghr', repository.githubRepoId), ...repository, createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso() };
    this.githubRepositories.set(row.id, row);
    return deepClone(row);
  }

  completeSignupEmailVerification(input: Record<string, any>) {
    const email = String(input.email || '').trim().toLowerCase();
    const purpose = String(input.purpose || 'signup');
    const now = Number(input.now === undefined ? Date.now() : input.now);
    const maxAttempts = Math.max(1, Number(input.maxAttempts || 5));
    const row = [...this.emailVerificationCodes]
      .filter((candidate) => candidate.email === email && String(candidate.purpose || 'signup') === purpose && !candidate.consumedAt)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0];
    if (!row || Date.parse(row.expiresAt || '') <= now || Number(row.attempts || 0) >= maxAttempts) {
      return { status: 'invalid' };
    }
    if (typeof input.verifyCode !== 'function' || input.verifyCode(deepClone(row)) !== true) {
      row.attempts = Math.min(maxAttempts, Number(row.attempts || 0) + 1);
      row.updatedAt = new Date(now).toISOString();
      return { status: 'invalid' };
    }
    const payload = row.payload || {};
    if (payload.kind !== 'signup') return { status: 'invalid' };
    if (this.findUserByEmail(email)) throw conflict('user_already_exists');
    if (this.findOrganizationBySlug(payload.organizationSlug)) throw conflict('organization_slug_already_exists');
    const firstUser = this.users.size === 0;
    const policy = typeof input.resolvePolicy === 'function'
      ? input.resolvePolicy(payload, { firstUser })
      : payload.policy || {};
    const verifiedAt = new Date(now).toISOString();
    const organization = this.createOrganization({
      name: payload.organizationName || payload.organizationSlug,
      slug: payload.organizationSlug,
      plan: payload.plan || 'free',
    });
    const user = this.createUser({
      name: payload.name || email,
      studentId: payload.studentId || '',
      clubMemberClaim: Boolean(payload.clubMemberClaim),
      email,
      passwordHash: payload.passwordHash,
      role: policy.role,
      accountType: policy.accountType,
      approvalStatus: policy.approvalStatus,
      emailVerifiedAt: verifiedAt,
    });
    const membership = this.addMember({ organizationId: organization.id, userId: user.id, role: 'owner' });
    row.consumedAt = verifiedAt;
    row.updatedAt = verifiedAt;
    return {
      status: 'verified',
      user,
      organization,
      membership,
      memberships: this.listMembershipsForUser(user.id),
      verifiedAt,
    };
  }

  attachGitHubRepositoryToService({ projectId, serviceId, integrationId, repositoryId = null, repoUrl = null, repository = null, branch = null, actorUserId = 'system' }: Record<string, any>) {
    const service = this.services.get(serviceId);
    if (!service) throw notFound(`service not found: ${serviceId}`);
    if (String(service.projectId) !== String(projectId)) throw forbidden('service does not belong to project');
    const project = this.projects.get(projectId);
    if (!project) throw notFound(`project not found: ${projectId}`);
    const integration = requireVerifiedGitHubIntegration(this.githubIntegrations, integrationId, project.organizationId);
    const repo = resolveGitHubRepositoryRecord([...this.githubRepositories.values()], integration.installationId, { repositoryId, repoUrl: repoUrl || repository });
    const resolvedBranch = branch || repo.defaultBranch || integration.defaultBranch || 'main';
    const binding = gitHubServiceBinding(integration, repo);
    const updated = this.updateService(serviceId, {
      sourceType: 'github',
      repoUrl: repo.repoUrl,
      branch: resolvedBranch,
      githubIntegrationId: integration.id,
      githubInstallationId: integration.installationId,
      githubRepositoryId: repo.githubRepoId,
      githubRepository: repo.fullName,
      githubRepositoryVisibility: repo.private ? 'private' : 'public',
      sourceAccess: repo.private ? 'github-app-private' : 'github-app-public',
      desiredState: { ...(service.desiredState || {}), ...binding, github: { ...(service.desiredState?.github || {}), ...binding.github, attached: true } },
    }, { allowDesiredState: true, allowGitHubBinding: true });
    this.audit(actorUserId, 'github:attach-repository', 'service', serviceId, { integrationId: integration.id, installationId: integration.installationId, repositoryId: repo.githubRepoId, repository: repo.fullName, branch: resolvedBranch });
    return { service: updated, github: { ...binding.github, branch: resolvedBranch } };
  }

  listGitHubInstallations({ organizationId }: Record<string, any>) {
    const integrations = this.listGitHubIntegrations({ organizationId });
    const installations = integrations
      .filter((integration: Record<string, any>) => integration.verifiedAt && integration.installationId)
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

  importGitHubRepository({ projectId, integrationId = null, repositoryId = null, repository, repoUrl, branch = null, serviceName = null, actorUserId = 'system' }: Record<string, any>) {
    const project = this.projects.get(projectId);
    if (!project) throw notFound(`project not found: ${projectId}`);
    const integration = requireVerifiedGitHubIntegration(this.githubIntegrations, integrationId, project.organizationId);
    const repo = resolveGitHubRepositoryRecord([...this.githubRepositories.values()], integration.installationId, { repositoryId, repoUrl: repoUrl || repository });
    const resolvedBranch = branch || repo.defaultBranch || integration.defaultBranch || 'main';
    const binding = gitHubServiceBinding(integration, repo);
    const created = this.createService({
      projectId,
      name: serviceName || repo.repo,
      type: 'web',
      runtimeType: 'container',
      sourceType: 'github',
      repoUrl: repo.repoUrl,
      branch: resolvedBranch,
      githubIntegrationId: integration.id,
      githubInstallationId: integration.installationId,
      githubRepositoryId: repo.githubRepoId,
      githubRepository: repo.fullName,
      githubRepositoryVisibility: repo.private ? 'private' : 'public',
      sourceAccess: repo.private ? 'github-app-private' : 'github-app-public',
    }, { allowGitHubBinding: true });
    const service = this.updateService(created.id, { desiredState: { ...binding, github: { ...binding.github, imported: true } } }, { allowDesiredState: true, allowGitHubBinding: true });
    this.audit(actorUserId, 'github:import-repository', 'project', projectId, { repository: repo.fullName, repositoryId: repo.githubRepoId, integrationId: integration.id, installationId: integration.installationId });
    return { service, github: { ...binding.github, branch: resolvedBranch } };
  }

  syncGitHubRepository({ repositoryId, repository, actorUserId = 'system', organizationId = null, organizationIds = null, serviceIds = null }: Record<string, any>) {
    const normalized = normalizeRepositoryId(repositoryId || repository);
    const matchedServices = this.servicesForGitHubRepository(normalized, { organizationId, organizationIds });
    const authorizedServiceIds = Array.isArray(serviceIds) ? new Set(serviceIds.map(String)) : null;
    const services = authorizedServiceIds
      ? matchedServices.filter((service) => authorizedServiceIds.has(String(service.id)))
      : matchedServices;
    const workflowJob = this.enqueueWorkflowJob({ type: 'github-repository-sync', targetType: 'github-repository', targetId: normalized, payload: { repository: normalized, serviceIds: services.map((service) => service.id) } });
    this.audit(actorUserId, 'github:repository-sync', 'github-repository', normalized, { serviceIds: services.map((service) => service.id) });
    return { repository: normalized, services: deepClone(services), workflowJob };
  }

  applyGitHubCatalogWebhook(event: any, payload: Record<string, any> = {}) {
    const eventName = String(event || '').toLowerCase();
    const action = String(payload.action || '').toLowerCase();
    const installationId = String(payload.installation?.id || '').trim();
    const accountLogin = String(payload.installation?.account?.login || '').trim().toLowerCase();
    const senderId = String(payload.sender?.id || '').trim();
    const actions: any[] = [];
    if (eventName === 'installation' && ['created', 'new_permissions_accepted'].includes(action)) {
      if (!/^\d+$/.test(installationId) || !accountLogin || !/^\d+$/.test(senderId)) return actions;
      const candidates = [...this.githubIntegrations.values()].filter((integration) => {
        const user = integration.userId ? this.users.get(integration.userId) : null;
        return String(integration.accountLogin || '').toLowerCase() === accountLogin
          && String(user?.githubId || '') === senderId
          && (!integration.verifiedAt || String(integration.installationId) === installationId);
      });
      if (candidates.length !== 1) return actions;
      const integration = this.verifyGitHubIntegration({
        integrationId: candidates[0].id,
        installationId,
        accountLogin,
        verifiedBy: 'github-installation-webhook',
      });
      for (const repository of Array.isArray(payload.repositories) ? payload.repositories : []) {
        if (!/^\d+$/.test(String(repository?.id || '')) || !repository?.full_name) continue;
        this.registerGitHubRepository({
          installationId,
          githubRepoId: String(repository.id),
          fullName: repository.full_name,
          defaultBranch: repository.default_branch || 'main',
          private: repository.private === true,
        });
      }
      actions.push({ type: 'github-installation-catalog-verified', integrationId: integration.id, installationId });
      return actions;
    }
    if (eventName === 'installation' && ['deleted', 'suspend'].includes(action) && /^\d+$/.test(installationId)) {
      let removed = 0;
      for (const [id, repository] of this.githubRepositories.entries()) {
        if (String(repository.installationId) === installationId) {
          this.githubRepositories.delete(id);
          removed += 1;
        }
      }
      for (const [id, integration] of this.githubIntegrations.entries()) {
        if (String(integration.installationId) === installationId) {
          this.githubIntegrations.set(id, { ...integration, verifiedAt: null, updatedAt: nowIso() });
        }
      }
      actions.push({ type: 'github-installation-catalog-invalidated', installationId, repositoryCount: removed });
      return actions;
    }
    if (eventName === 'installation_repositories' && /^\d+$/.test(installationId)) {
      const verified = [...this.githubIntegrations.values()].some((integration) => integration.verifiedAt && String(integration.installationId) === installationId);
      if (!verified) return actions;
      for (const repository of Array.isArray(payload.repositories_added) ? payload.repositories_added : []) {
        if (!/^\d+$/.test(String(repository?.id || '')) || !repository?.full_name) continue;
        this.registerGitHubRepository({ installationId, githubRepoId: String(repository.id), fullName: repository.full_name, defaultBranch: repository.default_branch || 'main', private: repository.private === true });
      }
      const removedIds = new Set((Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []).map((repository: any) => String(repository?.id || '')).filter((id: string) => /^\d+$/.test(id)));
      for (const [id, repository] of this.githubRepositories.entries()) {
        if (String(repository.installationId) === installationId && removedIds.has(String(repository.githubRepoId))) this.githubRepositories.delete(id);
      }
      actions.push({ type: 'github-installation-repositories-catalog-updated', installationId });
      return actions;
    }
    if (eventName === 'repository' && ['transferred', 'deleted', 'archived'].includes(action)) {
      const repositoryId = String(payload.repository?.id || '').trim();
      const repositoryName = normalizeRepositoryId(payload.repository?.full_name || '');
      if (!/^\d+$/.test(installationId) || !/^\d+$/.test(repositoryId) || !repositoryName) return actions;
      for (const [id, repository] of this.githubRepositories.entries()) {
        if (String(repository.installationId) === installationId
          && String(repository.githubRepoId) === repositoryId
          && normalizeRepositoryId(repository.fullName) === repositoryName) {
          this.githubRepositories.delete(id);
          actions.push({ type: 'github-repository-catalog-invalidated', installationId, repositoryId });
        }
      }
    }
    return actions;
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
    if (this.webhookEvents.get(id)?.handled) return { accepted: true, duplicate: true, deliveryId: id, actions: [] };
    const before = this.githubWebhookTransactionSnapshot();
    try {
      const actionPlan = githubWebhookActionPlan(event, payload || {});
      const actions: any[] = this.applyGitHubCatalogWebhook(event, payload || {});
      const services = this.servicesForGitHubWebhook(actionPlan);
      const blockedServiceIds = this.githubWebhookQuotaBlocks(services, actionPlan, actions);
      for (const service of services.filter((candidate) => !blockedServiceIds.has(String(candidate.id)))) {
      if (actionPlan.kind === 'production-deploy') {
        const deployment = this.createDeployment({ id: stableId('dep', 'github', id, service.id, actionPlan.kind), serviceId: service.id, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'production', triggerType: 'github_push', branch: actionPlan.branch });
        const workflowJob = this.enqueueWorkflowJob({ id: stableId('job', 'github', id, service.id, actionPlan.kind), type: 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, githubRepositoryId: actionPlan.repositoryId, githubInstallationId: actionPlan.installationId, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook', deliveryId: id } });
        actions.push({ type: 'production-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id });
      } else if (actionPlan.kind === 'preview-deploy') {
        const project = this.projects.get(service.projectId);
        const organization = project ? this.organizations.get(project.organizationId) : null;
        const previewPlan = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber });
        const deployment = this.createDeployment({ id: stableId('dep', 'github', id, service.id, actionPlan.kind), serviceId: service.id, commitSha: actionPlan.commitSha, status: 'queued', deploymentType: 'preview', triggerType: 'github_pull_request', branch: actionPlan.branch, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: previewPlan.url });
        const preview = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber, deploymentId: deployment.id });
        const workflowJob = this.enqueueWorkflowJob({ id: stableId('job', 'github', id, service.id, actionPlan.kind), type: 'preview-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId: service.id, projectId: service.projectId, deploymentId: deployment.id, repository: actionPlan.repository, githubRepositoryId: actionPlan.repositoryId, githubInstallationId: actionPlan.installationId, pullRequestNumber: actionPlan.pullRequestNumber, commitSha: actionPlan.commitSha, branch: actionPlan.branch, source: 'github-webhook', deliveryId: id, preview, kubernetes: preview.kubernetes } });
        this.appendDeploymentEvent({ deploymentId: deployment.id, type: 'preview.workload.queued', message: `Preview Kubernetes workload queued for PR #${actionPlan.pullRequestNumber}`, metadata: { previewUrl: preview.url, workloadName: preview.kubernetes.workloadName, namespace: preview.kubernetes.namespace } });
        actions.push({ type: 'preview-deployment-enqueued', serviceId: service.id, deploymentId: deployment.id, workflowJobId: workflowJob.id, pullRequestNumber: actionPlan.pullRequestNumber, previewUrl: preview.url, previewWorkloadName: preview.kubernetes.workloadName });
      } else if (actionPlan.kind === 'preview-cleanup') {
        const project = this.projects.get(service.projectId);
        const organization = project ? this.organizations.get(project.organizationId) : null;
        const preview = previewRuntimePlan({ service, project, organization, pullRequestNumber: actionPlan.pullRequestNumber, action: 'delete' });
        const workflowJob = this.enqueueWorkflowJob({ id: stableId('job', 'github', id, service.id, actionPlan.kind), type: 'preview-cleanup', targetType: 'service', targetId: service.id, payload: { serviceId: service.id, projectId: service.projectId, repository: actionPlan.repository, githubRepositoryId: actionPlan.repositoryId, githubInstallationId: actionPlan.installationId, pullRequestNumber: actionPlan.pullRequestNumber, branch: actionPlan.branch, source: 'github-webhook', deliveryId: id, preview, kubernetes: preview.kubernetes } });
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
      const row = { id: stableId('whe', 'github', id), provider: 'github', eventType: String(event || 'unknown'), deliveryId: id, payload: maskSecrets(payload || {}), handled: true, errorMessage: null, createdAt: nowIso() };
      this.webhookEvents.set(id, row);
      this.audit('github-webhook', 'github:webhook', 'github-delivery', id, { event, repository: actionPlan.repository, action: actionPlan.action, actions: actions.map((action) => action.type) });
      return { accepted: true, duplicate: false, deliveryId: id, event, action: actionPlan.action, repository: actionPlan.repository, matchedServiceCount: services.length, actions, outbound };
    } catch (error) {
      this.restoreGitHubWebhookTransaction(before);
      throw error;
    }
  }

  githubWebhookTransactionSnapshot() {
    const cloneMap = (source: Map<string, any>) => new Map([...source.entries()].map(([key, value]) => [key, deepClone(value)]));
    return {
      githubIntegrations: cloneMap(this.githubIntegrations),
      githubRepositories: cloneMap(this.githubRepositories),
      deployments: cloneMap(this.deployments),
      webhookEvents: cloneMap(this.webhookEvents),
      quotas: cloneMap(this.quotas),
      workflowJobs: deepClone(this.workflowJobs),
      deploymentEvents: deepClone(this.deploymentEvents),
      auditLogs: deepClone(this.auditLogs),
    };
  }

  restoreGitHubWebhookTransaction(snapshot: Record<string, any>) {
    this.githubIntegrations = snapshot.githubIntegrations;
    this.githubRepositories = snapshot.githubRepositories;
    this.deployments = snapshot.deployments;
    this.webhookEvents = snapshot.webhookEvents;
    this.quotas = snapshot.quotas;
    this.workflowJobs = snapshot.workflowJobs;
    this.deploymentEvents = snapshot.deploymentEvents;
    this.auditLogs = snapshot.auditLogs;
  }

  githubWebhookQuotaBlocks(services: any[], actionPlan: Record<string, any>, actions: any[]) {
    const blocked = new Set<string>();
    if (!['production-deploy', 'preview-deploy'].includes(String(actionPlan.kind || ''))) return blocked;
    const servicesByUser = new Map<string, any[]>();
    for (const service of services) {
      const project = this.projects.get(service.projectId);
      const desired = service.desiredState && typeof service.desiredState === 'object' && !Array.isArray(service.desiredState) ? service.desiredState : {};
      const github = desired.github && typeof desired.github === 'object' && !Array.isArray(desired.github) ? desired.github : {};
      const integrationId = String(service.githubIntegrationId || desired.githubIntegrationId || github.integrationId || '');
      const integration = integrationId ? this.githubIntegrations.get(integrationId) : null;
      const ownerMembership = project ? this.members.find((membership) => String(membership.organizationId) === String(project.organizationId) && String(membership.role || '').toLowerCase() === 'owner') : null;
      const userId = String(integration?.userId || ownerMembership?.userId || '');
      if (!integration?.verifiedAt
        || String(integration.installationId || '') !== String(actionPlan.installationId || '')
        || !project
        || String(integration.organizationId || '') !== String(project.organizationId || '')
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
      try {
        this.enforceUserCan({ userId, action: 'deployment:create:github-webhook', metric: 'maxDeploymentsPerDay', increment: ownedServices.length });
        if (actionPlan.kind === 'preview-deploy') {
          this.enforceUserCan({ userId, action: 'deployment:create:github-webhook', metric: 'maxPreviewDeployments', increment: ownedServices.length });
        }
      } catch {
        for (const service of ownedServices) blocked.add(String(service.id));
        actions.push({ type: 'github-webhook-quota-blocked', serviceIds: ownedServices.map((service) => service.id), reason: 'quota_or_approval_policy' });
      }
    }
    return blocked;
  }

  githubRepositoriesForIntegration(integrationId: string) {
    const integration = this.githubIntegrations.get(integrationId);
    if (!integration?.verifiedAt || !integration.installationId) return [];
    return [...this.githubRepositories.values()]
      .filter((repository) => String(repository.installationId) === String(integration.installationId))
      .map((repository) => ({
        id: repository.githubRepoId,
        githubRepoId: repository.githubRepoId,
        fullName: repository.fullName,
        owner: repository.owner,
        name: repository.repo,
        repoUrl: repository.repoUrl,
        defaultBranch: repository.defaultBranch,
        private: Boolean(repository.private),
      }));
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
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
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
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = nowIso();
    this.audit(actorUserId, 'user:reject', 'user', userId, {});
    return redactUser(deepClone(user));
  }

  banUser(userId: string, input: Record<string, any> = {}) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    const actorUserId = String(input.actorUserId || 'system');
    if (actorUserId === String(userId)) throw forbidden('administrators cannot ban themselves');
    const reason = normalizeBanReason(input.reason);
    const expiresAt = normalizeBanExpiresAt(input.expiresAt);
    user.bannedAt = nowIso();
    user.banExpiresAt = expiresAt;
    user.banReason = reason;
    user.bannedByUserId = actorUserId === 'system' ? null : actorUserId;
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = nowIso();
    this.audit(actorUserId, 'user:ban', 'user', userId, { reason, expiresAt, permanent: expiresAt === null });
    return redactUser(deepClone(user));
  }

  unbanUser(userId: string, input: Record<string, any> = {}) {
    const user = this.users.get(userId);
    if (!user) throw notFound(`user not found: ${userId}`);
    const actorUserId = String(input.actorUserId || 'system');
    user.bannedAt = null;
    user.banExpiresAt = null;
    user.banReason = null;
    user.bannedByUserId = null;
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    user.updatedAt = nowIso();
    this.audit(actorUserId, 'user:unban', 'user', userId, {});
    return redactUser(deepClone(user));
  }

  enforceUserCan({ userId, action, metric = null, increment = 1 }: Record<string, any>) {
    const user = this.users.get(userId);
    if (!user) return true;
    if (isActiveBan(user)) {
      this.audit(userId, 'user:ban-block', action || 'action', metric || action || 'unknown', { reason: user.banReason || 'banned', expiresAt: user.banExpiresAt || null });
      throw forbidden(`user ${userId} is banned and cannot ${action}`);
    }
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
    const month = utcMonthBounds();
    const organizationIds = new Set(this.members.filter((member) => String(member.userId) === String(userId)).map((member) => String(member.organizationId)));
    const projects = [...this.projects.values()].filter((project) => organizationIds.has(String(project.organizationId)));
    const projectIds = new Set(projects.map((project) => String(project.id)));
    const services = [...this.services.values()].filter((service) => projectIds.has(String(service.projectId)));
    const serviceIds = new Set(services.map((service) => String(service.id)));
    const resources = [...this.resources.values()].filter((resource) => projectIds.has(String(resource.projectId)));
    const deployments = [...this.deployments.values()].filter((deployment) => serviceIds.has(String(deployment.serviceId)) && isSameUtcDay(deployment.createdAt || deployment.startedAt, nowIso()));
    const scopedUsage = this.usageRecords.filter((record) => dateMs(record.recordedAt) >= month.start && dateMs(record.recordedAt) < month.end)
      .filter((record) => String(record.userId || '') === String(userId) || organizationIds.has(String(record.organizationId)) || projectIds.has(String(record.projectId)) || serviceIds.has(String(record.serviceId)) || resources.some((resource) => String(resource.id) === String(record.resourceId)));
    const allDeployments = [...this.deployments.values()].filter((deployment) => serviceIds.has(String(deployment.serviceId)));
    return {
      maxProjects: projects.length,
      maxServices: services.length,
      maxDeploymentsPerDay: deployments.length,
      maxPreviewDeployments: deployments.filter((deployment) => deployment.deploymentType === 'preview').length,
      maxDbStorageMb: resources.filter((resource) => resourceQuotaMetric(resource) === 'maxDbStorageMb').reduce((sum, resource) => sum + resourceStorageMb(resource), 0),
      maxObjectStorageMb: resources.filter((resource) => resourceQuotaMetric(resource) === 'maxObjectStorageMb').reduce((sum, resource) => sum + resourceStorageMb(resource), 0),
      maxBuildMinutesPerMonth: usageMetricSum(scopedUsage, ['build-minutes', 'build_minutes', 'buildMinutes', 'maxBuildMinutesPerMonth']) + allDeployments.reduce((sum, deployment) => sum + deploymentBuildMinutesWithin(deployment, month.start, month.end), 0),
      maxRuntimeHoursPerMonth: usageMetricSum(scopedUsage, ['runtime-hours', 'runtime_hours', 'runtimeHours', 'app-runtime-hours', 'maxRuntimeHoursPerMonth']) + allDeployments.reduce((sum, deployment) => sum + deploymentRuntimeHoursWithin(deployment, month.start, month.end), 0),
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
      const removedKeys = new Set(Object.keys(attachment.injectedEnv || {}));
    for (const key of Object.keys(attachment.injectedEnv || {})) {
      const id = stableId('env', attachment.serviceId, key);
      const row = this.environmentVariables.get(id);
      if (row?.source === `resource:${attachment.resourceId}`) {
          const secretRef = row.secretRef || row.secretId;
          if (secretRef && !String(secretRef).startsWith('k8s:')) this.secrets.delete(secretRef);
        this.environmentVariables.delete(id);
        delete environment[key];
      }
    }
      if (service) {
        const secretEnv = (Array.isArray(service.desiredSpec?.secretEnv) ? service.desiredSpec.secretEnv : []).filter((entry: any) => !removedKeys.has(String(entry?.name || '')));
        this.services.set(service.id, { ...service, environment, desiredSpec: { ...(service.desiredSpec || {}), secretEnv }, updatedAt: nowIso() });
      }
  }

  servicesForGitHubWebhook(actionPlan: Record<string, any>) {
    if (actionPlan.kind === 'ignored' || !actionPlan.repositoryId || !actionPlan.installationId || !actionPlan.repository) return [];
    return [...this.services.values()].filter((service) => serviceMatchesGitHubWebhook(service, actionPlan, this.githubRepositories));
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
      githubRepositories: [...this.githubRepositories.values()],
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
  const { passwordHash, bannedByUserId, ...rest } = user;
  return rest;
}

function isActiveBan(user: Record<string, any>, now = Date.now()) {
  if (!user?.bannedAt) return false;
  if (!user.banExpiresAt) return true;
  const expiresAt = new Date(user.banExpiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function normalizeBanReason(value: any) {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 500) throw badRequest('ban reason must be between 1 and 500 characters');
  return reason;
}

function normalizeBanExpiresAt(value: any) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw badRequest('ban expiration must be a valid future date');
  return new Date(timestamp).toISOString();
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

function notFound(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 404;
  return error;
}

function badRequest(message: string) {
  const error = new Error(message);
  (error as any).statusCode = 400;
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

function serviceMatchesGitHubWebhook(service: Record<string, any>, actionPlan: Record<string, any>, repositories: Map<string, any>) {
  const catalog = [...repositories.values()].find((repository) => String(repository.githubRepoId) === String(actionPlan.repositoryId)
    && String(repository.installationId) === String(actionPlan.installationId)
    && normalizeRepositoryId(repository.fullName) === normalizeRepositoryId(actionPlan.repository));
  if (!catalog) return false;
  const desired = service.desiredState && typeof service.desiredState === 'object' && !Array.isArray(service.desiredState) ? service.desiredState : {};
  const github = desired.github && typeof desired.github === 'object' && !Array.isArray(desired.github) ? desired.github : {};
  const repositoryId = String(service.githubRepositoryId || desired.githubRepositoryId || github.repositoryId || '');
  const installationId = String(service.githubInstallationId || desired.githubInstallationId || github.installationId || '');
  const repository = normalizeRepositoryId(service.githubRepository || desired.githubRepository || github.repository || service.repoUrl || '');
  if (repositoryId !== String(actionPlan.repositoryId)
    || installationId !== String(actionPlan.installationId)
    || repository !== normalizeRepositoryId(actionPlan.repository)) return false;
  const productionBranch = String(service.branch || desired.branch || 'main');
  return actionPlan.kind === 'production-deploy'
    ? String(actionPlan.branch) === productionBranch
    : String(actionPlan.baseBranch || '') === productionBranch;
}

function canonicalGitHubRepositoryRecord(input: Record<string, any>) {
  const installationId = String(input.installationId || '').trim();
  const githubRepoId = String(input.githubRepoId || input.repositoryId || '').trim();
  if (!installationId) throw badRequest('GitHub repository installationId is required');
  if (!githubRepoId) throw badRequest('GitHub repository githubRepoId is required');
  const parsed = parseGitHubRepository(input.fullName || (input.owner && input.name ? `${input.owner}/${input.name}` : ''));
  const owner = parsed.owner.toLowerCase();
  const repo = parsed.repo.toLowerCase();
  return {
    installationId,
    githubRepoId,
    owner,
    repo,
    name: repo,
    fullName: `${owner}/${repo}`,
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    defaultBranch: String(input.defaultBranch || 'main'),
    private: input.private === true,
  };
}

function requireVerifiedGitHubIntegration(integrations: Map<string, any>, integrationId: any, organizationId: any) {
  const id = String(integrationId || '').trim();
  const integration = id ? integrations.get(id) : null;
  if (!integration) throw notFound(`GitHub integration not found: ${id || '<missing>'}`);
  if (String(integration.organizationId) !== String(organizationId)) throw forbidden('GitHub integration does not belong to project organization');
  if (!integration.verifiedAt || !integration.installationId) throw forbidden('repository attachment requires a verified GitHub App installation');
  return integration;
}

function resolveGitHubRepositoryRecord(repositories: any[], installationId: any, selector: Record<string, any>) {
  const repositoryId = String(selector.repositoryId || '').trim();
  if (!repositoryId && !selector.repoUrl) throw badRequest('GitHub repositoryId or repository selector is required');
  let requestedFullName = '';
  if (selector.repoUrl) requestedFullName = parseGitHubRepository(selector.repoUrl).fullName.toLowerCase();
  const matching = repositories.filter((repository) => String(repository.installationId) === String(installationId));
  const record = matching.find((repository) => {
    const idMatches = !repositoryId || repositoryId === String(repository.githubRepoId) || repositoryId === String(repository.id);
    const nameMatches = !requestedFullName || requestedFullName === String(repository.fullName).toLowerCase();
    return idMatches && nameMatches;
  });
  if (!record) throw forbidden('repository is not available to the selected GitHub installation');
  return record;
}

function gitHubServiceBinding(integration: Record<string, any>, repository: Record<string, any>) {
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

function assertImmutableGitHubRepositoryBinding(current: Record<string, any>, updates: Record<string, any>) {
  const desired = current.desiredState || {};
  const github = desired.github || {};
  const expected = {
    githubIntegrationId: current.githubIntegrationId || desired.githubIntegrationId || github.integrationId,
    githubInstallationId: current.githubInstallationId || desired.githubInstallationId || github.installationId,
    githubRepositoryId: current.githubRepositoryId || desired.githubRepositoryId || github.repositoryId,
    githubRepository: current.githubRepository || desired.githubRepository || github.repository,
    githubRepositoryVisibility: current.githubRepositoryVisibility || desired.githubRepositoryVisibility || github.visibility,
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
      if (String(actual) !== String(wanted)) throw conflict('GitHub repository binding is immutable; create a new service to use another repository');
    }
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

function cancelActiveBuildWorkflowJobs(jobs: Record<string, any>[], deploymentId: string, reason: string) {
  const cancelledAt = nowIso();
  const buildTypes = new Set(['build-and-deploy', 'preview-deploy', 'build', 'builder']);
  for (const job of jobs) {
    const payloadDeploymentId = String(job.payload?.deploymentId || '').trim();
    const targetDeploymentId = String(job.targetType || '').trim().toLowerCase() === 'deployment'
      ? String(job.targetId || '').trim()
      : '';
    const boundDeploymentId = payloadDeploymentId && targetDeploymentId && payloadDeploymentId !== targetDeploymentId
      ? ''
      : (payloadDeploymentId || targetDeploymentId);
    if (!buildTypes.has(String(job.type || '').trim()) || boundDeploymentId !== deploymentId || !['queued', 'running'].includes(String(job.status || '').trim().toLowerCase())) continue;
    job.status = 'cancelled';
    job.lockedBy = null;
    job.lockedAt = null;
    job.updatedAt = cancelledAt;
    job.payload = maskSecrets({ ...(job.payload || {}), lastError: sanitizeLogRecord(reason), cancelledAt });
  }
}

import { RAIBITSERVERControlPlane } from './control-plane.ts';
import { maskSecrets } from './secrets.ts';
import { authorizeRequest, authorizeSubject, requireAction, requireScope, signJwtHs256, subjectFromRequest } from './auth.ts';
import { organizationScopeFromProjectInput } from './scope.ts';
import { createSessionToken, normalizeEmail, sessionTtlSeconds, shouldPromoteFirstLogin, verifyPasswordAsync } from './identity.ts';
import { assertUserEmailVerified, issueSignupEmailVerificationCode, resendEmailVerificationCode, verifyEmailCodeAndCreateSession } from './email-verification.ts';
import { runtimeConfigStatus } from './config.ts';
import { devHeaderAuthAllowed, devTokenAuthAllowed } from './config.ts';
import { normalizeEnvEntries, parseDotEnv } from './env-file.ts';
import { assertEnvironmentWriteAllowed } from './env-policy.ts';
import { quotaUsageGauges, quotaWarnings } from './quota.ts';
import { assertSystemDeploymentActor, enforceAuthAbuseLimits, safeAuthModeFromEnv, sanitizeDeploymentStatusInput, sanitizeTenantDeploymentCreate, sanitizeTenantResourceApiInput, sanitizeTenantResourceApiUpdate, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate, securityHeaders, validateServiceSecurity } from './security.ts';
import { githubOAuthLoginPlan } from './github-integration.ts';
import { createGitHubAppAuthorizationPlan, createGitHubAppInstallationPlan, resolveGitHubAppInstallationSelection, verifyGitHubAppInstallationState } from './github-app.ts';
import { boundedKeysetRows, keysetCursorForRows, resourceQuotaMetric, resourceStorageMb } from './store-helpers.ts';
import { publicSitesFromSnapshot } from './public-sites.ts';

export function createApiHandler(controlPlane = new RAIBITSERVERControlPlane(), options: Record<string, any> = {}) {
  const auth = {
    ...(options.auth || authConfigFromEnv()),
    currentUser: (userId: string) => controlPlane.store.findUserById(userId),
  };
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const method = req.method || 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', service: 'raibitserver-control-plane', auth: auth.mode || 'jwt' });
      }
      if (method === 'GET' && url.pathname === '/catalog') {
        return send(res, 200, { resources: controlPlane.catalog() });
      }
      if (method === 'GET' && url.pathname === '/public/sites') {
        return send(res, 200, publicSitesFromSnapshot(controlPlane.store.snapshot(), url.searchParams.get('limit')));
      }
      if (method === 'GET' && url.pathname === '/config/runtime') {
        authorizeRequest(req, 'audit:read', auth);
        return send(res, 200, { keys: runtimeConfigStatus(process.env) });
      }
      if (method === 'POST' && url.pathname === '/auth/signup') {
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 500, { error: 'jwt_secret_not_configured' });
        const email = normalizeEmail(body.email);
        await enforceAuthAbuseLimits(controlPlane.store, { action: 'signup', email, source: authRateSource(req), env: process.env });
        const emailVerification = await issueSignupEmailVerificationCode(controlPlane.store, { ...body, email }, { jwtSecret: auth.jwtSecret, issuer: auth.issuer || 'raibitserver', env: process.env });
        return send(res, 201, { emailVerification, signup: { status: 'verification_requested' } });
      }
      if (method === 'POST' && url.pathname === '/auth/email/verify') {
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 500, { error: 'jwt_secret_not_configured' });
        const email = normalizeEmail(body.email);
        await enforceAuthAbuseLimits(controlPlane.store, { action: 'email-verify', email, source: authRateSource(req), env: process.env });
        const result = await verifyEmailCodeAndCreateSession(controlPlane.store, body, { jwtSecret: auth.jwtSecret, issuer: auth.issuer || 'raibitserver', sessionTtlSeconds: auth.sessionTtlSeconds || sessionTtlSeconds(auth), env: process.env });
        return send(res, 200, { ...result, user: publicUser(result.user) });
      }
      if (method === 'POST' && url.pathname === '/auth/email/resend') {
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 500, { error: 'jwt_secret_not_configured' });
        const email = normalizeEmail(body.email);
        await enforceAuthAbuseLimits(controlPlane.store, { action: 'email-resend', email, source: authRateSource(req), env: process.env });
        const emailVerification = await resendEmailVerificationCode(controlPlane.store, body, { jwtSecret: auth.jwtSecret, issuer: auth.issuer || 'raibitserver', env: process.env });
        return send(res, 200, { emailVerification });
      }
      if (method === 'POST' && url.pathname === '/auth/login') {
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 500, { error: 'jwt_secret_not_configured' });
        const email = normalizeEmail(body.email);
        await enforceAuthAbuseLimits(controlPlane.store, { action: 'login', email, source: authRateSource(req), env: process.env });
        let user = controlPlane.store.findUserByEmail(email);
        const passwordValid = await verifyPasswordAsync(body.password, user?.passwordHash);
        if (!user || !passwordValid) return send(res, 401, { error: 'invalid_credentials' });
        assertUserEmailVerified(user);
        if (shouldPromoteFirstLogin(user, [...controlPlane.store.users.values()])) {
          user = controlPlane.store.approveUser(user.id, { accountType: 'NON_CLUB', role: 'ADMIN' });
        }
        assertUserApproved(user);
        const memberships = controlPlane.store.listMembershipsForUser(user.id);
        const token = createSessionToken(user, memberships, auth.jwtSecret, { issuer: auth.issuer || 'raibitserver', expiresInSeconds: auth.sessionTtlSeconds || sessionTtlSeconds(auth) });
        const { passwordHash: _passwordHash, ...publicUser } = user;
        return send(res, 200, { user: publicUser, memberships, token });
      }
      if (method === 'GET' && url.pathname === '/auth/github/login') {
        return send(res, 200, githubOAuthLoginPlan(Object.fromEntries(url.searchParams.entries())));
      }
      if (method === 'GET' && url.pathname === '/auth/github/callback') {
        if (url.searchParams.get('code') && !url.searchParams.get('state')) return send(res, 400, { error: 'oauth_state_required' });
        return send(res, 200, {
          provider: 'github',
          received: true,
          codePresent: Boolean(url.searchParams.get('code')),
          state: url.searchParams.get('state'),
          mode: 'oauth-callback-pending',
          linked: false,
        });
      }
      if (method === 'GET' && url.pathname === '/auth/me') {
        const subject = subjectFromRequest(req, auth);
        const user = controlPlane.store.users.get(subject.id) || null;
        const memberships = user ? controlPlane.store.listMembershipsForUser(user.id) : [];
        return send(res, 200, { user: user ? publicUser(user) : null, subject, memberships });
      }
      if (method === 'POST' && url.pathname === '/auth/logout') {
        const subject = subjectFromRequest(req, auth);
        if (subject.authMode === 'jwt' && subject.global !== true && controlPlane.store.findUserById(subject.id)) {
          controlPlane.store.incrementSessionVersion(subject.id);
        }
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && url.pathname === '/auth/dev-token') {
        if (!auth.allowDevToken) return send(res, 404, { error: 'not_found', path: url.pathname });
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 400, { error: 'jwt_secret_not_configured' });
        const token = signJwtHs256({ sub: body.sub || 'dev-user', role: body.role || 'developer', organizationId: body.organizationId || null, projectIds: body.projectIds || null, global: body.global === true }, auth.jwtSecret, { expiresInSeconds: auth.sessionTtlSeconds || sessionTtlSeconds(auth), issuer: auth.issuer || 'raibitserver' });
        return send(res, 201, { token });
      }
      if (method === 'GET' && url.pathname === '/snapshot') {
        authorizeRequest(req, 'audit:read', auth);
        const limit = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get('limit') || '200', 10) || 200));
        const users = [...controlPlane.store.users.values()].slice(-limit).map(publicUser);
        const userIds = new Set(users.map((user) => String(user.id)));
        const quotas = [...controlPlane.store.quotas.values()].filter((quota) => userIds.has(String(quota.userId))).slice(-limit);
        const auditLogs = controlPlane.store.auditLogs.slice(-limit).reverse();
        return send(res, 200, maskSecrets({ users, quotas, auditLogs }));
      }
      if (method === 'POST' && url.pathname === '/plan/build') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.planBuild(body.service || body, body.files || {}));
      }
      if (method === 'POST' && url.pathname === '/plan/source') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.planSourceCheckout(sanitizeTenantServiceInput(body.service || body) as any, body.options || {}));
      }
      if (method === 'POST' && url.pathname === '/plan/build-execution') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.planBuildExecution(sanitizeTenantServiceInput(body.service || body) as any, body.files || {}, body.options || {}));
      }
      if (method === 'POST' && url.pathname === '/plan/registry-push') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.planRegistryPush(body.image));
      }
      if (method === 'POST' && url.pathname === '/plan/kubernetes-apply') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.planKubernetesApply(projectSpecFromBody(body), body.filesByService || {}, body.options || {}));
      }
      if (method === 'POST' && url.pathname === '/plan/provisioning') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.planProvisioning(projectSpecFromBody(body)));
      }
      if (method === 'POST' && url.pathname === '/plan/compose') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.importCompose(body.compose || body.text || '', body.options || {}));
      }
      if (method === 'POST' && url.pathname === '/plan/manifests') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.compileManifests(projectSpecFromBody(body), body.filesByService || {}));
      }
      if (method === 'POST' && url.pathname === '/validate') {
        authorizeRequest(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, controlPlane.validateProject(projectSpecFromBody(body)));
      }
      if (method === 'POST' && url.pathname === '/guard/query') {
        const body = await readJson(req);
        const subject = authorizeRequest(req, body.options?.confirmed ? 'db:query:write' : 'db:data:read', auth, body.options?.scope || {});
        return send(res, 200, controlPlane.guardQuery(body.query, { role: subject.role, ...(body.options || {}) }));
      }
      if (method === 'GET' && url.pathname === '/organizations') {
        const subject = authorizeAction(req, 'project:read', auth);
        const organizations = [...controlPlane.store.organizations.values()].filter((org) => subject.global === true || subject.authMode === 'disabled' || matchesSubjectOrganization(subject, org.id));
        return send(res, 200, { organizations });
      }
      if (method === 'POST' && url.pathname === '/organizations') {
        authorizeRequest(req, 'team:invite', auth);
        const body = await readJson(req);
        return send(res, 201, controlPlane.store.createOrganization(body));
      }
      const organizationProjectsMatch = url.pathname.match(/^\/organizations\/([^/]+)\/projects$/);
      if (organizationProjectsMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const organizationId = decodeURIComponent(organizationProjectsMatch[1]);
        requireScope(subject, { organizationId });
        return send(res, 200, keysetPage('projects', boundedKeysetRows([...controlPlane.store.projects.values()].filter((project) => String(project.organizationId) === String(organizationId)), pageOptions(url)), 'createdAt'));
      }
      if (organizationProjectsMatch && method === 'POST') {
        const subject = authorizeAction(req, 'project:create', auth);
        const organizationId = decodeURIComponent(organizationProjectsMatch[1]);
        requireScope(subject, { organizationId });
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'project:create', metric: 'maxProjects', increment: 1 });
        const body = await readJson(req);
        return send(res, 201, controlPlane.store.createProject({ ...body, organizationId }));
      }
      if (method === 'GET' && url.pathname === '/projects') {
        const subject = authorizeAction(req, 'project:read', auth);
        const projects = boundedKeysetRows([...controlPlane.store.projects.values()].filter((project) => subject.global === true || subject.authMode === 'disabled' || matchesSubjectOrganization(subject, project.organizationId)), pageOptions(url));
        return send(res, 200, keysetPage('projects', projects, 'createdAt'));
      }
      if (method === 'POST' && url.pathname === '/projects') {
        const body = await readJson(req);
        const subject = authorizeAction(req, 'project:create', auth);
        const organizationId = organizationScopeFromProjectInput(body, subject);
        requireScope(subject, { organizationId });
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'project:create', metric: 'maxProjects', increment: 1 });
        return send(res, 201, controlPlane.store.createProject({ ...body, organizationId }));
      }
      const projectOverviewMatch = url.pathname.match(/^\/projects\/([^/]+)\/overview$/);
      if (projectOverviewMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const projectId = decodeURIComponent(projectOverviewMatch[1]);
        const scopedProject = await assertProjectAccess(controlPlane.store, projectId, subject);
        const project = controlPlane.store.getProject(projectId) || scopedProject;
        const services = [...controlPlane.store.services.values()].filter((service) => String(service.projectId) === String(projectId));
        const resources = [...controlPlane.store.resources.values()].filter((resource) => String(resource.projectId) === String(projectId));
        const deployments = [...controlPlane.store.deployments.values()]
          .filter((deployment) => String(deployment.projectId) === String(projectId))
          .sort((left, right) => Number(new Date(right.createdAt)) - Number(new Date(left.createdAt)))
          .slice(0, 200);
        return send(res, 200, { project, services, resources, deployments });
      }
      const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
      if (projectMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const projectId = decodeURIComponent(projectMatch[1]);
        const project = await assertProjectAccess(controlPlane.store, projectId, subject);
        return send(res, 200, project);
      }
      if (projectMatch && method === 'PATCH') {
        const subject = authorizeAction(req, 'project:update', auth);
        const projectId = decodeURIComponent(projectMatch[1]);
        await assertProjectAccess(controlPlane.store, projectId, subject);
        const project = controlPlane.store.updateProject(projectId, await readJson(req));
        if (!project) return send(res, 404, { error: 'project_not_found' });
        return send(res, 200, project);
      }
      if (projectMatch && method === 'DELETE') {
        const subject = authorizeAction(req, 'project:delete', auth);
        const projectId = decodeURIComponent(projectMatch[1]);
        await assertProjectAccess(controlPlane.store, projectId, subject);
        const project = controlPlane.store.deleteProject(projectId);
        if (!project) return send(res, 404, { error: 'project_not_found' });
        return send(res, 200, { deleted: true, projectId: project.id });
      }
      const projectServicesMatch = url.pathname.match(/^\/projects\/([^/]+)\/services$/);
      if (projectServicesMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const projectId = decodeURIComponent(projectServicesMatch[1]);
        await assertProjectAccess(controlPlane.store, projectId, subject);
        const services = boundedKeysetRows([...controlPlane.store.services.values()].filter((service) => String(service.projectId) === String(projectId)), pageOptions(url));
        return send(res, 200, keysetPage('services', services, 'createdAt'));
      }
      if (projectServicesMatch && method === 'POST') {
        const body = await readJson(req);
        const subject = authorizeAction(req, 'service:create', auth);
        const projectId = decodeURIComponent(projectServicesMatch[1]);
        await assertProjectAccess(controlPlane.store, projectId, subject);
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'service:create', metric: 'maxServices', increment: 1 });
        return send(res, 201, controlPlane.store.createService({ ...sanitizeTenantServiceInput(body), projectId }));
      }
      if (method === 'POST' && url.pathname === '/services') {
        const body = await readJson(req);
        const subject = authorizeAction(req, 'service:create', auth);
        await assertProjectAccess(controlPlane.store, body.projectId, subject);
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'service:create', metric: 'maxServices', increment: 1 });
        return send(res, 201, controlPlane.store.createService(sanitizeTenantServiceInput(body)));
      }
      const serviceMatch = url.pathname.match(/^\/services\/([^/]+)$/);
      if (serviceMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const serviceId = decodeURIComponent(serviceMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        return send(res, 200, service);
      }
      if (serviceMatch && method === 'PATCH') {
        const subject = authorizeAction(req, 'service:update', auth);
        const serviceId = decodeURIComponent(serviceMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        return send(res, 200, controlPlane.store.updateService(serviceId, sanitizeTenantServiceUpdate(await readJson(req))));
      }
      if (serviceMatch && method === 'DELETE') {
        const subject = authorizeAction(req, 'project:delete', auth);
        const serviceId = decodeURIComponent(serviceMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        const deleted = controlPlane.store.deleteService(serviceId);
        return send(res, 200, { deleted: true, serviceId: deleted.id });
      }
      const projectResourcesMatch = url.pathname.match(/^\/projects\/([^/]+)\/resources$/);
      if (projectResourcesMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const projectId = decodeURIComponent(projectResourcesMatch[1]);
        await assertProjectAccess(controlPlane.store, projectId, subject);
        const resources = boundedKeysetRows([...controlPlane.store.resources.values()].filter((resource) => String(resource.projectId) === String(projectId)), pageOptions(url));
        return send(res, 200, keysetPage('resources', resources, 'createdAt'));
      }
      if (projectResourcesMatch && method === 'POST') {
        const body = await readJson(req);
    const safeResource = sanitizeTenantResourceApiInput(body);
        const subject = authorizeAction(req, 'db:create', auth);
        const projectId = decodeURIComponent(projectResourcesMatch[1]);
        await assertProjectAccess(controlPlane.store, projectId, subject);
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'resource:create', metric: resourceQuotaMetric(safeResource), increment: resourceStorageMb(safeResource, { includeDesiredState: true }) });
    return send(res, 201, controlPlane.store.createResource({ ...safeResource, projectId }));
      }
      if (method === 'POST' && url.pathname === '/resources') {
        const body = await readJson(req);
    const safeResource = sanitizeTenantResourceApiInput(body);
        const subject = authorizeAction(req, 'db:create', auth);
        await assertProjectAccess(controlPlane.store, body.projectId, subject);
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'resource:create', metric: resourceQuotaMetric(safeResource), increment: resourceStorageMb(safeResource, { includeDesiredState: true }) });
    return send(res, 201, controlPlane.store.createResource(safeResource));
      }
      const resourceMatch = url.pathname.match(/^\/resources\/([^/]+)$/);
      if (resourceMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const resourceId = decodeURIComponent(resourceMatch[1]);
        const resource = controlPlane.store.getResource(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        return send(res, 200, resource);
      }
      if (resourceMatch && method === 'PATCH') {
        const subject = authorizeAction(req, 'db:create', auth);
        const resourceId = decodeURIComponent(resourceMatch[1]);
        const resource = controlPlane.store.getResource(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        return send(res, 200, controlPlane.store.updateResource(resourceId, sanitizeTenantResourceApiUpdate(await readJson(req))));
      }
      if (resourceMatch && method === 'DELETE') {
        const subject = authorizeAction(req, 'db:delete', auth);
        const resourceId = decodeURIComponent(resourceMatch[1]);
        const resource = controlPlane.store.getResource(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        const deleted = controlPlane.store.deleteResource(resourceId);
        return send(res, 200, { deleted: true, resourceId: deleted.id });
      }
      const resourceProvisionMatch = url.pathname.match(/^\/resources\/([^/]+)\/provision$/);
      if (resourceProvisionMatch && method === 'POST') {
        const subject = authorizeAction(req, 'db:create', auth);
        const resourceId = decodeURIComponent(resourceProvisionMatch[1]);
        const resource = controlPlane.store.getResource(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        return send(res, 202, await controlPlane.store.provisionResourceProvider({ ...(await readJson(req)), resourceId, actorUserId: subject.id }));
      }
      const resourceAttachMatch = url.pathname.match(/^\/resources\/([^/]+)\/attach$/);
      if (resourceAttachMatch && method === 'POST') {
        const subject = authorizeAction(req, 'db:create', auth);
        const resourceId = decodeURIComponent(resourceAttachMatch[1]);
        const resource = controlPlane.store.getResource(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        const body = await readJson(req);
        return send(res, 200, controlPlane.store.attachResource({ ...body, resourceId, actorUserId: subject.id }));
      }
      const serviceDeploymentsMatch = url.pathname.match(/^\/services\/([^/]+)\/deployments$/);
      if (serviceDeploymentsMatch && method === 'GET') {
        const serviceId = decodeURIComponent(serviceDeploymentsMatch[1]);
        const service = controlPlane.store.services.get(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        const subject = authorizeAction(req, 'project:read', auth);
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        const deployments = boundedKeysetRows([...controlPlane.store.deployments.values()].filter((deployment) => String(deployment.serviceId) === String(serviceId)), pageOptions(url));
        return send(res, 200, keysetPage('deployments', deployments, 'createdAt'));
      }
      if (serviceDeploymentsMatch && method === 'POST') {
        const serviceId = decodeURIComponent(serviceDeploymentsMatch[1]);
        const service = controlPlane.store.services.get(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        const body = await readJson(req);
        const deploymentType = body.deploymentType || body.type || 'production';
        const subject = authorizeAction(req, 'deploy:run', auth);
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxDeploymentsPerDay', increment: 1 });
        if (deploymentType === 'preview') controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxPreviewDeployments', increment: 1 });
        const security = validateServiceSecurity(service.desiredState || service.desiredSpec || service);
        if (!security.ok) return send(res, 403, { error: 'security_policy_violation', findings: security.findings });
        const branch = body.branch || service.branch || 'main';
        const deployment = controlPlane.store.createDeployment({ ...sanitizeTenantDeploymentCreate(body), serviceId, deploymentType, status: 'queued', branch });
        const workflowJob = controlPlane.store.enqueueWorkflowJob({ type: deploymentType === 'preview' ? 'preview-deploy' : 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId, projectId: service.projectId, deploymentId: deployment.id, branch, commitSha: body.commitSha || body.commitHash || null } });
        return send(res, 202, { ...deployment, workflowJob });
      }
      const projectServiceDeploymentsMatch = url.pathname.match(/^\/projects\/([^/]+)\/services\/([^/]+)\/deployments$/);
      if (projectServiceDeploymentsMatch && method === 'GET') {
        const [projectId, serviceId] = projectServiceDeploymentsMatch.slice(1).map(decodeURIComponent);
        const subject = authorizeAction(req, 'project:read', auth);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        const deployments = boundedKeysetRows([...controlPlane.store.deployments.values()].filter((deployment) => String(deployment.serviceId) === String(serviceId)), pageOptions(url));
        return send(res, 200, keysetPage('deployments', deployments, 'createdAt'));
      }
      if (projectServiceDeploymentsMatch && method === 'POST') {
        const [projectId, serviceId] = projectServiceDeploymentsMatch.slice(1).map(decodeURIComponent);
        const body = await readJson(req);
        const deploymentType = body.deploymentType || body.type || 'production';
        const subject = authorizeAction(req, 'deploy:run', auth);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxDeploymentsPerDay', increment: 1 });
        if (deploymentType === 'preview') controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxPreviewDeployments', increment: 1 });
        const service = controlPlane.store.services.get(serviceId);
        const security = validateServiceSecurity(service?.desiredState || service?.desiredSpec || service || {});
        if (!security.ok) return send(res, 403, { error: 'security_policy_violation', findings: security.findings });
        const branch = body.branch || service?.branch || 'main';
        const deployment = controlPlane.store.createDeployment({ ...sanitizeTenantDeploymentCreate(body), serviceId, deploymentType, status: 'queued', branch });
        const workflowJob = controlPlane.store.enqueueWorkflowJob({ type: deploymentType === 'preview' ? 'preview-deploy' : 'build-and-deploy', targetType: 'deployment', targetId: deployment.id, payload: { serviceId, projectId, deploymentId: deployment.id, branch, commitSha: body.commitSha || body.commitHash || null } });
        return send(res, 202, { ...deployment, workflowJob });
      }
      const deploymentMatch = url.pathname.match(/^\/deployments\/([^/]+)$/);
      if (deploymentMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const deploymentId = decodeURIComponent(deploymentMatch[1]);
        const deployment = controlPlane.store.getDeployment(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        return send(res, 200, deployment);
      }
      const deploymentStatusMatch = url.pathname.match(/^\/deployments\/([^/]+)\/status$/);
      if (deploymentStatusMatch && (method === 'PATCH' || method === 'POST')) {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const deploymentId = decodeURIComponent(deploymentStatusMatch[1]);
        const deployment = controlPlane.store.getDeployment(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        assertSystemDeploymentActor(subject);
        const body = sanitizeDeploymentStatusInput(await readJson(req));
        if (Object.prototype.hasOwnProperty.call(body, 'status')) {
          const { status, ...updates } = body;
          return send(res, 200, controlPlane.store.transitionDeployment(deploymentId, status, updates, { actorUserId: subject.id }));
        }
        return send(res, 200, controlPlane.store.updateDeployment(deploymentId, body, { actorUserId: subject.id }));
      }
      const deploymentActionMatch = url.pathname.match(/^\/deployments\/([^/]+)\/(cancel|rollback)$/);
      if (deploymentActionMatch && method === 'POST') {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const [deploymentId, action] = deploymentActionMatch.slice(1).map(decodeURIComponent);
        const deployment = controlPlane.store.getDeployment(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        const body = await readJson(req);
        if (action === 'rollback') {
          requireExplicitConfirmation(body);
          controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxDeploymentsPerDay', increment: 1 });
          if ((deployment.deploymentType || body.deploymentType || body.type) === 'preview') controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxPreviewDeployments', increment: 1 });
        }
        const result = action === 'cancel'
          ? controlPlane.store.cancelDeployment(deploymentId, { ...body, actorUserId: subject.id })
          : controlPlane.store.rollbackDeployment(deploymentId, { ...body, actorUserId: subject.id });
        return send(res, action === 'cancel' ? 200 : 202, result);
      }
      const deploymentLogsMatch = url.pathname.match(/^\/deployments\/([^/]+)\/(logs|events)$/);
      if (deploymentLogsMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const [deploymentId, kind] = deploymentLogsMatch.slice(1).map(decodeURIComponent);
        const deployment = controlPlane.store.deployments.get(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        const options = pageOptions(url);
        const rows = kind === 'logs' ? controlPlane.store.listDeploymentLogs(deploymentId, options) : controlPlane.store.listDeploymentEvents(deploymentId, options);
        return send(res, 200, activityPage(kind, rows));
      }
      const deploymentStreamMatch = url.pathname.match(/^\/deployments\/([^/]+)\/stream$/);
      if (deploymentStreamMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const deploymentId = decodeURIComponent(deploymentStreamMatch[1]);
        const deployment = controlPlane.store.getDeployment(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        return sendSseSnapshot(res, 'deployment.snapshot', {
          deployment,
          logs: controlPlane.store.listDeploymentLogs(deploymentId),
          events: controlPlane.store.listDeploymentEvents(deploymentId),
          stream: { mode: 'sse-snapshot', retryMs: 3000 },
        });
      }
      const runtimeLogsMatch = url.pathname.match(/^\/services\/([^/]+)\/logs$/);
      if (runtimeLogsMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const serviceId = decodeURIComponent(runtimeLogsMatch[1]);
        const service = controlPlane.store.services.get(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        return send(res, 200, activityPage('logs', controlPlane.store.listRuntimeLogs(serviceId, pageOptions(url))));
      }
      const runtimeStreamMatch = url.pathname.match(/^\/services\/([^/]+)\/logs\/stream$/);
      if (runtimeStreamMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const serviceId = decodeURIComponent(runtimeStreamMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        return sendSseSnapshot(res, 'service.logs.snapshot', {
          service,
          logs: controlPlane.store.listRuntimeLogs(serviceId),
          stream: { mode: 'sse-snapshot', retryMs: 3000 },
        });
      }
      const resourceConsoleTableMatch = url.pathname.match(/^\/resources\/([^/]+)\/console\/tables\/([^/]+)$/);
      if (resourceConsoleTableMatch && method === 'GET') {
        const subject = authorizeAction(req, 'db:data:read', auth);
        const [resourceId, table] = resourceConsoleTableMatch.slice(1).map(decodeURIComponent);
        const resource = controlPlane.store.resources.get(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        return send(res, 200, await controlPlane.store.resourceConsoleView(resourceId, 'table', { ...Object.fromEntries(url.searchParams.entries()), table, role: subject.role, actorUserId: subject.id }));
      }
      const resourceConsoleGetMatch = url.pathname.match(/^\/resources\/([^/]+)\/console\/(schema|tables|collections|keys)$/);
      if (resourceConsoleGetMatch && method === 'GET') {
        const subject = authorizeAction(req, 'db:schema:read', auth);
        const [resourceId, view] = resourceConsoleGetMatch.slice(1).map(decodeURIComponent);
        const resource = controlPlane.store.resources.get(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        return send(res, 200, await controlPlane.store.resourceConsoleView(resourceId, view, { ...Object.fromEntries(url.searchParams.entries()), role: subject.role, actorUserId: subject.id }));
      }
      const resourceConsoleQueryMatch = url.pathname.match(/^\/resources\/([^/]+)\/console\/(query|browse|command)$/);
      if (resourceConsoleQueryMatch && method === 'POST') {
        const [resourceId, action] = resourceConsoleQueryMatch.slice(1).map(decodeURIComponent);
        const permission = action === 'command' ? 'db:query:write' : 'db:data:read';
        const subject = authorizeAction(req, permission, auth);
        const body = await readJson(req);
        const resource = controlPlane.store.resources.get(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        if (action === 'query') return send(res, 200, await controlPlane.store.runResourceConsoleQuery(resourceId, body.query, { ...body, role: subject.role, actorUserId: subject.id }));
        if (action === 'command') return send(res, 200, await controlPlane.store.runResourceConsoleCommand(resourceId, body.command || body.query, { ...body, role: subject.role, actorUserId: subject.id }));
        return send(res, 200, await controlPlane.store.browseResourceConsole(resourceId, body));
      }
      const adminApproveMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/(approve|reject|ban|unban)$/);
      if (adminApproveMatch && method === 'POST') {
        const subject = authorizeAction(req, 'audit:read', auth);
        if (subject.userRole !== 'ADMIN' && subject.global !== true) return send(res, 403, { error: 'admin_required' });
        const [userId, action] = adminApproveMatch.slice(1).map(decodeURIComponent);
        const body = await readJson(req);
        if (action === 'reject') requireExplicitConfirmation(body);
        if (action === 'ban' && String(userId) === String(subject.id)) return send(res, 400, { error: 'cannot_ban_self' });
        if (action === 'approve') return send(res, 200, controlPlane.store.approveUser(userId, { ...body, actorUserId: subject.id }));
        if (action === 'reject') return send(res, 200, controlPlane.store.rejectUser(userId, { ...body, actorUserId: subject.id }));
        if (action === 'ban') return send(res, 200, controlPlane.store.banUser(userId, { ...body, actorUserId: subject.id }));
        return send(res, 200, controlPlane.store.unbanUser(userId, { ...body, actorUserId: subject.id }));
      }
      const adminQuotaMatch = url.pathname.match(/^\/admin\/users\/([^/]+)\/quota$/);
      if (adminQuotaMatch && (method === 'PATCH' || method === 'POST')) {
        const subject = authorizeAction(req, 'audit:read', auth);
        if (subject.userRole !== 'ADMIN' && subject.global !== true) return send(res, 403, { error: 'admin_required' });
        const body = await readJson(req);
        return send(res, 200, controlPlane.store.setQuota({ ...body, userId: decodeURIComponent(adminQuotaMatch[1]) }));
      }
      if (method === 'GET' && url.pathname === '/usage/me') {
        const subject = authorizeAction(req, 'metrics:read', auth);
        const usage = controlPlane.store.usageRecords.filter((row) => String(row.userId) === String(subject.id));
        const unlimited = subject.userRole === 'ADMIN' || subject.accountType === 'CLUB_MEMBER';
        const quota = unlimited ? null : [...controlPlane.store.quotas.values()].find((row) => String(row.userId) === String(subject.id));
        const current = controlPlane.store.quotaUsageForUser(subject.id);
        return send(res, 200, { accountType: subject.accountType, approvalStatus: subject.approvalStatus, unlimited, quota: quota || null, usage, current, gauges: quotaUsageGauges(current, quota || null), warnings: quotaWarnings(current, quota || null) });
      }
      const envMatch = url.pathname.match(/^\/projects\/([^/]+)\/services\/([^/]+)\/env$/);
      if (envMatch && method === 'GET') {
        const subject = authorizeAction(req, 'env:read', auth);
        const [projectId, serviceId] = envMatch.slice(1).map(decodeURIComponent);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        return send(res, 200, controlPlane.store.listServiceEnvironment({ projectId, serviceId }));
      }
      if (envMatch && method === 'POST') {
        const subject = authorizeAction(req, 'env:write-limited', auth);
        const [projectId, serviceId] = envMatch.slice(1).map(decodeURIComponent);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        const body = await readJson(req);
        const entries = normalizeEnvEntries(body.entries || body.environment || body, { source: body.source || 'api' });
        assertEnvironmentWriteAllowed(subject, entries);
        return send(res, 200, controlPlane.store.upsertServiceEnvironment({ projectId, serviceId, entries, actorUserId: subject.id, source: body.source || 'api' }));
      }
      const envFileMatch = url.pathname.match(/^\/projects\/([^/]+)\/services\/([^/]+)\/env-file$/);
      if (envFileMatch && method === 'POST') {
        const subject = authorizeAction(req, 'env:write-limited', auth);
        const [projectId, serviceId] = envFileMatch.slice(1).map(decodeURIComponent);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        const body = await readJson(req);
        const source = body.filename || '.env';
        const parsed = parseDotEnv(String(body.content || body.text || ''), { source });
        assertEnvironmentWriteAllowed(subject, parsed.entries);
        const result = controlPlane.store.upsertServiceEnvironment({ projectId, serviceId, entries: parsed.entries, actorUserId: subject.id, source });
        return send(res, 200, { ...result, source, parsed: { plainCount: parsed.plainCount, secretCount: parsed.secretCount, errors: parsed.errors } });
      }
      if (method === 'POST' && url.pathname === '/integrations/github') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const body = await readJson(req);
        const organizationId = body.organizationId || subject.organizationId;
        requireScope(subject, { organizationId });
        return send(res, 201, controlPlane.store.createGitHubIntegration({ ...body, organizationId, userId: subject.id }));
      }
      if (method === 'GET' && url.pathname === '/github/install') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = requiredSubjectOrganization(subject);
        requireScope(subject, { organizationId });
        return send(res, 200, createGitHubAppInstallationPlan({ userId: subject.id, organizationId }, options.githubApp || {}));
      }
      if (method === 'GET' && url.pathname === '/github/authorize') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = requiredSubjectOrganization(subject);
        requireScope(subject, { organizationId });
        return send(res, 200, createGitHubAppAuthorizationPlan({
          ...Object.fromEntries(url.searchParams.entries()),
          userId: subject.id,
          organizationId,
        }, options.githubApp || {}));
      }
      if (method === 'GET' && url.pathname === '/github/callback') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = requiredSubjectOrganization(subject);
        requireScope(subject, { organizationId });
        const callbackState = verifyGitHubAppInstallationState(url.searchParams.get('state'), {
          userId: subject.id,
          organizationId,
          purpose: 'github-app-authorize',
        }, options.githubApp || {});
        const selection = await resolveGitHubAppInstallationSelection({
          code: url.searchParams.get('code'),
          installationId: callbackState.installationId,
        }, options.githubApp || {});
        const integration = controlPlane.store.connectVerifiedGitHubInstallation({
          organizationId,
          userId: subject.id,
          installationId: selection.installationId,
          accountLogin: selection.accountLogin,
          accountType: selection.accountType,
          verifiedBy: subject.id,
        });
        const catalog = controlPlane.store.replaceGitHubInstallationRepositories({
          installationId: selection.installationId,
          repositories: selection.repositories,
          actorUserId: subject.id,
        });
        return send(res, 200, {
          connected: true,
          integration: {
            id: integration.id,
            installationId: integration.installationId,
            accountLogin: integration.accountLogin,
            verifiedAt: integration.verifiedAt,
          },
          repositoryCount: catalog.repositoryCount,
        });
      }
      if (method === 'GET' && url.pathname === '/integrations/github') {
        const subject = authorizeAction(req, 'project:read', auth);
        const organizationId = url.searchParams.get('organizationId') || subject.organizationId;
        requireScope(subject, { organizationId });
        return send(res, 200, { integrations: controlPlane.store.listGitHubIntegrations({ organizationId }) });
      }
      if (method === 'GET' && url.pathname === '/github/installations') {
        const subject = authorizeAction(req, 'project:read', auth);
        const organizationId = url.searchParams.get('organizationId') || subject.organizationId;
        requireScope(subject, { organizationId });
        return send(res, 200, controlPlane.store.listGitHubInstallations({ organizationId }));
      }
      const githubServiceMatch = url.pathname.match(/^\/projects\/([^/]+)\/services\/([^/]+)\/github$/);
      if (githubServiceMatch && method === 'POST') {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const [projectId, serviceId] = githubServiceMatch.slice(1).map(decodeURIComponent);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        const body = await readJson(req);
        return send(res, 200, controlPlane.store.attachGitHubRepositoryToService({
          projectId,
          serviceId,
          integrationId: body.integrationId,
          repositoryId: body.repositoryId || body.githubRepositoryId,
          repository: body.repository,
          repoUrl: body.repoUrl,
          branch: body.branch,
          actorUserId: subject.id,
        }));
      }
      const githubInstallationRepositoriesMatch = url.pathname.match(/^\/github\/installations\/([^/]+)\/repositories$/);
      if (githubInstallationRepositoriesMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        return send(res, 200, controlPlane.store.listGitHubInstallationRepositories({ installationId: decodeURIComponent(githubInstallationRepositoriesMatch[1]), organizationId: subject.organizationId, organizationIds: subject.organizationIds }));
      }
      if (method === 'POST' && url.pathname === '/github/webhooks') {
        const bodyText = await readRaw(req);
        const payload = bodyText.trim() ? JSON.parse(bodyText) : {};
        return send(res, 202, controlPlane.store.handleGitHubWebhook({
          event: req.headers['x-github-event'],
          deliveryId: req.headers['x-github-delivery'],
          signature: req.headers['x-hub-signature-256'],
          body: bodyText,
          payload,
        }));
      }
      if (method === 'POST' && url.pathname === '/github/repositories/import') {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const body = await readJson(req);
        await assertProjectAccess(controlPlane.store, body.projectId, subject);
        return send(res, 201, controlPlane.store.importGitHubRepository({ ...body, actorUserId: subject.id }));
      }
      const githubRepositorySyncMatch = url.pathname.match(/^\/github\/repositories\/([^/]+)\/sync$/);
      if (githubRepositorySyncMatch && method === 'POST') {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const body = await readJson(req);
        const repositoryId = decodeURIComponent(githubRepositorySyncMatch[1]);
        const authorizedTargets = assertGitHubRepositorySyncAccess(controlPlane.store, repositoryId, subject);
        return send(res, 202, controlPlane.store.syncGitHubRepository({
          ...body,
          repository: repositoryId,
          repositoryId,
          actorUserId: subject.id,
          ...authorizedTargets,
        }));
      }

      return send(res, 404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      return send(res, error.statusCode || 500, { error: error.message || 'internal_error' });
    }
  };
}

function matchesSubjectOrganization(subject: Record<string, any>, organizationId: any) {
  const expected = String(organizationId);
  if (subject.organizationId && String(subject.organizationId) === expected) return true;
  if (Array.isArray(subject.organizationIds) && subject.organizationIds.map(String).includes(expected)) return true;
  return false;
}

function authorizeAction(req: any, action: string, auth: Record<string, any>) {
  const subject = subjectFromRequest(req, auth);
  requireAction(subject, action);
  return subject;
}

function assertGitHubRepositorySyncAccess(store: any, repositoryId: string, subject: Record<string, any>) {
  if (subject.global === true || subject.claims?.global === true || subject.authMode === 'disabled') {
    return {
      organizationId: subject.organizationId,
      organizationIds: subject.organizationIds,
      serviceIds: null,
    };
  }
  const services = store.servicesForGitHubRepository(repositoryId, {
    organizationId: subject.organizationId,
    organizationIds: subject.organizationIds,
  });
  const organizationIds = new Set<string>();
  for (const service of services) {
    const project = store.projects.get(service.projectId);
    if (!project?.organizationId) {
      const error = new Error(`project not found: ${service.projectId}`);
      (error as any).statusCode = 404;
      throw error;
    }
    authorizeSubject({ ...subject }, 'deploy:run', { organizationId: project.organizationId });
    organizationIds.add(String(project.organizationId));
  }
  return {
    organizationId: null,
    organizationIds: [...organizationIds],
    serviceIds: services.map((service: Record<string, any>) => service.id),
  };
}

async function assertServiceAccess(store: any, projectId: string, serviceId: string, subject: Record<string, any>) {
  const service = store.services.get(serviceId);
  if (!service) {
    const error = new Error(`service not found: ${serviceId}`);
    (error as any).statusCode = 404;
    throw error;
  }
  if (String(service.projectId) !== String(projectId)) {
    const error = new Error('service does not belong to project');
    (error as any).statusCode = 403;
    throw error;
  }
  await assertProjectAccess(store, projectId, subject);
}

async function assertProjectAccess(store: any, projectId: string, subject: Record<string, any>) {
  const project = store.projects.get(projectId);
  if (!project) {
    const error = new Error(`project not found: ${projectId}`);
    (error as any).statusCode = 404;
    throw error;
  }
  if (subject.global === true || subject.authMode === 'disabled') return project;
  if (subject.projectId || Array.isArray(subject.projectIds)) requireScope(subject, { projectId });
  requireScope(subject, { organizationId: project.organizationId });
  return project;
}

function authConfigFromEnv() {
  const jwtSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET || '';
  const mode = safeAuthModeFromEnv(process.env);
  return {
    mode,
    allowDisabled: mode === 'disabled',
    jwtSecret,
    issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver',
    audience: process.env.RAIBITSERVER_AUTH_AUDIENCE || 'raibitserver-api',
    allowDevHeaders: devHeaderAuthAllowed(process.env),
    allowDevToken: devTokenAuthAllowed(process.env),
    defaultRole: process.env.RAIBITSERVER_ROLE || 'owner',
    sessionTtlSeconds: sessionTtlSeconds({ sessionTtlSeconds: process.env.RAIBITSERVER_SESSION_TTL_SECONDS }),
  };
}


function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function pageOptions(url: URL) {
  return {
    limit: url.searchParams.get('limit') || undefined,
    cursor: url.searchParams.get('cursor') || undefined,
    after: url.searchParams.get('after') || undefined,
  };
}

function keysetPage(key: string, rows: Array<Record<string, any>>, timestampField: string) {
  return { [key]: rows, nextCursor: keysetCursorForRows(rows, timestampField) };
}

function activityPage(key: string, rows: Array<Record<string, any>>) {
  return { [key]: rows, nextCursor: keysetCursorForRows(rows, 'timestamp') };
}

function projectSpecFromBody(body) {
  if (body.projectSpec) return body.projectSpec;
  if (body.services || body.resources || body.organization) return body;
  return body.project || body;
}

export async function readJson(req) {
  const text = await readRaw(req);
  if (!text.trim()) return {};
  const contentType = String(req.headers?.['content-type'] || req.headers?.['Content-Type'] || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text).entries());
  return JSON.parse(text);
}

export async function readRaw(req) {
  const chunks = [];
  const maxBytes = Number(process.env.RAIBITSERVER_MAX_BODY_BYTES || 1024 * 1024);
  let total = 0;
  for await (const chunk of req) {
    total += Buffer.byteLength(chunk);
    if (total > maxBytes) {
      const error = new Error('request_body_too_large');
      (error as any).statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function send(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendSseSnapshot(res, event, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(`retry: ${body?.stream?.retryMs || 3000}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
  res.end();
}

function authRateSource(req: any) {
  const headers = req.headers || {};
  const forwarded = process.env.RAIBITSERVER_TRUST_PROXY_HEADERS === '1'
    ? String(headers['x-forwarded-for'] || '').split(',')[0].trim()
    : '';
  return forwarded || req.socket?.remoteAddress || 'local';
}

function assertUserApproved(user: Record<string, any>) {
  if (isActiveUserBan(user)) {
    const error = new Error('account_banned');
    (error as any).statusCode = 403;
    throw error;
  }
  if (String(user?.approvalStatus || 'PENDING').toUpperCase() !== 'APPROVED') {
    const error = new Error('account_not_approved');
    (error as any).statusCode = 403;
    throw error;
  }
  return true;
}

function requiredSubjectOrganization(subject: Record<string, any>) {
  const organizationId = String(subject?.organizationId || '').trim();
  if (organizationId) return organizationId;
  const error = new Error('organization_scope_required');
  (error as any).statusCode = 400;
  throw error;
}

function isActiveUserBan(user: Record<string, any>, now = Date.now()) {
  if (!user?.bannedAt) return false;
  if (!user.banExpiresAt) return true;
  const expiresAt = new Date(user.banExpiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function requireExplicitConfirmation(input: Record<string, any>) {
  if (input?.confirmed === true || input?.confirmed === 'true') return;
  const error = new Error('confirmation_required');
  (error as any).statusCode = 400;
  throw error;
}

import { RAIBITSERVERControlPlane } from './control-plane.ts';
import { projectObservationPayload } from './observability-projection.ts';
import { publicDeploymentHealth } from './deployment-health.ts';
import { InMemoryControlPlaneRepository } from './persistence.ts';
import { DeploymentOperationError, parseDeploymentOperationBody } from './deployment-operations.ts';
import { oauthAttempt, publicOAuthError, OAuthPublicError } from './oauth-security.ts';
import { maskSecrets } from './secrets.ts';
import { authorizeRequest, authorizeSubject, requireAction, requireScope, signJwtHs256, subjectFromRequest } from './auth.ts';
import { organizationScopeFromProjectInput } from './scope.ts';
import { createSessionToken, normalizeEmail, sessionTtlSeconds, shouldPromoteFirstLogin, verifyPasswordAsync } from './identity.ts';
import { assertUserEmailVerified, issueSignupEmailVerificationCode, resendEmailVerificationCode, verifyEmailCodeAndCreateSession } from './email-verification.ts';
import { completePasswordRecovery, PASSWORD_RESET_COOLDOWN_SECONDS, requestPasswordRecovery } from './password-recovery.ts';
import { runtimeConfigStatus } from './config.ts';
import { devHeaderAuthAllowed, devTokenAuthAllowed } from './config.ts';
import { normalizeEnvEntries, parseDotEnv } from './env-file.ts';
import { assertEnvironmentWriteAllowed } from './env-policy.ts';
import { quotaUsageGauges, quotaWarnings } from './quota.ts';
import { assertSystemDeploymentActor, enforceAuthAbuseLimits, safeAuthModeFromEnv, sanitizeDeploymentStatusInput, sanitizeTenantDeploymentCreate, sanitizeTenantResourceApiInput, sanitizeTenantResourceApiUpdate, sanitizeTenantServiceInput, sanitizeTenantServiceUpdate, securityHeaders, validateServiceSecurity } from './security.ts';
import { consumeGitHubOAuthIdentity, startGitHubOAuth } from './github-oauth-flow.ts';
import { createGitHubAppAuthorizationPlan, createGitHubAppAuthorizationRetryPlan, createGitHubAppInstallationPlan, resolveGitHubAppInstallationSelection, verifyGitHubAppInstallationState } from './github-app.ts';
import { publicGitHubIntegration } from './github-lifecycle.ts';
import { boundedKeysetRows, keysetCursorForRows, resourceQuotaMetric, resourceStorageMb } from './store-helpers.ts';
import { publicSitesFromSnapshot } from './public-sites.ts';
import { decodeDeploymentActivityResumeToken, decodeServiceLogResumeToken, encodeDeploymentActivityResumeToken, encodeServiceLogResumeToken, DeploymentActivityResumeTokenError } from './sse.ts';
import { parseProjectDeletionConfirmation, parseProjectSettingsUpdate } from './project-settings.ts';
import { acceptOrganizationInvite, issueOrganizationInvite, listOrganizationInvites } from './organization-invite.ts';
import { changeOrganizationMembershipRole, leaveOrganization, listOrganizationMembers, removeOrganizationMember, revokeOrganizationInvite } from './membership-transition.ts';

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
      if (method === 'POST' && url.pathname === '/auth/password-reset/request') {
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 500, { error: 'jwt_secret_not_configured' });
        const email = normalizeEmail(body.email);
        await enforceAuthAbuseLimits(controlPlane.store, { action: 'password-reset', email, source: authRateSource(req), env: process.env });
        const result = await requestPasswordRecovery(controlPlane.store, { email }, { jwtSecret: auth.jwtSecret, env: process.env });
        res.setHeader('Retry-After', String(PASSWORD_RESET_COOLDOWN_SECONDS));
        return send(res, 202, result);
      }
      if (method === 'POST' && url.pathname === '/auth/password-reset/complete') {
        const body = await readJson(req);
        if (!auth.jwtSecret) return send(res, 500, { error: 'jwt_secret_not_configured' });
        const email = normalizeEmail(body.email);
        await enforceAuthAbuseLimits(controlPlane.store, { action: 'password-reset-complete', email, source: authRateSource(req), env: process.env });
        return send(res, 200, await completePasswordRecovery(controlPlane.store, { email, code: body.code, newPassword: body.newPassword }, { jwtSecret: auth.jwtSecret, env: process.env }));
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
        const input = Object.fromEntries([...url.searchParams.keys()].map((key) => [key, url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : url.searchParams.getAll(key)]));
        return send(res, 200, await oauthAttempt(controlPlane.store, 'github-oauth-start', () => startGitHubOAuth(controlPlane.store, input, {
          source: req.socket?.remoteAddress || '', jwtSecret: auth.jwtSecret, provider: options.githubOAuth,
        })));
      }
      if (method === 'GET' && url.pathname === '/auth/github/callback') {
        const input = Object.fromEntries([...url.searchParams.keys()].map((key) => [key, url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : url.searchParams.getAll(key)]));
        const response = await oauthAttempt(controlPlane.store, 'github-oauth-callback', async () => {
        if (!auth.jwtSecret) throw new OAuthPublicError('github_oauth_not_configured');
        const identity = await consumeGitHubOAuthIdentity(controlPlane.store, input, {
          source: req.socket?.remoteAddress || '', jwtSecret: auth.jwtSecret, provider: options.githubOAuth,
        });
        let user = controlPlane.store.findUserByGitHubId(identity.githubId) || controlPlane.store.findUserByEmail(identity.email);
        if (!user) throw statusError('github_account_not_registered', 403);
        assertUserEmailVerified(user);
        assertUserApproved(user);
        user = controlPlane.store.linkGitHubUser(user.id, {
          githubId: identity.githubId,
          githubLogin: identity.githubLogin,
          avatarUrl: identity.avatarUrl,
          name: user.name ? null : identity.name,
          actorUserId: user.id,
        });
        const memberships = controlPlane.store.listMembershipsForUser(user.id);
        const token = createSessionToken(user, memberships, auth.jwtSecret, { issuer: auth.issuer || 'raibitserver', expiresInSeconds: auth.sessionTtlSeconds || sessionTtlSeconds(auth) });
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
        return send(res, 200, response);
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
      const organizationInvitesMatch = url.pathname.match(/^\/organizations\/([^/]+)\/invites$/);
      if (organizationInvitesMatch && method === 'POST') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = decodeURIComponent(organizationInvitesMatch[1]);
        requireScope(subject, { organizationId });
        const body = await readJson(req);
        const result = await issueOrganizationInvite(controlPlane.store, { organizationId, email: body.email, role: body.role, actorUserId: subject.id }, options.organizationInvites || {});
        return send(res, 201, result);
      }
      if (organizationInvitesMatch && method === 'GET') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = decodeURIComponent(organizationInvitesMatch[1]);
        requireScope(subject, { organizationId });
        return send(res, 200, await listOrganizationInvites(controlPlane.store, { organizationId, actorUserId: subject.id }));
      }
      if (method === 'POST' && url.pathname === '/organization-invites/accept') {
        const subject = authorizeAction(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, await acceptOrganizationInvite(controlPlane.store, { token: body.token, userId: subject.id }));
      }
      const organizationMembersMatch = url.pathname.match(/^\/organizations\/([^/]+)\/members$/);
      if (organizationMembersMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const organizationId = decodeURIComponent(organizationMembersMatch[1]);
        return send(res, 200, await listOrganizationMembers(controlPlane.store, { organizationId, actorUserId: subject.id }));
      }
      const organizationMemberMatch = url.pathname.match(/^\/organizations\/([^/]+)\/members\/([^/]+)$/);
      if (organizationMemberMatch && method === 'PATCH') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = decodeURIComponent(organizationMemberMatch[1]);
        const membershipId = decodeURIComponent(organizationMemberMatch[2]);
        const body = await readJson(req);
        return send(res, 200, await changeOrganizationMembershipRole(controlPlane.store, { organizationId, membershipId, actorUserId: subject.id, role: body.role, expectedVersion: body.expectedVersion }));
      }
      if (organizationMemberMatch && method === 'DELETE') {
        const subject = authorizeAction(req, 'team:invite', auth);
        const organizationId = decodeURIComponent(organizationMemberMatch[1]);
        const membershipId = decodeURIComponent(organizationMemberMatch[2]);
        const body = await readJson(req);
        return send(res, 200, await removeOrganizationMember(controlPlane.store, { organizationId, membershipId, actorUserId: subject.id, expectedVersion: body.expectedVersion }));
      }
      const organizationLeaveMatch = url.pathname.match(/^\/organizations\/([^/]+)\/leave$/);
      if (organizationLeaveMatch && method === 'POST') {
        const subject = authorizeAction(req, 'project:read', auth);
        const body = await readJson(req);
        return send(res, 200, await leaveOrganization(controlPlane.store, { organizationId: decodeURIComponent(organizationLeaveMatch[1]), actorUserId: subject.id, expectedVersion: body.expectedVersion }));
      }
      const organizationInviteMatch = url.pathname.match(/^\/organizations\/([^/]+)\/invites\/([^/]+)$/);
      if (organizationInviteMatch && method === 'DELETE') {
        const subject = authorizeAction(req, 'team:invite', auth);
        return send(res, 200, await revokeOrganizationInvite(controlPlane.store, { organizationId: decodeURIComponent(organizationInviteMatch[1]), inviteId: decodeURIComponent(organizationInviteMatch[2]), actorUserId: subject.id }));
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
      const projectSettingsMatch = url.pathname.match(/^\/projects\/([^/]+)\/settings$/);
      if (projectSettingsMatch && method === 'GET') {
        const subject = authorizeAction(req, 'project:read', auth);
        const projectId = decodeURIComponent(projectSettingsMatch[1]);
        const project = await assertProjectAccess(controlPlane.store, projectId, subject);
        return send(res, 200, controlPlane.store.getProjectSettings(projectId, String(project.organizationId)));
      }
      if (projectSettingsMatch && method === 'PATCH') {
        const subject = authorizeAction(req, 'project:update', auth);
        const projectId = decodeURIComponent(projectSettingsMatch[1]);
        const input = parseProjectSettingsUpdate(await readJson(req));
        const project = await assertProjectAccess(controlPlane.store, projectId, subject);
        const settings = controlPlane.store.updateProjectSettings({
          projectId,
          organizationId: String(project.organizationId),
          actorUserId: typeof subject.id === 'string' ? subject.id : null,
          ...input,
        });
        return send(res, 200, settings);
      }
      const projectDeletionMatch = url.pathname.match(/^\/projects\/([^/]+)\/settings\/deletion$/);
      if (projectDeletionMatch && method === 'POST') {
        const subject = authorizeAction(req, 'project:delete', auth);
        const projectId = decodeURIComponent(projectDeletionMatch[1]);
        parseProjectDeletionConfirmation(await readJson(req));
        const project = await assertProjectAccess(controlPlane.store, projectId, subject);
        const scheduled = controlPlane.store.scheduleProjectDeletion({
          projectId,
          organizationId: String(project.organizationId),
          actorUserId: typeof subject.id === 'string' ? subject.id : null,
        });
        return send(res, 202, scheduled);
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
      const serviceSettingsMatch = url.pathname.match(/^\/services\/([^/]+)\/settings$/);
      if (serviceSettingsMatch && ['GET', 'PATCH'].includes(method)) {
        const permission = method === 'GET' ? 'project:read' : 'service:update';
        const subject = authorizeAction(req, permission, auth);
        const serviceId = decodeURIComponent(serviceSettingsMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        if (method === 'GET') return send(res, 200, controlPlane.store.getServiceSettings(serviceId));
        return send(res, 200, controlPlane.store.updateServiceSettings(serviceId, await readJson(req), { actorUserId: subject.id }));
      }
      const serviceSettingsPreviewMatch = url.pathname.match(/^\/services\/([^/]+)\/settings\/preview$/);
      if (serviceSettingsPreviewMatch && method === 'POST') {
        const subject = authorizeAction(req, 'service:update', auth);
        const serviceId = decodeURIComponent(serviceSettingsPreviewMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        return send(res, 200, controlPlane.store.previewServiceSettings(serviceId, await readJson(req), { actorUserId: subject.id }));
      }
      const serviceReplacementMatch = url.pathname.match(/^\/services\/([^/]+)\/replacements$/);
      if (serviceReplacementMatch && method === 'POST') {
        const subject = authorizeAction(req, 'service:create', auth);
        const serviceId = decodeURIComponent(serviceReplacementMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        return send(res, 201, controlPlane.store.createServiceReplacement(serviceId, await readJson(req), { actorUserId: subject.id }));
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
        return send(res, 200, controlPlane.store.updateService(serviceId, sanitizeTenantServiceUpdate(await readJson(req)), { actorUserId: subject.id }));
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
        return send(res, 200, controlPlane.store.updateResource(resourceId, sanitizeTenantResourceApiUpdate(await readJson(req), resource.engine)));
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
        const input = await readJson(req);
        const result = await controlPlane.store.provisionResourceProvider({ ...input, resourceId, actorUserId: subject.id });
        return send(res, 202, input.intent === 'live-provision' ? { ...result, operationId: `resource-provision:${resourceId}`, status: result.resource?.status || result.result?.status } : result);
      }
      const resourceAttachMatch = url.pathname.match(/^\/resources\/([^/]+)\/attach$/);
      if (resourceAttachMatch && method === 'POST') {
        const subject = authorizeAction(req, 'db:create', auth);
        const resourceId = decodeURIComponent(resourceAttachMatch[1]);
        const resource = controlPlane.store.getResource(resourceId);
        if (!resource) return send(res, 404, { error: 'resource_not_found' });
        await assertProjectAccess(controlPlane.store, resource.projectId, subject);
        const body = await readJson(req);
        const result = controlPlane.store.attachResource({ ...body, resourceId, actorUserId: subject.id });
        return send(res, 200, { ...result, operationId: result.id, status: 'ATTACHED' });
      }
      const lineageMatch = url.pathname.match(/^\/(deployments|services)\/([^/]+)\/(retry|redeploy)$/);
      if (lineageMatch && method === 'POST' && ((lineageMatch[1] === 'deployments' && lineageMatch[3] === 'retry') || (lineageMatch[1] === 'services' && lineageMatch[3] === 'redeploy'))) {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const id = decodeURIComponent(lineageMatch[2]);
        const source = lineageMatch[3] === 'retry' ? controlPlane.store.getDeployment(id) : null;
        const service = controlPlane.store.services.get(source?.serviceId || id);
        if (!service || (lineageMatch[3] === 'retry' && !source)) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404);
        try { await assertProjectAccess(controlPlane.store, service.projectId, subject); }
        catch (error) { if (error instanceof Error && 'statusCode' in error && error.statusCode === 403) throw new DeploymentOperationError('DEPLOYMENT_SOURCE_NOT_FOUND', 404); throw error; }
        const operation = lineageMatch[3] === 'retry' ? 'retry' : 'redeploy';
        const body = parseDeploymentOperationBody(await readJson(req));
        const result = await new InMemoryControlPlaneRepository(controlPlane.store).createDeploymentOperation({ ...body, operation, serviceId: service.id, ...(source ? { sourceDeploymentId: source.id } : {}), requestedByUserId: subject.id });
        return send(res, 202, { ...result, operationId: result.workflowJob.id, status: result.deployment.status, streamHref: `/deployments/${result.deployment.id}/stream` });
      }
      const serviceDeploymentsMatch = url.pathname.match(/^\/services\/([^/]+)\/deployments$/);
      if (serviceDeploymentsMatch && method === 'GET') {
        const serviceId = decodeURIComponent(serviceDeploymentsMatch[1]);
        const service = controlPlane.store.services.get(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        const subject = authorizeAction(req, 'project:read', auth);
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        const deployments = boundedKeysetRows([...controlPlane.store.deployments.values()].filter((deployment) => String(deployment.serviceId) === String(serviceId)), pageOptions(url));
        return send(res, 200, keysetPage('deployments', deployments.map(publicDeploymentHealth), 'createdAt'));
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
        return send(res, 202, { ...deployment, workflowJob, operationId: workflowJob.id, streamHref: `/deployments/${deployment.id}/stream` });
      }
      const projectServiceDeploymentsMatch = url.pathname.match(/^\/projects\/([^/]+)\/services\/([^/]+)\/deployments$/);
      if (projectServiceDeploymentsMatch && method === 'GET') {
        const [projectId, serviceId] = projectServiceDeploymentsMatch.slice(1).map(decodeURIComponent);
        const subject = authorizeAction(req, 'project:read', auth);
        await assertServiceAccess(controlPlane.store, projectId, serviceId, subject);
        const deployments = boundedKeysetRows([...controlPlane.store.deployments.values()].filter((deployment) => String(deployment.serviceId) === String(serviceId)), pageOptions(url));
        return send(res, 200, keysetPage('deployments', deployments.map(publicDeploymentHealth), 'createdAt'));
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
        return send(res, 202, { ...deployment, workflowJob, operationId: workflowJob.id, streamHref: `/deployments/${deployment.id}/stream` });
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
      const deploymentActionMatch = url.pathname.match(/^\/deployments\/([^/]+)\/(cancel|rollback|preview-cleanup)$/);
      if (deploymentActionMatch && method === 'POST') {
        const subject = authorizeAction(req, 'deploy:run', auth);
        const [deploymentId, action] = deploymentActionMatch.slice(1).map(decodeURIComponent);
        const deployment = controlPlane.store.getDeployment(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        const body = await readJson(req);
        if (action === 'rollback' || action === 'preview-cleanup') {
          requireExplicitConfirmation(body);
        }
        if (action === 'rollback') {
          controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxDeploymentsPerDay', increment: 1 });
          if ((deployment.deploymentType || body.deploymentType || body.type) === 'preview') controlPlane.store.enforceUserCan({ userId: subject.id, action: 'deployment:create', metric: 'maxPreviewDeployments', increment: 1 });
        }
        if (action === 'preview-cleanup') return send(res, 202, controlPlane.store.requestPreviewCleanup(deploymentId, { actorUserId: subject.id }));
        if (action === 'cancel') {
          const result = controlPlane.store.cancelDeployment(deploymentId, { ...body, actorUserId: subject.id });
          return send(res, 200, { ...result, operationId: `deployment-cancel:${deploymentId}`, status: result.deployment?.status, streamHref: `/deployments/${result.deployment?.id || deploymentId}/stream` });
        }
        const result = controlPlane.store.rollbackDeployment(deploymentId, { ...body, actorUserId: subject.id });
        const operationId = result.workflowJob?.id || `deployment-rollback:${deploymentId}`;
        return send(res, 202, { ...result, operationId, status: result.deployment?.status, streamHref: `/deployments/${result.deployment?.id || deploymentId}/stream` });
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
        return send(res, 200, activityPage(kind, rows, options, kind === 'logs' ? controlPlane.store.logPemContext(rows) : []));
      }
      const deploymentStreamMatch = url.pathname.match(/^\/deployments\/([^/]+)\/stream$/);
      if (deploymentStreamMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const deploymentId = decodeURIComponent(deploymentStreamMatch[1]);
        const deployment = controlPlane.store.getDeployment(deploymentId);
        if (!deployment) return send(res, 404, { error: 'deployment_not_found' });
        await assertProjectAccess(controlPlane.store, deployment.projectId, subject);
        const scope = { projectId: String(deployment.projectId), deploymentId: String(deployment.id) };
        const lastEventId = req.headers?.['last-event-id'];
        const resume = lastEventId === undefined ? null : decodeDeploymentActivityResumeToken(lastEventId, scope);
        const deploymentCursor = entityStreamCursor(deployment);
        const logs = controlPlane.store.listDeploymentLogs(deploymentId, { cursor: resume?.logCursorToken || undefined });
        const events = controlPlane.store.listDeploymentEvents(deploymentId, { cursor: resume?.eventCursorToken || undefined });
        const body = projectObservationPayload({
          deployment: resume?.deploymentCursor === deploymentCursor ? null : deployment,
          logs,
          events,
          deploymentCursor,
          logCursor: resume?.logCursorToken || null,
          eventCursor: resume?.eventCursorToken || null,
          stream: { mode: 'sse-snapshot', retryMs: 3000 },
        }, { logContexts: controlPlane.store.logPemContext(logs), unknownLogState: true });
        return sendSseSnapshot(res, 'deployment.snapshot', body, { eventId: encodeDeploymentActivityResumeToken(scope, body), preprojected: true });
      }
      const runtimeLogsMatch = url.pathname.match(/^\/services\/([^/]+)\/logs$/);
      if (runtimeLogsMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const serviceId = decodeURIComponent(runtimeLogsMatch[1]);
        const service = controlPlane.store.services.get(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        const options = pageOptions(url);
        const logs = controlPlane.store.listRuntimeLogs(serviceId, options);
        return send(res, 200, activityPage('logs', logs, options, controlPlane.store.logPemContext(logs)));
      }
      const runtimeStreamMatch = url.pathname.match(/^\/services\/([^/]+)\/logs\/stream$/);
      if (runtimeStreamMatch && method === 'GET') {
        const subject = authorizeAction(req, 'logs:read', auth);
        const serviceId = decodeURIComponent(runtimeStreamMatch[1]);
        const service = controlPlane.store.getService(serviceId);
        if (!service) return send(res, 404, { error: 'service_not_found' });
        await assertProjectAccess(controlPlane.store, service.projectId, subject);
        const scope = { projectId: String(service.projectId), serviceId: String(service.id) };
        const lastEventId = req.headers?.['last-event-id'];
        const resume = lastEventId === undefined ? null : decodeServiceLogResumeToken(lastEventId, scope);
        const serviceCursor = entityStreamCursor(service);
        const logs = controlPlane.store.listRuntimeLogs(serviceId, { cursor: resume?.logCursorToken || undefined });
        const body = {
          service: resume?.serviceCursor === serviceCursor ? null : service,
          logs,
          serviceCursor,
          logCursor: resume?.logCursorToken || null,
          stream: { mode: 'sse-snapshot', retryMs: 3000 },
        };
        const projected = projectObservationPayload(body, { logContexts: controlPlane.store.logPemContext(logs), unknownLogState: true });
        const eventId = encodeServiceLogResumeToken(scope, projected);
        return sendSseSnapshot(res, 'service.logs.snapshot', projected, { eventId, preprojected: true });
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
        let callbackState;
        try {
          callbackState = verifyGitHubAppInstallationState(url.searchParams.get('state'), {
            userId: subject.id,
            organizationId,
            purpose: 'github-app-authorize',
          }, options.githubApp || {});
        } catch (error) {
          if ((error as any)?.code !== 'github_install_state_expired') throw error;
          const retry = createGitHubAppAuthorizationRetryPlan({
            state: url.searchParams.get('state'),
            userId: subject.id,
            organizationId,
          }, options.githubApp || {});
          return send(res, 200, {
            connected: false,
            resumeRequired: true,
            authorizationUrl: retry.authorizationUrl,
          });
        }
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
          integration: publicGitHubIntegration(integration),
          repositoryCount: catalog.repositoryCount,
        });
      }
      if (method === 'GET' && url.pathname === '/integrations/github') {
        const subject = authorizeAction(req, 'project:read', auth);
        const organizationId = url.searchParams.get('organizationId') || subject.organizationId;
        requireScope(subject, { organizationId });
        return send(res, 200, { integrations: controlPlane.store.listGitHubIntegrations({ organizationId }) });
      }
      const githubDisconnectMatch = url.pathname.match(/^\/organizations\/([^/]+)\/integrations\/github\/([^/]+)\/disconnect$/);
      if (githubDisconnectMatch && method === 'POST') {
        const subject = authorizeAction(req, 'github:disconnect', auth);
        const [organizationId, integrationId] = githubDisconnectMatch.slice(1).map(decodeURIComponent);
        requireScope(subject, { organizationId });
        const body = await readJson(req);
        return send(res, 200, controlPlane.store.disconnectGitHubIntegration({ organizationId, integrationId, expectedVersion: body.expectedVersion, actorUserId: subject.id }));
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
      if (/^\/auth\/github\/(login|callback)(\?|$)/.test(req.url || '')) {
        const safe = publicOAuthError(error);
        if (safe.statusCode === 429) res.setHeader('Retry-After', String(safe.retryAfterSeconds));
        return send(res, safe.statusCode, { statusCode: safe.statusCode, message: safe.code, error: safe.code });
      }
      if (error instanceof DeploymentActivityResumeTokenError) return send(res, 400, { statusCode: 400, message: error.code, code: error.code, retryable: false, terminal: true, permission: false });
      if (error instanceof DeploymentOperationError) return send(res, error.statusCode, { statusCode: error.statusCode, message: error.message, code: error.code, retryable: error.code === 'ACTIVE_DEPLOYMENT', terminal: error.code !== 'ACTIVE_DEPLOYMENT', permission: false });
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      if (statusCode === 429 && Number.isInteger(error.retryAfterSeconds)) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      const permission = statusCode === 401 || statusCode === 403;
      const retryable = !permission && (statusCode === 408 || statusCode === 429 || statusCode >= 500);
      const message = error.message || 'internal_error';
      return send(res, statusCode, { statusCode, message, error: message, retryable, terminal: !retryable, permission, ...(error.code ? { code: error.code } : {}), ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}) });
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

function statusError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
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

function activityPage(key: string, rows: Array<Record<string, any>>, options: Record<string, any> = {}, logContexts: readonly any[] = []) {
  return projectObservationPayload(
    { [key]: rows, nextCursor: keysetCursorForRows(rows, 'timestamp'), logContinuationUnknown: key === 'logs' },
    key === 'logs' ? { logContexts, unknownLogState: true } : {},
  );
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

type SseSnapshotOptions = {
  readonly projectionOptions?: Parameters<typeof projectObservationPayload>[1];
  readonly eventId?: string;
  readonly preprojected?: boolean;
};

export function sendSseSnapshot(res, event, body, options: SseSnapshotOptions = {}) {
  const payload = JSON.stringify(options.preprojected ? body : projectObservationPayload(body, options.projectionOptions));
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(`retry: ${body?.stream?.retryMs || 3000}\n`);
  if (options.eventId) res.write(`id: ${options.eventId}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
  res.end();
}

function entityStreamCursor(row: Record<string, any>) {
  return `${row.updatedAt || row.createdAt || ''}:${row.status || ''}:${row.id || ''}`;
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

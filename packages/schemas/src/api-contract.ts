import { z } from 'zod';
import { DeploymentOperationInputSchema } from './deployment-operation.ts';
import { ResourceBackupCreateSchema, ResourceBackupDeleteSchema, ResourceBackupListSchema, ResourceBackupListViewSchema, ResourceBackupViewSchema, ResourceRestoreCreateSchema, ResourceRestoreViewSchema } from './resource-recovery.ts';
import { PasswordRecoveryAcceptedSchema, PasswordRecoveryCompleteSchema, PasswordRecoveryCompletedSchema, PasswordRecoveryRequestSchema } from './password-recovery.ts';
import * as M from './api-models.ts';
import { ProjectUpdateSchema, ServiceUpdateSchema, ResourceUpdateSchema } from './desired-state-mutations.ts';
import { ProjectDeletionConfirmationSchema, ProjectDeletionScheduledSchema, ProjectSettingsUpdateSchema, ProjectSettingsViewSchema } from './project-settings.ts';
import { OrganizationInviteAcceptSchema, OrganizationInviteAcceptanceSchema, OrganizationInviteCreateSchema, OrganizationInviteIssuedSchema, OrganizationInviteListSchema } from './organization-invite.ts';
import { ServiceReplacementInputSchema, ServiceReplacementResultSchema, ServiceSettingsMutationSchema, ServiceSettingsPreviewSchema, ServiceSettingsSnapshotSchema } from './service-settings.ts';
import { CustomDomainChallengeSchema, CustomDomainCreateSchema, CustomDomainListSchema, CustomDomainMutationSchema, CustomDomainRotateSchema, CustomDomainSchema } from './domain.ts';
import { OrganizationInviteRevokedSchema, OrganizationMemberListSchema, OrganizationMembershipChangedSchema, OrganizationMembershipLeftSchema, OrganizationMembershipRemovedSchema, OrganizationMembershipRoleChangeSchema, OrganizationMembershipSnapshotSchema } from './membership-transition.ts';

const id = z.string().min(1);
const project = z.object({ projectId: id });
const service = z.object({ serviceId: id });
const deployment = z.object({ deploymentId: id });
const resource = z.object({ resourceId: id });
const backup = z.object({ backupId: id });
const restore = z.object({ restoreId: id });
const user = z.object({ userId: id });
const organization = z.object({ organizationId: id });
const domain = z.object({ domainId: id });
const organizationMember = organization.extend({ membershipId: id });
const organizationInvite = organization.extend({ inviteId: id });
const scopedService = project.extend({ serviceId: id });
const orgQuery = z.object({ organizationId: id.optional() });
const organizationGitHubIntegration = z.object({ organizationId: id, integrationId: id });
const query = z.object({ query: z.string().min(1), confirmed: z.boolean().optional(), limit: z.number().int().max(1000).optional() });
function input<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType>(path: P, query: Q, body: B) { return z.object({ path, query, body }).strict(); }
const noInput = input(M.Empty, M.Empty, M.Empty);
export const GitHubOAuthStartInput = z.object({ codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/), redirectUri: z.string().max(2048).optional() }).strict();
const GitHubOAuthBinding = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), redirectUri: z.string().max(2048).optional() });
const GitHubOAuthCode = z.string().regex(/^[^\u0000-\u0020\u007f]{1,256}$/);
export const GitHubOAuthCallbackInput = z.union([
  GitHubOAuthBinding.extend({ code: GitHubOAuthCode, error: z.never().optional() }).strict(),
  GitHubOAuthBinding.extend({ error: z.literal('access_denied'), code: z.never().optional() }).strict(),
]);
const GitHubOAuthCallbackParameters = GitHubOAuthBinding.extend({ code: GitHubOAuthCode.optional(), error: z.literal('access_denied').optional() });
// Keep object-shaped wire metadata compatible with non-strict legacy consumers;
// the canonical union still owns both runtime validation and the public input type.
const GitHubOAuthCallbackWire = GitHubOAuthCallbackParameters.strict().refine((value) => GitHubOAuthCallbackInput.safeParse(value).success, 'github_oauth_input_invalid');
export const GitHubOAuthStartResponse = z.object({ provider: z.literal('github'), configured: z.literal(true), oauthUrl: z.url(), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), mode: z.literal('redirect') });
export const GitHubOAuthCallbackResponse = M.Session.extend({ provider: z.literal('github'), linked: z.literal(true), codePresent: z.literal(true), received: z.literal(true), mode: z.literal('oauth-complete') });
function operation<I extends z.ZodType, O extends z.ZodType>(spec: { readonly method: 'get' | 'post' | 'patch' | 'delete'; readonly path: string; readonly status: number; readonly permission: string | null; readonly input: I; readonly response: O; readonly stream?: string }) { return { ...spec, error: M.ErrorBody }; }

// A transport contract, not a list of claimed Nest handlers. Runtime parity discovers
// the independent module graph and verifies every verb, path, status and permission.
export const apiOperations = {
  'deployments-retry': operation({ method: 'post', path: '/deployments/{deploymentId}/retry', status: 202, permission: 'deploy:run', input: input(deployment, M.Empty, DeploymentOperationInputSchema), response: M.DeploymentOperationResult }),
  'services-redeploy': operation({ method: 'post', path: '/services/{serviceId}/redeploy', status: 202, permission: 'deploy:run', input: input(service, M.Empty, DeploymentOperationInputSchema), response: M.DeploymentOperationResult }),
  'health': operation({ method: 'get', path: '/health', status: 200, permission: null, input: noInput, response: z.object({ status: z.literal('ok'), service: z.literal('raibitserver-api'), uptimeSeconds: z.number().int().nonnegative() }) }),
  'auth-signup': operation({ method: 'post', path: '/auth/signup', status: 201, permission: null, input: input(M.Empty, M.Empty, M.SignupInput), response: M.Signup }),
  'auth-login': operation({ method: 'post', path: '/auth/login', status: 201, permission: null, input: input(M.Empty, M.Empty, M.AuthInput), response: M.Session }),
  'auth-email-verify': operation({ method: 'post', path: '/auth/email/verify', status: 201, permission: null, input: input(M.Empty, M.Empty, z.object({ email: z.email(), code: z.string().min(1) })), response: M.Session }),
  'auth-email-resend': operation({ method: 'post', path: '/auth/email/resend', status: 201, permission: null, input: input(M.Empty, M.Empty, z.object({ email: z.email() })), response: z.object({ emailVerification: M.EmailVerification }) }),
  'auth-password-reset-request': operation({ method: 'post', path: '/auth/password-reset/request', status: 202, permission: null, input: input(M.Empty, M.Empty, PasswordRecoveryRequestSchema), response: PasswordRecoveryAcceptedSchema }),
  'auth-password-reset-complete': operation({ method: 'post', path: '/auth/password-reset/complete', status: 200, permission: null, input: input(M.Empty, M.Empty, PasswordRecoveryCompleteSchema), response: PasswordRecoveryCompletedSchema }),
  'auth-github-login': operation({ method: 'get', path: '/auth/github/login', status: 200, permission: null, input: input(M.Empty, GitHubOAuthStartInput, M.Empty), response: GitHubOAuthStartResponse }),
  'auth-github-callback': operation({ method: 'get', path: '/auth/github/callback', status: 200, permission: null, input: input(M.Empty, GitHubOAuthCallbackWire, M.Empty), response: GitHubOAuthCallbackResponse }),
  'auth-me': operation({ method: 'get', path: '/auth/me', status: 200, permission: 'project:read', input: noInput, response: z.object({ user: M.User.nullable(), subject: M.JsonFields, memberships: z.array(M.Membership) }) }),
  'auth-logout': operation({ method: 'post', path: '/auth/logout', status: 200, permission: 'project:read', input: noInput, response: z.object({ ok: z.literal(true) }) }),
  'public-sites': operation({ method: 'get', path: '/public/sites', status: 200, permission: null, input: input(M.Empty, z.object({ limit: z.number().int().min(0).max(5).optional() }), M.Empty), response: z.object({ sites: z.array(z.object({ id, name: z.string(), owner: z.string(), status: z.literal('LIVE'), url: z.url() })) }) }),
  'organizations-invites': operation({ method: 'get', path: '/organizations/{organizationId}/invites', status: 200, permission: 'team:invite', input: input(organization, M.Empty, M.Empty), response: OrganizationInviteListSchema }),
  'organizations-invites-post': operation({ method: 'post', path: '/organizations/{organizationId}/invites', status: 201, permission: 'team:invite', input: input(organization, M.Empty, OrganizationInviteCreateSchema), response: OrganizationInviteIssuedSchema }),
  'organization-invites-accept-post': operation({ method: 'post', path: '/organization-invites/accept', status: 200, permission: 'project:read', input: input(M.Empty, M.Empty, OrganizationInviteAcceptSchema), response: OrganizationInviteAcceptanceSchema }),
  'organizations-members': operation({ method: 'get', path: '/organizations/{organizationId}/members', status: 200, permission: 'project:read', input: input(organization, M.Empty, M.Empty), response: OrganizationMemberListSchema }),
  'organizations-members-patch': operation({ method: 'patch', path: '/organizations/{organizationId}/members/{membershipId}', status: 200, permission: 'team:invite', input: input(organizationMember, M.Empty, OrganizationMembershipRoleChangeSchema), response: OrganizationMembershipChangedSchema }),
  'organizations-members-delete': operation({ method: 'delete', path: '/organizations/{organizationId}/members/{membershipId}', status: 200, permission: 'team:invite', input: input(organizationMember, M.Empty, OrganizationMembershipSnapshotSchema), response: OrganizationMembershipRemovedSchema }),
  'organizations-leave-post': operation({ method: 'post', path: '/organizations/{organizationId}/leave', status: 200, permission: 'project:read', input: input(organization, M.Empty, OrganizationMembershipSnapshotSchema), response: OrganizationMembershipLeftSchema }),
  'organizations-invites-delete': operation({ method: 'delete', path: '/organizations/{organizationId}/invites/{inviteId}', status: 200, permission: 'team:invite', input: input(organizationInvite, M.Empty, M.Empty), response: OrganizationInviteRevokedSchema }),
  'projects-list': operation({ method: 'get', path: '/projects', status: 200, permission: 'project:read', input: input(M.Empty, M.PageQuery, M.Empty), response: M.Projects }),
  'projects-create': operation({ method: 'post', path: '/projects', status: 201, permission: 'project:create', input: input(M.Empty, M.Empty, M.ProjectInput), response: M.Project }),
  'projects-get': operation({ method: 'get', path: '/projects/{projectId}', status: 200, permission: 'project:read', input: input(project, M.Empty, M.Empty), response: M.Project }),
  'projects-update': operation({ method: 'patch', path: '/projects/{projectId}', status: 200, permission: 'project:update', input: input(project, M.Empty, ProjectUpdateSchema), response: M.Project }),
  'projects-delete': operation({ method: 'delete', path: '/projects/{projectId}', status: 200, permission: 'project:delete', input: input(project, M.Empty, M.Empty), response: M.Deletion }),
  'project-settings-get': operation({ method: 'get', path: '/projects/{projectId}/settings', status: 200, permission: 'project:read', input: input(project, M.Empty, M.Empty), response: ProjectSettingsViewSchema }),
  'project-settings-update': operation({ method: 'patch', path: '/projects/{projectId}/settings', status: 200, permission: 'project:update', input: input(project, M.Empty, ProjectSettingsUpdateSchema), response: ProjectSettingsViewSchema }),
  'project-settings-delete': operation({ method: 'post', path: '/projects/{projectId}/settings/deletion', status: 202, permission: 'project:delete', input: input(project, M.Empty, ProjectDeletionConfirmationSchema), response: ProjectDeletionScheduledSchema }),
  'projects-overview': operation({ method: 'get', path: '/projects/{projectId}/overview', status: 200, permission: 'project:read', input: input(project, M.Empty, M.Empty), response: z.object({ project: M.Project, services: z.array(M.Service), resources: z.array(M.Resource), deployments: z.array(M.Deployment) }) }),
  'services-list': operation({ method: 'get', path: '/projects/{projectId}/services', status: 200, permission: 'project:read', input: input(project, M.PageQuery, M.Empty), response: M.Services }),
  'services-create': operation({ method: 'post', path: '/projects/{projectId}/services', status: 201, permission: 'service:create', input: input(project, M.Empty, M.ServiceInput), response: M.Service }),
  'services-get': operation({ method: 'get', path: '/services/{serviceId}', status: 200, permission: 'project:read', input: input(service, M.Empty, M.Empty), response: M.Service }),
  'services-update': operation({ method: 'patch', path: '/services/{serviceId}', status: 200, permission: 'service:update', input: input(service, M.Empty, ServiceUpdateSchema), response: M.Service }),
  'services-settings-get': operation({ method: 'get', path: '/services/{serviceId}/settings', status: 200, permission: 'project:read', input: input(service, M.Empty, M.Empty), response: ServiceSettingsSnapshotSchema }),
  'services-settings-preview': operation({ method: 'post', path: '/services/{serviceId}/settings/preview', status: 200, permission: 'service:update', input: input(service, M.Empty, ServiceSettingsMutationSchema), response: ServiceSettingsPreviewSchema }),
  'services-settings-update': operation({ method: 'patch', path: '/services/{serviceId}/settings', status: 200, permission: 'service:update', input: input(service, M.Empty, ServiceSettingsMutationSchema), response: ServiceSettingsSnapshotSchema }),
  'services-replacements-create': operation({ method: 'post', path: '/services/{serviceId}/replacements', status: 201, permission: 'service:create', input: input(service, M.Empty, ServiceReplacementInputSchema), response: ServiceReplacementResultSchema }),
  'services-delete': operation({ method: 'delete', path: '/services/{serviceId}', status: 200, permission: 'project:delete', input: input(service, M.Empty, M.Empty), response: M.Deletion }),
  'domains-list': operation({ method: 'get', path: '/projects/{projectId}/domains', status: 200, permission: 'domain:read', input: input(project, M.Empty, M.Empty), response: CustomDomainListSchema }),
  'domains-create': operation({ method: 'post', path: '/projects/{projectId}/domains', status: 201, permission: 'domain:manage', input: input(project, M.Empty, CustomDomainCreateSchema), response: CustomDomainChallengeSchema }),
  'domains-status': operation({ method: 'get', path: '/domains/{domainId}', status: 200, permission: 'domain:read', input: input(domain, M.Empty, M.Empty), response: CustomDomainSchema }),
  'domains-rotate': operation({ method: 'post', path: '/domains/{domainId}/rotate', status: 202, permission: 'domain:manage', input: input(domain, M.Empty, CustomDomainRotateSchema), response: CustomDomainChallengeSchema }),
  'domains-verify': operation({ method: 'post', path: '/domains/{domainId}/verify', status: 202, permission: 'domain:verify', input: input(domain, M.Empty, CustomDomainMutationSchema), response: CustomDomainSchema }),
  'domains-delete': operation({ method: 'delete', path: '/domains/{domainId}', status: 202, permission: 'domain:manage', input: input(domain, M.Empty, CustomDomainMutationSchema), response: CustomDomainSchema }),
  'project-deployments-list': operation({ method: 'get', path: '/projects/{projectId}/services/{serviceId}/deployments', status: 200, permission: 'project:read', input: input(scopedService, M.PageQuery, M.Empty), response: M.Deployments }),
  'project-deployments-create': operation({ method: 'post', path: '/projects/{projectId}/services/{serviceId}/deployments', status: 202, permission: 'deploy:run', input: input(scopedService, M.Empty, M.DeploymentInput), response: M.DeploymentMutationResult }),
  'deployments-list': operation({ method: 'get', path: '/services/{serviceId}/deployments', status: 200, permission: 'project:read', input: input(service, M.PageQuery, M.Empty), response: M.Deployments }),
  'deployments-create': operation({ method: 'post', path: '/services/{serviceId}/deployments', status: 202, permission: 'deploy:run', input: input(service, M.Empty, M.DeploymentInput), response: M.DeploymentMutationResult }),
  'deployments-get': operation({ method: 'get', path: '/deployments/{deploymentId}', status: 200, permission: 'project:read', input: input(deployment, M.Empty, M.Empty), response: M.Deployment }),
  'deployments-status': operation({ method: 'patch', path: '/deployments/{deploymentId}/status', status: 200, permission: 'deploy:run', input: input(deployment, M.Empty, M.StatusInput), response: M.Deployment }),
  'deployments-status-post': operation({ method: 'post', path: '/deployments/{deploymentId}/status', status: 201, permission: 'deploy:run', input: input(deployment, M.Empty, M.StatusInput), response: M.Deployment }),
  'deployments-cancel': operation({ method: 'post', path: '/deployments/{deploymentId}/cancel', status: 200, permission: 'deploy:run', input: input(deployment, M.Empty, M.Empty), response: z.object({ operationId: id, status: z.string(), streamHref: z.string(), deployment: M.Deployment }) }),
  'deployments-rollback': operation({ method: 'post', path: '/deployments/{deploymentId}/rollback', status: 202, permission: 'deploy:run', input: input(deployment, M.Empty, M.Confirmation.extend({ previousDeploymentId: id.optional(), imageUrl: z.string().optional() })), response: z.object({ operationId: id, status: z.string(), streamHref: z.string(), deployment: M.Deployment, rollbackOfDeploymentId: id, previousDeployment: M.Deployment.nullable(), workflowJob: M.JsonFields }) }),
  'deployments-preview-cleanup': operation({ method: 'post', path: '/deployments/{deploymentId}/preview-cleanup', status: 202, permission: 'deploy:run', input: input(deployment, M.Empty, M.Confirmation), response: M.PreviewCleanupResult }),
  'deployments-logs': operation({ method: 'get', path: '/deployments/{deploymentId}/logs', status: 200, permission: 'logs:read', input: input(deployment, M.PageQuery, M.Empty), response: M.Logs }),
  'deployments-events': operation({ method: 'get', path: '/deployments/{deploymentId}/events', status: 200, permission: 'logs:read', input: input(deployment, M.PageQuery, M.Empty), response: M.Events }),
  'deployments-stream': operation({ method: 'get', path: '/deployments/{deploymentId}/stream', status: 200, permission: 'logs:read', input: input(deployment, M.Empty, M.Empty), response: M.DeploymentStream, stream: 'deployment.snapshot' }),
  'services-logs': operation({ method: 'get', path: '/services/{serviceId}/logs', status: 200, permission: 'logs:read', input: input(service, M.PageQuery, M.Empty), response: M.Logs }),
  'services-logs-stream': operation({ method: 'get', path: '/services/{serviceId}/logs/stream', status: 200, permission: 'logs:read', input: input(service, M.Empty, M.Empty), response: M.ServiceStream, stream: 'service.logs.snapshot' }),
  'agent-plan': operation({ method: 'post', path: '/projects/{projectId}/deployment-agent/plan', status: 201, permission: 'project:read', input: input(project, M.Empty, M.AgentInput), response: M.AgentPlan }),
  'agent-apply': operation({ method: 'post', path: '/projects/{projectId}/deployment-agent/apply', status: 202, permission: 'deploy:run', input: input(project, M.Empty, M.AgentInput), response: z.object({ accepted: z.literal(true), generatedBy: z.string(), summary: z.string(), deploymentOrder: z.array(id), deployments: z.array(M.Deployment) }) }),
  'resources-list': operation({ method: 'get', path: '/projects/{projectId}/resources', status: 200, permission: 'project:read', input: input(project, M.PageQuery, M.Empty), response: M.Resources }),
  'resources-create': operation({ method: 'post', path: '/projects/{projectId}/resources', status: 201, permission: 'db:create', input: input(project, M.Empty, M.ResourceInput), response: M.Resource }),
  'resources-get': operation({ method: 'get', path: '/resources/{resourceId}', status: 200, permission: 'project:read', input: input(resource, M.Empty, M.Empty), response: M.Resource }),
  'resources-update': operation({ method: 'patch', path: '/resources/{resourceId}', status: 200, permission: 'db:create', input: input(resource, M.Empty, ResourceUpdateSchema), response: M.Resource }),
  'resources-delete': operation({ method: 'delete', path: '/resources/{resourceId}', status: 200, permission: 'db:delete', input: input(resource, M.Empty, M.Empty), response: M.Deletion }),
  'resources-attach': operation({ method: 'post', path: '/resources/{resourceId}/attach', status: 201, permission: 'db:create', input: input(resource, M.Empty, z.object({ serviceId: id, envPrefix: z.string().optional() })), response: z.object({ operationId: id, status: z.literal('ATTACHED'), resourceId: id, serviceId: id }).catchall(z.json()) }),
  'resources-provision': operation({ method: 'post', path: '/resources/{resourceId}/provision', status: 201, permission: 'db:create', input: input(resource, M.Empty, M.ResourceProvisionInput), response: z.object({ operationId: id.optional(), status: z.string().optional(), resource: M.Resource, result: M.ResourceProvisionResult }) }),
  'resource-backups-create': operation({ method: 'post', path: '/resources/{resourceId}/backups', status: 202, permission: 'backup:manage', input: input(resource, M.Empty, ResourceBackupCreateSchema), response: ResourceBackupViewSchema }),
  'resource-backups-list': operation({ method: 'get', path: '/resources/{resourceId}/backups', status: 200, permission: 'backup:manage', input: input(resource, ResourceBackupListSchema, M.Empty), response: ResourceBackupListViewSchema }),
  'resource-backups-delete': operation({ method: 'delete', path: '/backups/{backupId}', status: 200, permission: 'backup:manage', input: input(backup, M.Empty, ResourceBackupDeleteSchema), response: ResourceBackupViewSchema }),
  'backup-restores-create': operation({ method: 'post', path: '/backups/{backupId}/restores', status: 202, permission: 'backup:restore', input: input(backup, M.Empty, ResourceRestoreCreateSchema), response: ResourceRestoreViewSchema }),
  'restores-get': operation({ method: 'get', path: '/restores/{restoreId}', status: 200, permission: 'backup:restore', input: input(restore, M.Empty, M.Empty), response: ResourceRestoreViewSchema }),
  'console-schema': operation({ method: 'get', path: '/resources/{resourceId}/console/schema', status: 200, permission: 'db:schema:read', input: input(resource, M.BrowseInput, M.Empty), response: M.ConsoleResult.extend({ schema: M.JsonFields }) }),
  'console-tables': operation({ method: 'get', path: '/resources/{resourceId}/console/tables', status: 200, permission: 'db:schema:read', input: input(resource, M.BrowseInput, M.Empty), response: M.ConsoleResult.extend({ tables: z.array(z.json()) }) }),
  'console-table': operation({ method: 'get', path: '/resources/{resourceId}/console/tables/{table}', status: 200, permission: 'db:data:read', input: input(resource.extend({ table: id }), M.BrowseInput, M.Empty), response: M.ConsoleResult.extend({ rows: z.array(z.json()), rowCount: z.number() }) }),
  'console-collections': operation({ method: 'get', path: '/resources/{resourceId}/console/collections', status: 200, permission: 'db:schema:read', input: input(resource, M.BrowseInput, M.Empty), response: M.ConsoleResult.extend({ collections: z.array(z.json()) }) }),
  'console-keys': operation({ method: 'get', path: '/resources/{resourceId}/console/keys', status: 200, permission: 'db:schema:read', input: input(resource, M.BrowseInput, M.Empty), response: M.ConsoleResult.extend({ keys: z.array(z.json()) }) }),
  'console-query': operation({ method: 'post', path: '/resources/{resourceId}/console/query', status: 201, permission: 'db:data:read', input: input(resource, M.Empty, query), response: M.ConsoleResult }),
  'console-command': operation({ method: 'post', path: '/resources/{resourceId}/console/command', status: 201, permission: 'db:query:write', input: input(resource, M.Empty, query.partial().extend({ command: z.string().min(1) })), response: M.ConsoleResult }),
  'console-browse': operation({ method: 'post', path: '/resources/{resourceId}/console/browse', status: 201, permission: 'db:data:read', input: input(resource, M.Empty, M.BrowseInput), response: M.ConsoleResult }),
  'environment-list': operation({ method: 'get', path: '/projects/{projectId}/services/{serviceId}/env', status: 200, permission: 'env:read', input: input(scopedService, M.Empty, M.Empty), response: M.Environment }),
  'environment-upsert': operation({ method: 'post', path: '/projects/{projectId}/services/{serviceId}/env', status: 201, permission: 'env:write-limited', input: input(scopedService, M.Empty, z.object({ entries: z.array(z.object({ key: id, value: z.string(), isSecret: z.boolean().optional() })), source: z.string().optional() })), response: M.Environment }),
  'environment-upload': operation({ method: 'post', path: '/projects/{projectId}/services/{serviceId}/env-file', status: 201, permission: 'env:write-limited', input: input(scopedService, M.Empty, z.object({ filename: z.string(), content: z.string() })), response: M.Environment }),
  'github-install': operation({ method: 'get', path: '/github/install', status: 200, permission: 'team:invite', input: noInput, response: M.GithubUrl }),
  'github-authorize': operation({ method: 'get', path: '/github/authorize', status: 200, permission: 'team:invite', input: input(M.Empty, z.object({ installation_id: z.string().regex(/^[0-9]+$/), setup_action: z.enum(['install', 'update']), state: id }), M.Empty), response: M.GithubUrl }),
  'github-callback': operation({ method: 'get', path: '/github/callback', status: 200, permission: 'team:invite', input: input(M.Empty, z.object({ code: id, state: id }), M.Empty), response: z.union([z.object({ connected: z.literal(true), integration: M.JsonFields, repositoryCount: z.number().int() }), z.object({ connected: z.literal(false), resumeRequired: z.literal(true), authorizationUrl: z.url() })]) }),
  'github-installations': operation({ method: 'get', path: '/github/installations', status: 200, permission: 'project:read', input: input(M.Empty, orgQuery, M.Empty), response: z.object({ installations: z.array(M.JsonFields) }) }),
  'github-integrations-create': operation({ method: 'post', path: '/integrations/github', status: 201, permission: 'team:invite', input: input(M.Empty, M.Empty, z.object({ organizationId: id.optional(), accountLogin: id, installationId: id.optional() })), response: M.Integration }),
  'github-integrations-list': operation({ method: 'get', path: '/integrations/github', status: 200, permission: 'project:read', input: input(M.Empty, orgQuery, M.Empty), response: z.object({ integrations: z.array(M.Integration) }) }),
  'github-integrations-disconnect': operation({ method: 'post', path: '/organizations/{organizationId}/integrations/github/{integrationId}/disconnect', status: 200, permission: 'github:disconnect', input: input(organizationGitHubIntegration, M.Empty, z.object({ expectedVersion: z.number().int().positive() }).strict()), response: z.object({ integration: M.Integration, affectedServiceCount: z.number().int().nonnegative(), credentialIssuance: z.literal('denied'), githubAppUninstalled: z.literal(false) }).strict() }),
  'github-attach': operation({ method: 'post', path: '/projects/{projectId}/services/{serviceId}/github', status: 201, permission: 'deploy:run', input: input(scopedService, M.Empty, M.GithubAttach), response: z.object({ service: M.Service, github: M.JsonFields }) }),
  'github-repositories': operation({ method: 'get', path: '/github/installations/{installationId}/repositories', status: 200, permission: 'project:read', input: input(z.object({ installationId: id }), M.Empty, M.Empty), response: z.object({ installationId: id, repositories: z.array(M.Repository) }) }),
  'github-webhooks': operation({ method: 'post', path: '/github/webhooks', status: 201, permission: null, input: input(M.Empty, M.Empty, z.object({ action: z.string().optional(), repository: M.JsonFields.optional(), installation: M.JsonFields.optional() }).catchall(z.json())), response: z.object({ accepted: z.boolean() }).catchall(z.json()) }),
  'github-import': operation({ method: 'post', path: '/github/repositories/import', status: 201, permission: 'deploy:run', input: input(M.Empty, M.Empty, M.GithubAttach.extend({ projectId: id, serviceName: z.string().optional() })), response: z.object({ service: M.Service }).catchall(z.json()) }),
  'github-sync': operation({ method: 'post', path: '/github/repositories/{repositoryId}/sync', status: 201, permission: 'deploy:run', input: input(z.object({ repositoryId: id }), M.Empty, z.object({ integrationId: id.optional(), branch: z.string().optional() })), response: z.object({ repository: z.string(), services: z.array(M.Service), workflowJob: M.JsonFields }) }),
  'admin-approve': operation({ method: 'post', path: '/admin/users/{userId}/approve', status: 201, permission: 'audit:read', input: input(user, M.Empty, z.object({ accountType: z.enum(['CLUB_MEMBER', 'NON_CLUB']).optional(), role: z.enum(['ADMIN', 'USER']).optional() })), response: M.User }),
  'admin-reject': operation({ method: 'post', path: '/admin/users/{userId}/reject', status: 201, permission: 'audit:read', input: input(user, M.Empty, M.Confirmation), response: M.User }),
  'admin-ban': operation({ method: 'post', path: '/admin/users/{userId}/ban', status: 201, permission: 'audit:read', input: input(user, M.Empty, z.object({ reason: z.string().min(1).max(500), expiresAt: z.iso.datetime().optional() })), response: M.User }),
  'admin-unban': operation({ method: 'post', path: '/admin/users/{userId}/unban', status: 201, permission: 'audit:read', input: input(user, M.Empty, M.Empty), response: M.User }),
  'admin-quota': operation({ method: 'patch', path: '/admin/users/{userId}/quota', status: 200, permission: 'audit:read', input: input(user, M.Empty, M.QuotaInput), response: M.Quota }),
  'admin-quota-post': operation({ method: 'post', path: '/admin/users/{userId}/quota', status: 201, permission: 'audit:read', input: input(user, M.Empty, M.QuotaInput), response: M.Quota }),
  'snapshot': operation({ method: 'get', path: '/snapshot', status: 200, permission: 'audit:read', input: input(M.Empty, M.PageQuery.pick({ limit: true }), M.Empty), response: z.object({ users: z.array(M.User), quotas: z.array(M.JsonFields), auditLogs: z.array(M.JsonFields) }).catchall(z.json()) }),
  'usage-me': operation({ method: 'get', path: '/usage/me', status: 200, permission: 'metrics:read', input: noInput, response: z.object({ unlimited: z.boolean(), quota: M.JsonFields, usage: M.JsonFields, current: M.JsonFields, gauges: z.array(M.JsonFields), warnings: z.array(z.json()) }).catchall(z.json()) }),
} as const;

export type ApiOperationId = keyof typeof apiOperations;
export type ApiInput<K extends ApiOperationId> = K extends 'auth-github-callback'
  ? { readonly path: Record<string, never>; readonly query: z.input<typeof GitHubOAuthCallbackInput>; readonly body: Record<string, never> }
  : z.input<(typeof apiOperations)[K]['input']>;
export type ApiOutput<K extends ApiOperationId> = z.output<(typeof apiOperations)[K]['response']>;
export { ErrorBody, StreamError } from './api-models.ts';
export { z };

export function createOpenApiDocument() {
  const paths: Record<string, Record<string, object>> = {};
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(M)) registry.add(schema, { id: name });
  for (const [id, contract] of Object.entries(apiOperations)) {
    if (!registry.has(contract.response)) registry.add(contract.response, { id: `${id}Response` });
    if (!registry.has(contract.input.shape.body)) registry.add(contract.input.shape.body, { id: `${id}Body` });
  }
  const schemas = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}` }).schemas;
  // OpenAPI component references are document fragments, not JSON Schema base IDs.
  for (const schema of Object.values(schemas)) delete schema.$id;
  const reference = (schema: z.ZodType) => ({ $ref: `#/components/schemas/${registry.get(schema)?.id}` });
  for (const [operationId, contract] of Object.entries(apiOperations)) {
    const shape = contract.input.shape;
    const parameters: Array<{ name: string; in: string; required: boolean; schema: object | boolean }> = Object.entries(shape.path.shape).map(([name, schema]) => ({ name, in: 'path', required: true, schema: z.toJSONSchema(schema) }));
    const querySchema = z.toJSONSchema(operationId === 'auth-github-callback' ? GitHubOAuthCallbackParameters : shape.query);
    for (const [name, schema] of Object.entries(querySchema.properties ?? {})) parameters.push({ name, in: 'query', required: querySchema.required?.includes(name) ?? false, schema });
    const stream = 'stream' in contract ? contract.stream : undefined;
    const resumableServiceLogs = operationId === 'services-logs-stream';
    const resumableDeploymentActivity = operationId === 'deployments-stream';
    if (resumableServiceLogs || resumableDeploymentActivity) parameters.push({ name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string', maxLength: resumableDeploymentActivity ? 4096 : 2048 } });
    const resourceCreate = operationId === 'resources-create';
    const response = {
      description: resourceCreate ? 'Resource desired state created; this does not confirm runtime readiness or release support.' : 'Successful response',
      content: { [stream ? 'text/event-stream' : 'application/json']: { schema: reference(contract.response) } },
      ...(operationId === 'auth-password-reset-request' ? { headers: { 'Retry-After': { description: 'Seconds before another reset email may be requested.', schema: { type: 'integer', const: 60 } } } } : {}),
    };
    const responses: Record<string, object> = { [contract.status]: response, default: { description: 'Typed error response', content: { 'application/json': { schema: reference(contract.error) } } } };
    if (resourceCreate) responses['400'] = { description: 'Unsupported engine or managed backup/restore request rejected before desired-state persistence.', content: { 'application/json': { schema: reference(contract.error) } } };
    if (operationId.startsWith('resource-backups-') || operationId === 'backup-restores-create' || operationId === 'restores-get') {
      for (const status of ['400', '403', '404', '409']) {
        responses[status] = { description: 'Stable recovery error response', content: { 'application/json': { schema: reference(contract.error) } } };
      }
    }
    const body = z.toJSONSchema(shape.body);
    const requestBody = ['post', 'patch'].includes(contract.method) || (contract.method === 'delete' && (body.required?.length ?? 0) > 0)
      ? { required: (body.required?.length ?? 0) > 0, content: { 'application/json': { schema: reference(shape.body) } } }
      : undefined;
    const webhook = operationId === 'github-webhooks';
    paths[contract.path] ??= {};
    paths[contract.path][contract.method] = {
      operationId, parameters, requestBody, responses,
      ...(operationId === 'auth-github-callback' ? { 'x-query-schema': z.toJSONSchema(GitHubOAuthCallbackInput), description: 'Exactly one of code or error=access_denied is required. Both variants require the same single-use state, verifier and exact redirect binding.' } : {}),
      ...(resourceCreate ? { description: 'Creates desired state for canonical local engines only. Dedicated-local databases/cache and local SQLite are implemented; unsupported catalog engines remain disabled. No release readiness or managed backup/restore workflow is claimed.' } : {}),
      security: webhook ? [{ githubSignature: [] }] : contract.permission ? [{ bearerAuth: [] }] : [],
      'x-permission': contract.permission,
      ...(stream ? { 'x-sse': resumableServiceLogs || resumableDeploymentActivity
        ? { event: stream, resume: 'last-event-id-v1', reconnect: 'strictly-after-accepted-cursor', scope: resumableDeploymentActivity ? 'project-and-deployment' : 'project-and-service', maxResumeTokenLength: resumableDeploymentActivity ? 4096 : 2048, terminal: 'stream.end', error: reference(M.StreamError) }
        : { event: stream, resume: 'unsupported', reconnect: 'fresh-snapshot', error: reference(M.StreamError) } } : {}),
      ...(webhook ? { 'x-signature-headers': ['x-github-event', 'x-github-delivery', 'x-hub-signature-256'] } : {}),
    };
  }
  return { openapi: '3.1.0', 'x-resource-capability-source': 'test-fixtures/contracts/resource-capabilities-v1.json', info: { title: 'RAIBITSERVER API', version: '0.4.0', description: 'Implemented Nest control-plane operations. Prototype-only and planned operations are not advertised. Deployment activity and per-service runtime log streams resume from bounded, scope-bound Last-Event-ID tokens.' }, servers: [{ url: 'http://localhost:3000/api' }], paths, components: { schemas, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, githubSignature: { type: 'apiKey', in: 'header', name: 'x-hub-signature-256' } } } };
}

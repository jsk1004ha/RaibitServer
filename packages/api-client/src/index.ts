import type { ApiOutput, DeploymentListResponse, DeploymentOperationInput, DeploymentRequest, DeploymentSpec, PasswordRecoveryAccepted, PasswordRecoveryComplete, PasswordRecoveryCompleted, PasswordRecoveryRequest, ProjectDeletionScheduled, ProjectListResponse, ProjectSettingsUpdate, ProjectSettingsView, ProjectSpec, ResourceBackupCreate, ResourceBackupDelete, ResourceBackupList, ResourceBackupListView, ResourceBackupView, ResourceListResponse, ResourceRestoreCreate, ResourceRestoreView, ResourceSpec, ServiceListResponse, ServiceSpec } from '@raibitserver/schemas';
import { apiOperationError, createOperationsClient } from './operations.ts';
import { runtimeLogStreamUrl } from './runtime-log-stream.ts';
import type { ApiInput } from '@raibitserver/schemas';
export { apiOperationError, createOperationsClient, ApiOperationError, ApiPermissionError, ApiRetryableError, ApiTerminalError } from './operations.ts';
export {
  createRuntimeLogStreamRequest,
  runtimeLogStreamPath,
  runtimeLogStreamUrl,
  RuntimeLogStreamRequestSchema,
  RuntimeLogStreamCursorSchema,
  RUNTIME_LOG_STREAM_EVENT,
} from './runtime-log-stream.ts';
export type { RuntimeLogStreamRequest, RuntimeLogStreamResponse } from './runtime-log-stream.ts';

export type DeploymentMutationResult = ApiOutput<'deployments-create'>;
export type DeploymentOperationResult = ApiOutput<'deployments-retry'>;
export type DeploymentCancelResult = ApiOutput<'deployments-cancel'>;
export type DeploymentRollbackResult = ApiOutput<'deployments-rollback'>;
export type DeploymentPreviewCleanupResult = ApiOutput<'deployments-preview-cleanup'>;
export type DeploymentLogsResult = ApiOutput<'deployments-logs'>;
export type DeploymentEventsResult = ApiOutput<'deployments-events'>;
export type DeploymentActivityStreamResult = ApiOutput<'deployments-stream'>;
export type ResourceAttachmentResult = ApiOutput<'resources-attach'>;
export type ResourceProvisionResult = ApiOutput<'resources-provision'>;
export type ResourceBackupResult = ApiOutput<'resource-backups-create'>;
export type ResourceBackupHistory = ApiOutput<'resource-backups-list'>;
export type ResourceBackupDeletionResult = ApiOutput<'resource-backups-delete'>;
export type ResourceRestoreResult = ApiOutput<'backup-restores-create'>;

export type PageOptions = { limit?: number; cursor?: string; after?: string };

export class RAIBITSERVERClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly operations: ReturnType<typeof createOperationsClient>;

  constructor(options: { baseUrl: string; token?: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.operations = createOperationsClient(options);
  }

  requestPasswordReset(input: PasswordRecoveryRequest): Promise<PasswordRecoveryAccepted> { return this.operations['auth-password-reset-request']({ path: {}, query: {}, body: input }); }
  completePasswordReset(input: PasswordRecoveryComplete): Promise<PasswordRecoveryCompleted> { return this.operations['auth-password-reset-complete']({ path: {}, query: {}, body: input }); }

  withToken(token: string) {
    return new RAIBITSERVERClient({ baseUrl: this.baseUrl, token });
  }

  health(): Promise<Record<string, unknown>> { return this.request('/health'); }
  me(): Promise<Record<string, unknown>> { return this.request('/auth/me'); }
  signup(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/auth/signup', { method: 'POST', body: input }); }
  login(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/auth/login', { method: 'POST', body: input }); }
  verifyEmail(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/auth/email/verify', { method: 'POST', body: input }); }
  resendEmailVerification(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/auth/email/resend', { method: 'POST', body: input }); }
  logout(): Promise<Record<string, unknown>> { return this.request('/auth/logout', { method: 'POST' }); }
  githubLogin(input: ApiInput<'auth-github-login'>['query']) {
    return this.operations['auth-github-login']({ path: {}, query: input, body: {} });
  }
  githubCallback(input: ApiInput<'auth-github-callback'>['query']) {
    return this.operations['auth-github-callback']({ path: {}, query: input, body: {} });
  }

  listOrganizations(): Promise<Record<string, unknown>> { return this.request('/organizations'); }
  createOrganization(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/organizations', { method: 'POST', body: input }); }

  listProjects(organizationId?: string, options: PageOptions = {}): Promise<ProjectListResponse | ProjectSpec[]> {
    return this.request(withPageQuery(organizationId ? `/organizations/${encodeURIComponent(organizationId)}/projects` : '/projects', options));
  }

  createProject(project: Partial<ProjectSpec> & Record<string, unknown>, organizationId?: string): Promise<ProjectSpec> {
    const path = organizationId ? `/organizations/${encodeURIComponent(organizationId)}/projects` : '/projects';
    return this.request(path, { method: 'POST', body: project });
  }

  getProject(projectId: string): Promise<ProjectSpec> { return this.request(`/projects/${encodeURIComponent(projectId)}`); }
  updateProject(projectId: string, project: Partial<ProjectSpec> & Record<string, unknown>): Promise<ProjectSpec> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: project });
  }
  deleteProject(projectId: string): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  }

  getProjectSettings(projectId: string): Promise<ProjectSettingsView> {
    return this.operations['project-settings-get']({ path: { projectId }, query: {}, body: {} });
  }

  updateProjectSettings(projectId: string, input: ProjectSettingsUpdate): Promise<ProjectSettingsView> {
    return this.operations['project-settings-update']({ path: { projectId }, query: {}, body: input });
  }

  scheduleProjectDeletion(projectId: string, confirmed: true): Promise<ProjectDeletionScheduled> {
    return this.operations['project-settings-delete']({ path: { projectId }, query: {}, body: { confirmed } });
  }

  createService(projectId: string, service: Partial<ServiceSpec> & Record<string, unknown>): Promise<ServiceSpec> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/services`, { method: 'POST', body: service });
  }

  listServices(projectId: string, options: PageOptions = {}): Promise<ServiceListResponse> { return this.request(withPageQuery(`/projects/${encodeURIComponent(projectId)}/services`, options)); }
  getService(serviceId: string): Promise<ServiceSpec> { return this.request(`/services/${encodeURIComponent(serviceId)}`); }
  updateService(serviceId: string, service: Partial<ServiceSpec> & Record<string, unknown>): Promise<ServiceSpec> {
    return this.request(`/services/${encodeURIComponent(serviceId)}`, { method: 'PATCH', body: service });
  }
  deleteService(serviceId: string): Promise<Record<string, unknown>> {
    return this.request(`/services/${encodeURIComponent(serviceId)}`, { method: 'DELETE' });
  }

  createResource(projectId: string, resource: Partial<ResourceSpec> & Record<string, unknown>): Promise<ResourceSpec> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/resources`, { method: 'POST', body: resource });
  }

  listResources(projectId: string, options: PageOptions = {}): Promise<ResourceListResponse> { return this.request(withPageQuery(`/projects/${encodeURIComponent(projectId)}/resources`, options)); }
  getResource(resourceId: string): Promise<ResourceSpec> { return this.request(`/resources/${encodeURIComponent(resourceId)}`); }
  updateResource(resourceId: string, input: Partial<ResourceSpec> & Record<string, unknown>): Promise<ResourceSpec> { return this.request(`/resources/${encodeURIComponent(resourceId)}`, { method: 'PATCH', body: input }); }
  deleteResource(resourceId: string): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}`, { method: 'DELETE' }); }
  attachResource(resourceId: string, input: { readonly serviceId: string; readonly envPrefix?: string }): Promise<ResourceAttachmentResult> { return this.operations['resources-attach']({ path: { resourceId }, query: {}, body: input }); }
  provisionResource(resourceId: string, input: { readonly intent: 'preview-plan' | 'live-provision' }): Promise<ResourceProvisionResult> { return this.operations['resources-provision']({ path: { resourceId }, query: {}, body: input }); }
  createBackup(resourceId: string, input: ResourceBackupCreate): Promise<ResourceBackupView> { return this.operations['resource-backups-create']({ path: { resourceId }, query: {}, body: input }); }
  listBackups(resourceId: string, options: ResourceBackupList = {}): Promise<ResourceBackupListView> { return this.operations['resource-backups-list']({ path: { resourceId }, query: options, body: {} }); }
  deleteBackup(backupId: string, input: ResourceBackupDelete): Promise<ResourceBackupView> { return this.operations['resource-backups-delete']({ path: { backupId }, query: {}, body: input }); }
  createRestore(backupId: string, input: ResourceRestoreCreate): Promise<ResourceRestoreView> { return this.operations['backup-restores-create']({ path: { backupId }, query: {}, body: input }); }
  getRestore(restoreId: string): Promise<ResourceRestoreView> { return this.operations['restores-get']({ path: { restoreId }, query: {}, body: {} }); }

  retryDeployment(deploymentId: string, body: DeploymentOperationInput) { return this.operations['deployments-retry']({ path: { deploymentId }, query: {}, body }); }
  redeployService(serviceId: string, body: DeploymentOperationInput) { return this.operations['services-redeploy']({ path: { serviceId }, query: {}, body }); }

  createDeployment(projectId: string, serviceId: string, request?: DeploymentRequest): Promise<DeploymentMutationResult>;
  createDeployment(serviceId: string, request?: DeploymentRequest): Promise<DeploymentMutationResult>;
  createDeployment(projectIdOrServiceId: string, serviceIdOrRequest: string | DeploymentRequest = {}, request: DeploymentRequest = {}): Promise<DeploymentMutationResult> {
    if (typeof serviceIdOrRequest === 'string') {
      return this.request(`/projects/${encodeURIComponent(projectIdOrServiceId)}/services/${encodeURIComponent(serviceIdOrRequest)}/deployments`, { method: 'POST', body: request });
    }
    return this.request(`/services/${encodeURIComponent(projectIdOrServiceId)}/deployments`, { method: 'POST', body: serviceIdOrRequest });
  }

  listDeployments(projectId: string, serviceId: string, options?: PageOptions): Promise<DeploymentListResponse>;
  listDeployments(serviceId: string, options?: PageOptions): Promise<DeploymentListResponse>;
  listDeployments(projectIdOrServiceId: string, serviceIdOrOptions?: string | PageOptions, options: PageOptions = {}): Promise<DeploymentListResponse> {
    const serviceId = typeof serviceIdOrOptions === 'string' ? serviceIdOrOptions : undefined;
    const page = typeof serviceIdOrOptions === 'string' ? options : (serviceIdOrOptions || {});
    const path = serviceId
      ? `/projects/${encodeURIComponent(projectIdOrServiceId)}/services/${encodeURIComponent(serviceId)}/deployments`
      : `/services/${encodeURIComponent(projectIdOrServiceId)}/deployments`;
    return this.request(withPageQuery(path, page));
  }

  listDeploymentLogs(deploymentId: string, options: PageOptions = {}): Promise<DeploymentLogsResult> { return this.operations['deployments-logs']({ path: { deploymentId }, query: options, body: {} }); }
  listDeploymentEvents(deploymentId: string, options: PageOptions = {}): Promise<DeploymentEventsResult> { return this.operations['deployments-events']({ path: { deploymentId }, query: options, body: {} }); }
  deploymentActivityStream(deploymentId: string, options: { readonly lastEventId?: string; readonly signal?: AbortSignal } = {}): Promise<DeploymentActivityStreamResult> {
    return this.operations['deployments-stream']({ path: { deploymentId }, query: {}, body: {} }, options);
  }
  listRuntimeLogs(serviceId: string, options: PageOptions = {}): Promise<Record<string, unknown>> { return this.request(withPageQuery(`/services/${encodeURIComponent(serviceId)}/logs`, options)); }
  runtimeLogStreamUrl(serviceId: string): string {
    return runtimeLogStreamUrl(this.baseUrl, { serviceId });
  }
  getDeployment(deploymentId: string): Promise<DeploymentSpec> { return this.request(`/deployments/${encodeURIComponent(deploymentId)}`); }
  updateDeploymentStatus(deploymentId: string, input: Record<string, unknown>): Promise<DeploymentSpec> {
    return this.request(`/deployments/${encodeURIComponent(deploymentId)}/status`, { method: 'PATCH', body: input });
  }
  cancelDeployment(deploymentId: string): Promise<DeploymentCancelResult> {
    return this.operations['deployments-cancel']({ path: { deploymentId }, query: {}, body: {} });
  }
  rollbackDeployment(deploymentId: string, input: { readonly confirmed: true; readonly previousDeploymentId?: string; readonly imageUrl?: string }): Promise<DeploymentRollbackResult> {
    return this.operations['deployments-rollback']({ path: { deploymentId }, query: {}, body: input });
  }
  cleanupPreview(deploymentId: string, input: { readonly confirmed: true }): Promise<DeploymentPreviewCleanupResult> {
    return this.operations['deployments-preview-cleanup']({ path: { deploymentId }, query: {}, body: input });
  }

  uploadEnvFile(projectId: string, serviceId: string, filename: string, content: string): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env-file`, { method: 'POST', body: { filename, content } });
  }

  listEnvironment(projectId: string, serviceId: string): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env`);
  }

  upsertEnvironment(projectId: string, serviceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env`, { method: 'POST', body: input });
  }

  connectGitHub(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/integrations/github', { method: 'POST', body: input }); }
  listGitHub(organizationId?: string): Promise<Record<string, unknown>> { return this.request(organizationId ? `/integrations/github?organizationId=${encodeURIComponent(organizationId)}` : '/integrations/github'); }
  listGitHubInstallations(organizationId?: string): Promise<Record<string, unknown>> { return this.request(organizationId ? `/github/installations?organizationId=${encodeURIComponent(organizationId)}` : '/github/installations'); }
  beginGitHubAppInstallation(): Promise<Record<string, unknown>> { return this.request('/github/install'); }
  beginGitHubAppAuthorization(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])).toString();
    return this.request(`/github/authorize${query ? `?${query}` : ''}`);
  }
  completeGitHubAppInstallation(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])).toString();
    return this.request(`/github/callback${query ? `?${query}` : ''}`);
  }
  listGitHubInstallationRepositories(installationId: string): Promise<Record<string, unknown>> { return this.request(`/github/installations/${encodeURIComponent(installationId)}/repositories`); }
  attachGitHub(projectId: string, serviceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/github`, { method: 'POST', body: input });
  }
  importGitHubRepository(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('/github/repositories/import', { method: 'POST', body: input }); }
  syncGitHubRepository(repositoryId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.request(`/github/repositories/${encodeURIComponent(repositoryId)}/sync`, { method: 'POST', body: input }); }
  queryResource(resourceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/query`, { method: 'POST', body: input }); }
  commandResource(resourceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/command`, { method: 'POST', body: input }); }
  browseResource(resourceId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/browse`, { method: 'POST', body: input }); }
  resourceSchema(resourceId: string): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/schema`); }
  resourceTables(resourceId: string): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/tables`); }
  resourceCollections(resourceId: string): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/collections`); }
  resourceKeys(resourceId: string): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/console/keys`); }
  usageMe(): Promise<Record<string, unknown>> { return this.request('/usage/me'); }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method || 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw apiOperationError(response.status, body);
    return body as T;
  }
}

function withPageQuery(path: string, options: PageOptions) {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.cursor) query.set('cursor', options.cursor);
  else if (options.after) query.set('after', options.after);
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

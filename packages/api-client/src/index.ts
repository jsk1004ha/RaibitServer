import type { DeploymentListResponse, DeploymentRequest, DeploymentSpec, ProjectListResponse, ProjectSpec, ResourceListResponse, ResourceSpec, ServiceListResponse, ServiceSpec } from '@raibitserver/schemas';
import { createOperationsClient } from './operations.ts';
import type { ApiInput } from '@raibitserver/schemas';
export { createOperationsClient, ApiOperationError } from './operations.ts';

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
  attachResource(resourceId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/attach`, { method: 'POST', body: input }); }
  provisionResource(resourceId: string, input: { intent: 'preview-plan' | 'live-provision' }): Promise<Record<string, unknown>> { return this.request(`/resources/${encodeURIComponent(resourceId)}/provision`, { method: 'POST', body: input }); }

  createDeployment(projectId: string, serviceId: string, request?: DeploymentRequest): Promise<DeploymentSpec>;
  createDeployment(serviceId: string, request?: DeploymentRequest): Promise<DeploymentSpec>;
  createDeployment(projectIdOrServiceId: string, serviceIdOrRequest: string | DeploymentRequest = {}, request: DeploymentRequest = {}): Promise<DeploymentSpec> {
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

  listDeploymentLogs(deploymentId: string, options: PageOptions = {}): Promise<Record<string, unknown>> { return this.request(withPageQuery(`/deployments/${encodeURIComponent(deploymentId)}/logs`, options)); }
  listDeploymentEvents(deploymentId: string, options: PageOptions = {}): Promise<Record<string, unknown>> { return this.request(withPageQuery(`/deployments/${encodeURIComponent(deploymentId)}/events`, options)); }
  listRuntimeLogs(serviceId: string, options: PageOptions = {}): Promise<Record<string, unknown>> { return this.request(withPageQuery(`/services/${encodeURIComponent(serviceId)}/logs`, options)); }
  getDeployment(deploymentId: string): Promise<DeploymentSpec> { return this.request(`/deployments/${encodeURIComponent(deploymentId)}`); }
  updateDeploymentStatus(deploymentId: string, input: Record<string, unknown>): Promise<DeploymentSpec> {
    return this.request(`/deployments/${encodeURIComponent(deploymentId)}/status`, { method: 'PATCH', body: input });
  }
  cancelDeployment(deploymentId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request(`/deployments/${encodeURIComponent(deploymentId)}/cancel`, { method: 'POST', body: input });
  }
  rollbackDeployment(deploymentId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request(`/deployments/${encodeURIComponent(deploymentId)}/rollback`, { method: 'POST', body: input });
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
    if (!response.ok) throw new Error(`RAIBITSERVER API ${response.status}: ${body?.error || text}`);
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

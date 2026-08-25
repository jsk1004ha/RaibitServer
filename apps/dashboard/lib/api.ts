import { cookies } from 'next/headers';
import { fetchWithInitialResponseTimeout, readBoundedBody, SESSION_COOKIE_NAME } from './request-security.js';

const CONTROL_PLANE_CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_PLANE_BODY_TIMEOUT_MS = 15_000;
const CONTROL_PLANE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type DashboardApiContext = {
  baseUrl: string;
  token?: string;
  headers: Record<string, string>;
};

export type DashboardApiResult<T = any> = {
  ok: boolean;
  status: number;
  body: T;
  error?: string;
  errorCode?: string;
};

export type DashboardLoadIssue = {
  label: string;
  message: string;
  status: number;
};

export async function dashboardApiContext(): Promise<DashboardApiContext> {
  const baseUrl = (process.env.RAIBITSERVER_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');
  const sessionToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const token = sessionToken;
  return { baseUrl, token, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

// Browser navigation and mutations stay on the dashboard origin. The Route Handler
// reads the HttpOnly session and attaches the Authorization header server-side.
export function apiAction(path: string, _context?: DashboardApiContext) {
  return `/api/control${path.startsWith('/') ? path : `/${path}`}`;
}

export async function getJson(path: string, fallback: any = null, context?: DashboardApiContext): Promise<DashboardApiResult> {
  return requestJson(path, { fallback, context: context || await dashboardApiContext() });
}

export async function postJson(path: string, body: any = {}, fallback: any = null, context?: DashboardApiContext): Promise<DashboardApiResult> {
  return requestJson(path, { method: 'POST', body, fallback, context: context || await dashboardApiContext() });
}

async function requestJson(path: string, { method = 'GET', body = undefined, fallback = null, context }: { method?: string; body?: any; fallback?: any; context: DashboardApiContext }): Promise<DashboardApiResult> {
  try {
    const response = await fetchWithInitialResponseTimeout(
      fetch,
      `${context.baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
      {
        method,
        headers: method === 'POST' ? { ...context.headers, 'content-type': 'application/json' } : context.headers,
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
        cache: 'no-store',
      },
      CONTROL_PLANE_CONNECT_TIMEOUT_MS,
    );
    const responseBytes = await readBoundedBody(response.body, {
      maxBytes: CONTROL_PLANE_MAX_RESPONSE_BYTES,
      timeoutMs: CONTROL_PLANE_BODY_TIMEOUT_MS,
      declaredLength: response.headers.get('content-length'),
      tooLargeCode: 'control_plane_response_too_large',
      timeoutCode: 'control_plane_response_timeout',
    });
    const text = new TextDecoder().decode(responseBytes);
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, status: 502, error: publicFailureMessage(502), errorCode: 'invalid_control_plane_response', body: fallback };
      }
    }
    if (!response.ok) {
      const errorCode = safeErrorCode(payload?.error || payload?.message, response.status);
      return { ok: false, status: response.status, error: publicFailureMessage(response.status), errorCode, body: fallback };
    }
    return { ok: true, status: response.status, body: payload };
  } catch (error) {
    return { ok: false, status: 0, error: publicFailureMessage(0), errorCode: controlPlaneBoundaryCode(error), body: fallback };
  }
}

function controlPlaneBoundaryCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return ['control_plane_timeout', 'control_plane_response_too_large', 'control_plane_response_timeout'].includes(code)
    ? code
    : 'control_plane_unavailable';
}

function safeErrorCode(value: unknown, status: number) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    ? value
    : `request_failed_${status}`;
}

function publicFailureMessage(status: number) {
  if (status === 0 || status >= 500) return '제어 영역에 연결할 수 없습니다.';
  if (status === 401) return '로그인이 필요하거나 세션이 만료되었습니다.';
  if (status === 403) return '이 정보를 볼 권한이 없습니다.';
  if (status === 404) return '요청한 정보를 찾을 수 없습니다.';
  if (status === 409) return '현재 상태와 충돌하여 정보를 불러오지 못했습니다.';
  if (status === 429) return '요청이 많아 잠시 후 다시 시도해야 합니다.';
  return '요청을 처리하지 못했습니다.';
}

export function collectLoadIssues(entries: Array<[string, DashboardApiResult]>): DashboardLoadIssue[] {
  return entries
    .filter(([, result]) => !result.ok)
    .map(([label, result]) => ({ label, message: result.error || publicFailureMessage(result.status), status: result.status }));
}

export async function loadDashboardOverview(context?: DashboardApiContext) {
  const resolved = context || await dashboardApiContext();
  const [health, me, projects, usage, github, installations] = await Promise.all([
    getJson('/health', { status: 'offline' }, resolved),
    resolved.token ? getJson('/auth/me', { user: null, subject: null }, resolved) : Promise.resolve({ ok: true, status: 200, body: { user: null, subject: null } }),
    resolved.token ? getJson('/projects', { projects: [] }, resolved) : Promise.resolve({ ok: true, status: 200, body: { projects: [] } }),
    resolved.token ? getJson('/usage/me', { usage: [], quota: null }, resolved) : Promise.resolve({ ok: true, status: 200, body: { usage: [], quota: null } }),
    resolved.token ? getJson('/integrations/github', { integrations: [] }, resolved) : Promise.resolve({ ok: true, status: 200, body: { integrations: [] } }),
    resolved.token ? getJson('/github/installations', { installations: [] }, resolved) : Promise.resolve({ ok: true, status: 200, body: { installations: [] } }),
  ]);
  return {
    context: resolved,
    health,
    me,
    projects: projects.body?.projects || [],
    usage: usage.body,
    github: github.body,
    installations: installations.body?.installations || [],
    loadErrors: collectLoadIssues([
      ['제어 영역 상태', health],
      ['현재 사용자', me],
      ['프로젝트', projects],
      ['사용량', usage],
      ['GitHub 연동', github],
      ['GitHub 설치', installations],
    ]),
  };
}

export async function loadProjectConsole(projectId: string, context?: DashboardApiContext) {
  const resolved = context || await dashboardApiContext();
  const overview = await getJson(`/projects/${encodeURIComponent(projectId)}/overview`, { project: null, services: [], resources: [], deployments: [] }, resolved);
  const project = overview.body?.project || { id: projectId, name: projectId, slug: projectId };
  const services = overview.body?.services || [];
  const resources = overview.body?.resources || [];
  const serviceNames = new Map(services.map((service: any) => [String(service.id), service.name || service.slug]));
  const deployments = (overview.body?.deployments || []).map((deployment: any) => ({ ...deployment, serviceName: serviceNames.get(String(deployment.serviceId)) }));
  return {
    context: resolved,
    project,
    services,
    resources,
    deployments,
    previewDeployments: deployments.filter((deployment: any) => String(deployment.deploymentType || '').toLowerCase() === 'preview'),
    // Detailed operational data is loaded only by its focused screen.
    loadErrors: collectLoadIssues([['프로젝트 개요', overview]]),
  };
}

export async function loadResourceConsole(resourceId: string, view = 'overview', context?: DashboardApiContext) {
  const resolved = context || await dashboardApiContext();
  const needsOverviewData = view === 'overview' || view === 'schema';
  const needsStructureData = view === 'schema';
  const fallback = <T,>(body: T): DashboardApiResult<T> => ({ ok: true, status: 200, body });
  const [resource, schema, tables, collections, keys, browse] = await Promise.all([
    getJson(`/resources/${encodeURIComponent(resourceId)}`, { id: resourceId }, resolved),
    needsOverviewData ? getJson(`/resources/${encodeURIComponent(resourceId)}/console/schema`, { schema: {} }, resolved) : fallback({ schema: {} }),
    needsStructureData ? getJson(`/resources/${encodeURIComponent(resourceId)}/console/tables`, { tables: [] }, resolved) : fallback({ tables: [] }),
    needsStructureData ? getJson(`/resources/${encodeURIComponent(resourceId)}/console/collections`, { collections: [] }, resolved) : fallback({ collections: [] }),
    needsStructureData ? getJson(`/resources/${encodeURIComponent(resourceId)}/console/keys`, { keys: [] }, resolved) : fallback({ keys: [] }),
    needsStructureData ? postJson(`/resources/${encodeURIComponent(resourceId)}/console/browse`, {}, {}, resolved) : fallback({}),
  ]);
  return {
    context: resolved,
    resource: resource.body,
    schema: schema.body,
    tables: tables.body,
    collections: collections.body,
    keys: keys.body,
    browse: browse.body,
    loadErrors: collectLoadIssues([
      ['리소스 정보', resource],
      ['스키마', schema],
      ['테이블', tables],
      ['컬렉션', collections],
      ['키', keys],
      ['데이터 탐색', browse],
    ]),
  };
}

export async function loadAdminConsole(context?: DashboardApiContext) {
  const resolved = context || await dashboardApiContext();
  const [snapshot, usage] = await Promise.all([
    getJson('/snapshot', { users: [], quotas: [], auditLogs: [] }, resolved),
    getJson('/usage/me', { usage: [], quota: null }, resolved),
  ]);
  const users = snapshot.body?.users || [];
  return {
    context: resolved,
    authorized: snapshot.ok,
    users,
    pendingUsers: users.filter((user: any) => String(user.approvalStatus || '').toUpperCase() === 'PENDING'),
    quotas: snapshot.body?.quotas || [],
    auditLogs: snapshot.body?.auditLogs || [],
    usage: usage.body,
    loadErrors: collectLoadIssues([['관리자 현황', snapshot], ['사용량', usage]]),
  };
}

export async function loadGitHubConsole(context?: DashboardApiContext) {
  const resolved = context || await dashboardApiContext();
  const [integrations, installations, projects] = await Promise.all([
    getJson('/integrations/github', { integrations: [] }, resolved),
    getJson('/github/installations', { installations: [] }, resolved),
    getJson('/projects', { projects: [] }, resolved),
  ]);
  const projectRows = projects.body?.projects || [];
  const installationRows = installations.body?.installations || [];
  const [repositoryLoads, serviceLoads] = await Promise.all([
    Promise.all(installationRows.map(async (installation: any) => {
      const result = await getJson(`/github/installations/${encodeURIComponent(installation.installationId || installation.id)}/repositories`, { repositories: [] }, resolved);
      return { installationId: installation.installationId || installation.id, result };
    })),
    Promise.all(projectRows.map(async (project: any) => {
      const result = await getJson(`/projects/${encodeURIComponent(project.id)}/services`, { services: [] }, resolved);
      return { projectId: project.id, projectName: project.name || project.slug, result };
    })),
  ]);
  const repositoriesByInstallation = repositoryLoads.map((row) => ({ installationId: row.installationId, repositories: row.result.body?.repositories || [] }));
  const servicesByProject = serviceLoads.map((row) => ({ projectId: row.projectId, projectName: row.projectName, services: row.result.body?.services || [] }));
  return {
    context: resolved,
    integrations: integrations.body?.integrations || [],
    installations: installationRows,
    repositoriesByInstallation,
    repositories: repositoriesByInstallation.flatMap((row) => row.repositories.map((repository: any) => ({ ...repository, installationId: row.installationId }))),
    projects: projectRows,
    services: servicesByProject.flatMap((row) => row.services.map((service: any) => ({ ...service, projectId: row.projectId, projectName: row.projectName }))),
    loadErrors: [
      ...collectLoadIssues([['GitHub 연동', integrations], ['GitHub 설치', installations], ['프로젝트', projects]]),
      ...collectLoadIssues(repositoryLoads.map((row) => ['설치 저장소', row.result] as [string, DashboardApiResult])),
      ...collectLoadIssues(serviceLoads.map((row) => ['프로젝트 서비스', row.result] as [string, DashboardApiResult])),
    ],
  };
}

export async function loadPublicSites(limit = 5) {
  const result = await getJson(`/public/sites?limit=${Math.max(0, Math.min(limit, 5))}`, { sites: [] });
  return result.body?.sites || [];
}

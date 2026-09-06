import { ConsoleShell } from '../../../../../components/console-ui';
import { ProjectHub } from '../../../../../components/project-hub/project-hub';
import { projectView, queryText } from '../../../../../components/project-hub/model';
import type { EnvironmentEntry, RuntimeLog, ServiceRecord } from '../../../../../components/project-hub/types';
import { collectLoadIssues, getJson, loadProjectConsole, postJson } from '../../../../../lib/api';
import { projectMainLink } from '../../../../../lib/project-main-link';

type ProjectPageProps = Readonly<{
  params: Promise<{ orgSlug: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export default async function ProjectDetailPage({ params, searchParams }: ProjectPageProps) {
  const [{ orgSlug, projectId }, query] = await Promise.all([params, searchParams]);
  const view = projectView(queryText(query.view) || 'overview');
  const state = await loadProjectConsole(projectId);
  const resourceOptions = view === 'new-resource'
    ? await getJson(`/projects/${encodeURIComponent(projectId)}/resources`, { resourceOptions: [] }, state.context)
    : null;
  const projectSettings = view === 'settings'
    ? await getJson(`/projects/${encodeURIComponent(projectId)}/settings`, null, state.context)
    : null;
  const selectedServiceId = queryText(query.serviceId);
  const selectedService = state.services.find((service: ServiceRecord) => service.id === selectedServiceId) || state.services[0] || null;
  const serviceSettings = selectedService ? { ...selectedService.desiredState, ...selectedService.desiredSpec, ...selectedService } : null;
  const environmentService = selectedService || state.services[0] || null;
  const environment = view === 'environment' && environmentService
    ? await getJson(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(environmentService.id)}/env`, { entries: [] }, state.context)
    : null;
  const environmentEntries: readonly EnvironmentEntry[] = environment?.body?.entries || [];
  const editedEnvironmentKey = queryText(query.envKey);
  const editedEnvironment = environmentEntries.find((entry) => entry.key === editedEnvironmentKey) || null;
  const agentPlanResult = view === 'agent'
    ? await postJson(`/projects/${encodeURIComponent(projectId)}/deployment-agent/plan`, {}, {
      version: 'v1', generatedBy: 'deterministic', summary: '배포 계획을 불러오지 못했습니다.', blocked: true, canApply: false, deploymentOrder: [], services: [], security: { highestSeverity: 'none', critical: 0, high: 0, medium: 0, low: 0 },
    }, state.context)
    : null;
  const logService = selectedService;
  const runtimeLogsResult = view === 'logs' && logService
    ? await getJson(`/services/${encodeURIComponent(logService.id)}/logs`, { logs: [] }, state.context)
    : null;
  const runtimeLogs: readonly RuntimeLog[] = runtimeLogsResult?.body?.logs || [];
  const loadErrors = [
    ...state.loadErrors,
    ...(resourceOptions ? collectLoadIssues([['리소스 지원 상태', resourceOptions]]) : []),
    ...(runtimeLogsResult ? collectLoadIssues([['런타임 로그', runtimeLogsResult]]) : []),
    ...(environment ? collectLoadIssues([['환경 변수', environment]]) : []),
    ...(agentPlanResult ? collectLoadIssues([['AI 배포 계획', agentPlanResult]]) : []),
  ];
  const projectName = state.project.name || state.project.slug || projectId;
  const organizationLabel = state.project.organization?.name || state.project.organizationSlug || '내 조직';
  const mainLink = projectMainLink({
    organizationSlug: state.project.organizationSlug || state.project.organization?.slug,
    project: state.project,
    services: state.services,
    baseDomain: process.env.RAIBITSERVER_BASE_DOMAIN || process.env.BASE_DOMAIN,
  });
  const base = `/org/${orgSlug}/projects/${projectId}`;
  const data = {
    agentPlan: agentPlanResult?.body || null,
    base,
    deletionPending: ['DELETE_REQUESTED', 'DELETING'].includes(String(state.project.status || '').toUpperCase()),
    deployments: state.deployments,
    editedEnvironment,
    environmentEntries,
    environmentService,
    loadErrors,
    logService,
    mainLink,
    project: state.project,
    projectId,
    projectSettings: projectSettings?.ok ? projectSettings.body : null,
    projectSettingsIssue: projectSettings && !projectSettings.ok
      ? { label: '프로젝트 설정', message: projectSettings.error || '프로젝트 설정을 불러오지 못했습니다.', status: projectSettings.status }
      : null,
    projectName,
    previewDeployments: state.previewDeployments,
    resources: state.resources,
    resourceOptions: resourceOptions?.body?.resourceOptions || [],
    runtimeLogs,
    selectedService,
    serviceSettings,
    services: state.services,
    view,
  };

  return (
    <ConsoleShell active="projects" orgRouteValue={orgSlug} orgValue={organizationLabel} projectId={projectId} projectValue={projectName}>
      <ProjectHub data={data} orgSlug={orgSlug} />
    </ConsoleShell>
  );
}

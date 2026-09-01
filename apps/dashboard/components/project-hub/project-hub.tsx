import { PageHeader } from '@/components/page-header';
import { SectionNavigation } from '@/components/section-navigation';
import { ActionLink } from '@/components/ui/button';
import { EnvironmentView } from './environment';
import { projectNavigation } from './model';
import { AgentView, DeploymentsView, LogsView, ResourcesView } from './operations';
import { OverviewView } from './overview';
import { ServicesView } from './services';
import { SettingsView } from './settings';
import { LoadIssues, ProjectStatusBadge } from './shared';
import type { ProjectHubData } from './types';

export function ProjectHub({ data, orgSlug }: Readonly<{ data: ProjectHubData; orgSlug: string }>) {
  const current = data.view === 'edit-service' || data.view === 'new-service' ? 'services' : data.view === 'new-resource' ? 'resources' : data.view;
  return (
    <section className="mx-auto box-border flex w-full min-w-0 max-w-full flex-col gap-raibit-xl overflow-x-hidden px-raibit-lg py-raibit-xl md:max-w-7xl md:px-raibit-xl md:py-raibit-xxl" data-od-id="project-overview">
      <PageHeader eyebrow="프로젝트 운영" title={data.projectName} description="서비스 · 배포 · 리소스" actions={<div className="flex max-w-full min-w-0 flex-wrap items-center gap-raibit-sm"><ProjectStatusBadge status={data.project.status || 'healthy'} />{data.mainLink ? <ActionLink className="min-w-0 whitespace-normal break-all" aria-label={`${data.projectName} 메인 사이트 새 창에서 열기`} href={data.mainLink.href} rel="noreferrer" target="_blank" title={data.mainLink.href}>{data.mainLink.label} ↗</ActionLink> : null}</div>} />
      <LoadIssues issues={data.loadErrors} />
      <div
        aria-label="프로젝트 화면 탐색 스크롤"
        className="block w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 [&>nav]:relative [&>nav]:w-max [&>nav]:min-w-full [&>nav>div]:w-max [&>nav>div]:min-w-full [&>nav>div]:overflow-visible"
        data-project-nav-viewport
        role="region"
        tabIndex={0}
      >
        <SectionNavigation current={current} items={projectNavigation(data.base)} label="프로젝트 콘솔 화면" />
      </div>
      <div className="w-full min-w-0 max-w-full">
        {data.view === 'overview' ? <OverviewView data={data} /> : null}
        {['services', 'new-service', 'edit-service'].includes(data.view) ? <ServicesView data={data} /> : null}
        {data.view === 'deployments' ? <DeploymentsView data={data} /> : null}
        {data.view === 'agent' ? <AgentView data={data} /> : null}
        {['resources', 'new-resource'].includes(data.view) ? <ResourcesView data={data} /> : null}
        {data.view === 'environment' ? <EnvironmentView data={data} /> : null}
        {data.view === 'logs' ? <LogsView data={data} /> : null}
        {data.view === 'settings' ? <SettingsView data={data} orgSlug={orgSlug} /> : null}
      </div>
    </section>
  );
}

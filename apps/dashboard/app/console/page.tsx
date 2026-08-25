import { redirect } from 'next/navigation';
import { loadDashboardOverview } from '../../lib/api';
import { ConsoleShell, StatusBadge } from '../../components/console-ui';
import { ProjectCard } from '../../components/project-card';

export default async function ConsoleOverviewPage() {
  const state = await loadDashboardOverview();
  if (!state.me.ok) redirect('/login?error=session_expired&next=/console');
  const subject = state.me.body?.subject;
  const projects = state.projects || [];
  const createOrgSlug = projects[0]?.organizationSlug || projects[0]?.organizationId || subject?.organizationSlug || subject?.organizationId || 'default';
  const health = state.health.body?.status === 'ok';
  return (
    <ConsoleShell active="overview" orgValue={createOrgSlug} orgRouteValue={createOrgSlug}>
      <section className="page console-focus" data-od-id="org-dashboard">
        <header className="page-header">
          <div>
            <h1 className="page-title">내 프로젝트</h1>
            <p className="page-subtitle">프로젝트 선택 · 만들기</p>
          </div>
          <div className="page-header-actions"><StatusBadge status={health ? 'healthy' : 'offline'} /><a className="btn btn-primary" href={`/org/${createOrgSlug}/projects/new`}>새 프로젝트</a></div>
        </header>
        <section className="console-surface project-focus-card">
          <div className="card-title"><h2>프로젝트</h2><span className="badge info">{projects.length}개</span></div>
          <div className="stack">
            {projects.length ? projects.map((project: any) => (
              <ProjectCard key={project.id} project={{ ...project, services: project.serviceCount, resources: project.resourceCount }} href={`/org/${project.organizationSlug || project.organizationId || 'org'}/projects/${project.id}`} />
            )) : <div className="empty-state"><strong>아직 프로젝트가 없습니다.</strong><p>첫 프로젝트를 만들고 서비스를 배포해 보세요.</p><a className="btn btn-primary" href={`/org/${createOrgSlug}/projects/new`}>첫 프로젝트 만들기</a></div>}
          </div>
        </section>
      </section>
    </ConsoleShell>
  );
}

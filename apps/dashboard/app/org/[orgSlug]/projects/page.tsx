import { loadDashboardOverview } from '../../../../lib/api';
import { ConsoleShell, LoadErrorSummary } from '../../../../components/console-ui';
import { ProjectCard } from '../../../../components/project-card';

export default async function ProjectsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const state = await loadDashboardOverview();
  const projects = (state.projects || []).filter((project: any) => orgSlug === 'all'
    || String(project.organizationSlug || '') === orgSlug
    || String(project.organizationId || '') === orgSlug);
  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug}>
      <section className="page">
        <header className="page-header">
          <div><h1 className="page-title">프로젝트</h1><p className="page-subtitle">프로젝트 · 운영 상태</p></div>
          <div className="page-header-actions"><span className="badge ok">{projects.length}개</span><a className="btn btn-primary" href={`/org/${orgSlug}/projects/new`}>프로젝트 만들기</a></div>
        </header>
        <LoadErrorSummary issues={state.loadErrors} />
        <section className="console-surface">
          <div className="card-title"><h2>프로젝트 목록</h2><span className="badge info">{projects.length}개</span></div>
          <div className="stack">
            {projects.length ? projects.map((project: any) => <ProjectCard key={project.id} project={project} href={`/org/${orgSlug}/projects/${project.id}`} />) : <div><p className="muted">이 워크스페이스에는 아직 프로젝트가 없습니다.</p><a className="btn btn-primary" href={`/org/${orgSlug}/projects/new`}>첫 프로젝트 만들기</a></div>}
          </div>
        </section>
      </section>
    </ConsoleShell>
  );
}

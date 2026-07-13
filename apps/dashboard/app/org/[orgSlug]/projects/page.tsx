import { loadDashboardOverview } from '../../../../lib/api';
import { ConsoleShell } from '../../../../components/console-ui';
import { ProjectCard } from '../../../../components/project-card';

export default async function ProjectsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const state = await loadDashboardOverview();
  const projects = (state.projects || []).filter((project: any) => [project.organizationSlug, project.organizationId, 'default'].includes(orgSlug) || orgSlug === 'all');
  return (
    <ConsoleShell active="projects" orgValue={orgSlug} crumbs={`${orgSlug} / 프로젝트`} actions={<a className="btn btn-primary" href={`/org/${orgSlug}/projects/new`}>프로젝트 만들기</a>}>
      <section className="page">
        <header className="page-header">
          <div><p className="eyebrow">{orgSlug} · 워크스페이스</p><h1 className="page-title">프로젝트</h1><p className="page-subtitle">워크스페이스의 프로젝트와 서비스 운영 상태를 확인하세요.</p></div>
          <span className="badge ok">{projects.length}개</span>
        </header>
        <section className="card">
          <div className="card-title"><h2>프로젝트 목록</h2><span className="badge info">{projects.length}개</span></div>
          <div className="stack">
            {projects.length ? projects.map((project: any) => <ProjectCard key={project.id} project={project} href={`/org/${orgSlug}/projects/${project.id}`} />) : <div><p className="muted">이 워크스페이스에는 아직 프로젝트가 없습니다.</p><a className="btn btn-primary" href={`/org/${orgSlug}/projects/new`}>첫 프로젝트 만들기</a></div>}
          </div>
        </section>
      </section>
    </ConsoleShell>
  );
}

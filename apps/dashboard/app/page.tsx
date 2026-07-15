import { loadDashboardOverview, apiAction } from '../lib/api';
import { ConsoleShell, MetricStrip, StatusBadge } from '../components/console-ui';
import { LoadErrorSummary } from '../components/console-ui';
import { Icon } from '../components/icon';
import { ProjectCard } from '../components/project-card';

export default async function HomePage() {
  const state = await loadDashboardOverview();
  const user = state.me.body?.user;
  const subject = state.me.body?.subject;
  const projects = state.projects || [];
  const createOrgSlug = projects[0]?.organizationSlug || projects[0]?.organizationId || subject?.organizationSlug || subject?.organizationId || 'default';
  const health = state.health.body?.status === 'ok';
  const isAuthenticated = Boolean(user || subject);
  return (
    <ConsoleShell active="overview" orgValue={createOrgSlug} crumbs={`${createOrgSlug} / 운영 현황`} actions={<><a className="btn" href="/github">GitHub 연결</a><a className="btn btn-primary" href={`/org/${createOrgSlug}/projects/new`}>새 프로젝트</a>{isAuthenticated ? <form method="post" action={apiAction('/auth/logout')} className="inline-actions"><input type="hidden" name="_returnTo" value="/login" /><button className="btn" type="submit">로그아웃</button></form> : null}</>}>
      <section className="page" data-od-id="org-dashboard">
        <header className="page-header">
          <div>
            <p className="eyebrow">RAIBITSERVER · 제어 영역</p>
            <h1 className="page-title">운영 현황</h1>
            <p className="page-subtitle">프로젝트, 배포, 관리형 리소스 상태를 확인하세요.</p>
          </div>
          <StatusBadge status={health ? 'healthy' : 'offline'} />
        </header>

        <LoadErrorSummary issues={state.loadErrors} />

        <MetricStrip items={[
          { label: '운영 중인 프로젝트', value: projects.length, detail: '제어 영역 기준', progress: Math.min(projects.length * 10, 100) },
          { label: 'GitHub 연결', value: state.github?.integrations?.length || 0, detail: '설치 및 저장소', tone: 'info', progress: 60 },
          { label: '사용량 기록', value: state.usage?.usage?.length || 0, detail: '현재 할당량', tone: 'warn', progress: 42 },
        ]} />

        <section className="dashboard-grid">
          <div className="stack">
            <article className="card">
              <div className="card-title"><h2>프로젝트</h2><span className="badge info">{projects.length}개</span></div>
              <div className="stack">
              {projects.length ? projects.map((project: any) => (
                <ProjectCard key={project.id} project={{ ...project, services: project.serviceCount, resources: project.resourceCount }} href={`/org/${project.organizationSlug || project.organizationId || 'org'}/projects/${project.id}`} />
              )) : <div><p className="muted">아직 프로젝트가 없습니다. 첫 서비스를 배포할 프로젝트를 만드세요.</p><a className="subtle-link" href={`/org/${createOrgSlug}/projects/new`}>첫 프로젝트 만들기 →</a></div>}
              </div>
            </article>
            <article className="card">
              <div className="card-title"><h2>API 및 런타임 활동</h2><StatusBadge status={health ? 'healthy' : 'offline'} /></div>
              <div className="grid grid-2">
                <p><span className="label">제어 영역 상태</span><br />{health ? '정상' : state.health.error || '토큰 없음 또는 API에 연결할 수 없음'}</p>
                <p><span className="label">최근 조회</span><br />프로젝트 {projects.length}개 · 사용량 {state.usage?.usage?.length || 0}건</p>
              </div>
            </article>
          </div>
          <aside className="stack">
            <article className="card">
              <div className="card-title"><h2>빠른 작업</h2><span className="badge info">4개</span></div>
              <nav className="stack" aria-label="빠른 작업">
                <a className="quick-action" href={`/org/${createOrgSlug}/projects/new`}><Icon name="plus" /><span>새 프로젝트</span></a>
                <a className="quick-action" href="/github"><Icon name="arrow-top-right-on-square" /><span>GitHub 연결</span></a>
                <a className="quick-action" href="/login"><Icon name="shield-check" /><span>로그인</span></a>
                <a className="quick-action" href="#control-plane-status" data-health-endpoint={apiAction('/health')}><Icon name="server-stack" /><span>API 상태</span></a>
              </nav>
            </article>
            <article className="card" id="control-plane-status">
              <div className="card-title"><h2>제어 영역 정보</h2><StatusBadge status={health ? 'healthy' : 'offline'} /></div>
              <div className="stack">
                <p><span className="label">엔드포인트</span><br /><span className="mono">{state.context.baseUrl}</span></p>
                <p><span className="label">상태</span><br />{health ? '정상' : state.health.error || '토큰 없음 또는 API에 연결할 수 없음'}</p>
                <p><span className="label">현재 사용자</span><br />{user?.email || subject?.id || '대시보드 토큰 없음'}</p>
                <p><span className="label">계정</span><br />{subject?.accountType || user?.accountType || '알 수 없음'} / {subject?.approvalStatus || user?.approvalStatus || '알 수 없음'}</p>
              </div>
            </article>
          </aside>
        </section>
      </section>
    </ConsoleShell>
  );
}

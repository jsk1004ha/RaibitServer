import { apiAction, loadGitHubConsole } from '../../lib/api';
import { ConsoleShell, JsonCard } from '../../components/console-ui';
import { Icon } from '../../components/icon';

export default async function GitHubPage() {
  const state = await loadGitHubConsole();
  const firstService = state.services[0];
  const firstRepository = state.repositories[0];
  const serviceProject = state.projects.find((project: any) => String(project.id) === String(firstService?.projectId));
  const canAttachRepository = Boolean(firstService?.projectId && firstService?.id);
  const canSyncRepository = Boolean(firstRepository?.fullName);
  return (
    <ConsoleShell active="github"
      eyebrow="저장소"
      orgValue="GitHub 연동"
      projectValue="미리보기 정책"
      crumbs="GitHub / 저장소와 미리보기"
      actions={<><a className="btn" href="/">운영 현황</a><button className="btn btn-primary" type="submit" form="import-repository"><Icon name="arrow-top-right-on-square" />저장소 가져오기</button></>}
    >
      <section className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">GitHub App</p>
            <h1 className="page-title">저장소 연결과 미리보기 배포</h1>
            <p className="page-subtitle">설치 상태를 확인하고 저장소를 가져와 서비스에 연결합니다. 동기화와 웹훅 상태는 API 기록으로 확인할 수 있습니다.</p>
          </div>
          <span className="badge ok">웹훅 준비됨</span>
        </header>
        <section className="grid grid-2 grid-start">
          <form method="post" action={apiAction('/integrations/github', state.context)} className="card stack">
            <div className="card-title"><h2>GitHub 연결</h2><span className="badge info">설치</span></div>
            <p className="muted">조직의 GitHub App 설치 정보를 등록합니다.</p>
            <label>조직 ID<input name="organizationId" placeholder="org id" /></label>
            <label>GitHub 계정<input name="accountLogin" placeholder="github org/user" /></label>
            <label>설치 ID<input name="installationId" placeholder="installation id" /></label>
            <label>선택 토큰<input name="token" type="password" autoComplete="off" placeholder="optional token" /></label>
            <button type="submit">GitHub 연결</button>
            <span className="muted mono">POST /integrations/github</span>
          </form>
          <form id="import-repository" method="post" action={apiAction('/github/repositories/import', state.context)} className="card stack">
            <div className="card-title"><h2>저장소 가져오기</h2><span className="badge ok">소스</span></div>
            <p className="muted">저장소에서 새 서비스를 만들고 프로젝트에 추가합니다.</p>
            <label>프로젝트 ID<input name="projectId" placeholder="project id" defaultValue={state.projects[0]?.id || ''} /></label>
            <label>연동 ID<input name="integrationId" placeholder="integration id" defaultValue={state.integrations[0]?.id || ''} /></label>
            <label>저장소<input name="repository" placeholder="owner/repo" /></label>
            <label>서비스 이름<input name="serviceName" placeholder="service name" /></label>
            <button type="submit">저장소 가져오기</button>
            <span className="muted mono">POST /github/repositories/import</span>
          </form>
          <form method="post" action={canAttachRepository ? apiAction(`/projects/${firstService.projectId}/services/${firstService.id}/github`, state.context) : undefined} className="card stack">
            <div className="card-title"><h2>서비스에 저장소 연결</h2><span className="badge info">서비스</span></div>
            {canAttachRepository ? <p className="muted">현재 대상: {serviceProject?.name || serviceProject?.slug || firstService?.projectName || firstService?.projectId} / {firstService?.name || firstService?.id}</p> : <p className="muted" role="status">연결할 서비스가 없습니다. 먼저 프로젝트에 서비스를 만드세요.</p>}
            <fieldset className="stack" disabled={!canAttachRepository}>
              <label>연동 ID<input name="integrationId" placeholder="integration id" defaultValue={state.integrations[0]?.id || ''} /></label>
              <label>저장소 URL<input name="repoUrl" placeholder="https://github.com/org/repo.git" defaultValue={firstRepository?.repoUrl || ''} /></label>
              <label>브랜치<input name="branch" placeholder="main" defaultValue={firstRepository?.defaultBranch || 'main'} /></label>
              <button type="submit" disabled={!canAttachRepository}>서비스에 연결</button>
            </fieldset>
            <span className="muted mono">POST /projects/:projectId/services/:serviceId/github</span>
          </form>
          <form method="post" action={canSyncRepository ? apiAction(`/github/repositories/${encodeURIComponent(firstRepository.fullName)}/sync`, state.context) : undefined} className="card stack">
            <div className="card-title"><h2>저장소 정보 동기화</h2><span className="badge warn">대기열</span></div>
            {canSyncRepository ? <p className="muted">연결된 서비스의 설치·저장소 정보를 다시 확인합니다.</p> : <p className="muted" role="status">동기화할 저장소가 없습니다. 먼저 저장소를 가져오세요.</p>}
            <fieldset className="stack" disabled={!canSyncRepository}>
              <button type="submit" disabled={!canSyncRepository}>정보 동기화</button>
            </fieldset>
            <span className="muted mono">POST /github/repositories/:repositoryId/sync</span>
          </form>
        </section>
        <section className="grid grid-3 grid-start" style={{ marginTop: 16 }}>
          <JsonCard title="설치" value={state.installations} /><JsonCard title="설치 저장소" value={state.repositoriesByInstallation} /><JsonCard title="연동" value={state.integrations} /><JsonCard title="가져올 프로젝트" value={state.projects.map((project: any) => ({ id: project.id, name: project.name || project.slug }))} /><JsonCard title="연결 가능한 서비스" value={state.services.map((service: any) => ({ projectId: service.projectId, serviceId: service.id, name: service.name || service.slug, repository: service.githubRepository || service.repoUrl }))} /><JsonCard title="웹훅 / 미리보기 계약" value={{ webhookEndpoint: 'POST /github/webhooks', requiredHeaders: ['x-github-event', 'x-github-delivery', 'x-hub-signature-256'], push: 'build-and-deploy WorkflowJob', pullRequest: 'preview-deploy WorkflowJob with pr-N workload', closed: 'preview-cleanup WorkflowJob' }} />
        </section>
      </section>
    </ConsoleShell>
  );
}

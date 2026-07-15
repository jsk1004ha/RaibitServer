import { apiAction, loadGitHubConsole } from '../../lib/api';
import { ConsoleShell, JsonCard, LoadErrorSummary } from '../../components/console-ui';
import { Icon } from '../../components/icon';

export default async function GitHubPage() {
  const state = await loadGitHubConsole();
  const firstService = state.services[0];
  const firstRepository = state.repositories[0];
  const firstInstallation = state.installations[0];
  const serviceProject = state.projects.find((project: any) => String(project.id) === String(firstService?.projectId));
  const verifiedIntegrationId = firstInstallation?.integrationId || '';
  const authoritativeRepositoryId = firstRepository?.githubRepoId || firstRepository?.id || '';
  const canImportRepository = Boolean(state.projects[0]?.id && verifiedIntegrationId && authoritativeRepositoryId);
  const canAttachRepository = Boolean(firstService?.projectId && firstService?.id && verifiedIntegrationId && authoritativeRepositoryId);
  const canSyncRepository = Boolean(firstRepository?.fullName);
  return (
    <ConsoleShell active="github"
      eyebrow="저장소"
      orgValue="GitHub 연동"
      projectValue="미리보기 정책"
      crumbs="GitHub / 저장소와 미리보기"
      actions={<><a className="btn" href="/">운영 현황</a><button className="btn btn-primary" type="submit" form="import-repository" disabled={!canImportRepository}><Icon name="arrow-top-right-on-square" />저장소 가져오기</button></>}
    >
      <section className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">GitHub App</p>
            <h1 className="page-title">저장소 연결과 미리보기 배포</h1>
            <p className="page-subtitle">설치 상태를 확인하고 저장소를 가져와 서비스에 연결합니다. 동기화와 웹훅 상태는 API 기록으로 확인할 수 있습니다.</p>
          </div>
          <span className="badge warn">Private Git 보류</span>
        </header>
        <LoadErrorSummary issues={state.loadErrors} />
        <section className="grid grid-2 grid-start">
          <section className="card stack">
            <div className="card-title"><h2>GitHub 연결</h2><span className="badge info">설치</span></div>
            <p className="muted">설치 ID나 토큰을 직접 입력하지 않습니다. GitHub App callback이 조직 소유권을 검증하고 동기화한 설치와 저장소만 아래 작업에 표시됩니다.</p>
            <a className="btn" href="/login">GitHub App 설치 상태 확인</a>
            <span className="muted mono">POST /integrations/github · unverified placeholder only</span>
          </section>
          <form id="import-repository" method="post" action={canImportRepository ? apiAction('/github/repositories/import', state.context) : undefined} className="card stack">
            <div className="card-title"><h2>저장소 가져오기</h2><span className="badge ok">소스</span></div>
            {canImportRepository ? <p className="muted">검증된 설치가 허용한 저장소에서 새 서비스를 만듭니다.</p> : <p className="muted" role="status">검증된 GitHub App 설치와 저장소가 없습니다.</p>}
            <fieldset className="stack" disabled={!canImportRepository}>
              <label>프로젝트 ID<input name="projectId" readOnly value={state.projects[0]?.id || ''} /></label>
              <label>검증된 연동 ID<input name="integrationId" readOnly value={verifiedIntegrationId} /></label>
              <label>설치 저장소<select name="repositoryId" defaultValue={authoritativeRepositoryId}>{state.repositories.map((repository: any) => <option key={`${repository.installationId}:${repository.githubRepoId || repository.id}`} value={repository.githubRepoId || repository.id}>{repository.fullName}</option>)}</select></label>
              <label>서비스 이름<input name="serviceName" placeholder="service name" /></label>
              <button type="submit" disabled={!canImportRepository}>저장소 가져오기</button>
            </fieldset>
            <span className="muted mono">POST /github/repositories/import</span>
          </form>
          <form method="post" action={canAttachRepository ? apiAction(`/projects/${firstService.projectId}/services/${firstService.id}/github`, state.context) : undefined} className="card stack">
            <div className="card-title"><h2>서비스에 저장소 연결</h2><span className="badge info">서비스</span></div>
            {canAttachRepository ? <p className="muted">현재 대상: {serviceProject?.name || serviceProject?.slug || firstService?.projectName || firstService?.projectId} / {firstService?.name || firstService?.id}</p> : <p className="muted" role="status">연결할 서비스가 없습니다. 먼저 프로젝트에 서비스를 만드세요.</p>}
            <fieldset className="stack" disabled={!canAttachRepository}>
              <label>검증된 연동 ID<input name="integrationId" readOnly value={verifiedIntegrationId} /></label>
              <label>설치 저장소<select name="repositoryId" defaultValue={authoritativeRepositoryId}>{state.repositories.map((repository: any) => <option key={`${repository.installationId}:${repository.githubRepoId || repository.id}`} value={repository.githubRepoId || repository.id}>{repository.fullName}</option>)}</select></label>
              <label>브랜치<input name="branch" placeholder="main" defaultValue={firstRepository?.defaultBranch || 'main'} /></label>
              <button type="submit" disabled={!canAttachRepository}>서비스에 연결</button>
            </fieldset>
            <span className="muted mono">POST /projects/:projectId/services/:serviceId/github</span>
          </form>
          <form method="post" action={canSyncRepository ? apiAction(`/github/repositories/${encodeURIComponent(firstRepository.fullName)}/sync`, state.context) : undefined} className="card stack">
            <div className="card-title"><h2>저장소 정보 동기화</h2><span className="badge warn">대기열</span></div>
            {canSyncRepository ? <p className="muted">현재 대상: <strong>{firstRepository.fullName}</strong>. 연결된 서비스의 설치·저장소 정보를 다시 확인합니다.</p> : <p className="muted" role="status">동기화할 저장소가 없습니다. 먼저 저장소를 가져오세요.</p>}
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

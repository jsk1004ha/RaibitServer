import { apiAction, loadGitHubConsole } from '../../lib/api';
import { ConsoleShell, LoadErrorSummary, SectionNav } from '../../components/console-ui';

const steps = ['connect', 'import', 'attach', 'sync'] as const;
type GitHubStep = typeof steps[number];

export default async function GitHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedStep = String(query.step || 'connect');
  const step: GitHubStep = steps.includes(requestedStep as GitHubStep) ? requestedStep as GitHubStep : 'connect';
  const state = await loadGitHubConsole();
  const requestedInstallationId = String(query.installation || '');
  const selectedInstallation = state.installations.find((row: any) => String(row.installationId) === requestedInstallationId)
    || state.installations[0];
  const selectedRepositories = state.repositoriesByInstallation
    .find((row: any) => String(row.installationId) === String(selectedInstallation?.installationId))
    ?.repositories || [];
  const selectedRepository = selectedRepositories[0];
  const firstService = state.services[0];
  const serviceProject = state.projects.find((project: any) => String(project.id) === String(firstService?.projectId));
  const integrationId = selectedInstallation?.integrationId || '';
  const repositoryId = selectedRepository?.githubRepoId || selectedRepository?.id || '';
  const canImportRepository = Boolean(state.projects[0]?.id && integrationId && repositoryId);
  const canAttachRepository = Boolean(firstService?.projectId && firstService?.id && integrationId && repositoryId);
  const canSyncRepository = Boolean(selectedRepository?.fullName);
  const navItems = [
    { id: 'connect', label: 'GitHub 연결', description: 'App 설치', href: '/github?step=connect' },
    { id: 'import', label: '저장소 선택', description: '프로젝트 추가', href: '/github?step=import' },
    { id: 'attach', label: '서비스 연결', description: '실행 단위', href: '/github?step=attach' },
    { id: 'sync', label: '동기화', description: '연동 상태', href: '/github?step=sync' },
  ];

  return (
    <ConsoleShell active="github" eyebrow="저장소" orgValue="GitHub 연동" projectValue={`단계 ${steps.indexOf(step) + 1} / ${steps.length}`}>
      <section className="page page-focus">
        <header className="page-header">
          <div><h1 className="page-title">GitHub 연결</h1><p className="page-subtitle">설치하고 저장소를 선택하세요.</p></div>
          <span className={`badge ${state.installations.length ? 'ok' : 'info'}`}>{state.installations.length ? '연결됨' : '연결 필요'}</span>
        </header>
        <LoadErrorSummary issues={state.loadErrors} />
        <SectionNav items={navItems} current={step} label="저장소 연결 단계" variant="steps" />
        <div className="single-activity">
          {step === 'connect' ? (
            <section className="form-surface stack activity-card github-connect-card">
              <div><h2>GitHub App 연결</h2><p className="muted">계정과 저장소를 GitHub에서 선택합니다.</p></div>
              {state.installations.length ? (
                <dl className="detail-list">
                  {state.installations.map((installation: any) => (
                    <div key={installation.installationId}>
                      <dt>연결 계정</dt>
                      <dd>{installation.accountLogin} · 저장소 {installation.repositoryCount || 0}개</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="muted" role="status">연결된 계정이 없습니다.</p>}
              <div className="workflow-actions">
                {state.installations.length ? <a className="btn btn-ghost" href="/github?step=import">저장소 선택</a> : <span />}
                <a className="btn btn-primary" href="/github/install">{state.installations.length ? '다른 계정 연결' : 'GitHub 연결'}</a>
              </div>
            </section>
          ) : null}

          {step === 'import' ? (
            <section className="form-surface stack activity-card">
              <div><h2>저장소 선택</h2><p className="muted">프로젝트에 새 서비스를 만듭니다.</p></div>
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="import" />
              {canImportRepository ? (
                <form id="import-repository" method="post" action={apiAction('/github/repositories/import', state.context)} className="stack">
                  <input type="hidden" name="_returnTo" value="/github?step=attach" />
                  <input type="hidden" name="integrationId" value={integrationId} />
                  <fieldset className="stack">
                    <label>저장소<select name="repositoryId" defaultValue={repositoryId}>{selectedRepositories.map((repository: any) => <option key={repository.githubRepoId || repository.id} value={repository.githubRepoId || repository.id}>{repository.fullName} · {repository.private ? '비공개' : '공개'}</option>)}</select></label>
                    <label>프로젝트<select name="projectId" defaultValue={state.projects[0]?.id}>{state.projects.map((project: any) => <option key={project.id} value={project.id}>{project.name || project.slug}</option>)}</select></label>
                    <label>서비스 이름<input name="serviceName" placeholder={selectedRepository?.name || 'web'} /></label>
                    <div className="workflow-actions"><a className="btn btn-ghost" href="/github?step=connect">이전</a><button className="btn btn-primary" type="submit">가져오기</button></div>
                  </fieldset>
                </form>
              ) : <EmptyGitHubStep hasInstallation={Boolean(selectedInstallation)} hasRepositories={selectedRepositories.length > 0} hasProjects={state.projects.length > 0} />}
            </section>
          ) : null}

          {step === 'attach' ? (
            <section className="form-surface stack activity-card">
              <div><h2>서비스 연결</h2><p className="muted">기존 서비스의 소스를 바꿉니다.</p></div>
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="attach" />
              {canAttachRepository ? (
                <form method="post" action={apiAction(`/projects/${firstService.projectId}/services/${firstService.id}/github`, state.context)} className="stack">
                  <input type="hidden" name="_returnTo" value="/github?step=sync" />
                  <input type="hidden" name="integrationId" value={integrationId} />
                  <p className="muted"><strong>{serviceProject?.name || firstService.projectId}</strong> / {firstService.name || firstService.id}</p>
                  <fieldset className="stack">
                    <label>저장소<select name="repositoryId" defaultValue={repositoryId}>{selectedRepositories.map((repository: any) => <option key={repository.githubRepoId || repository.id} value={repository.githubRepoId || repository.id}>{repository.fullName} · {repository.private ? '비공개' : '공개'}</option>)}</select></label>
                    <label>브랜치<input name="branch" defaultValue={selectedRepository?.defaultBranch || 'main'} /></label>
                    <div className="workflow-actions"><a className="btn btn-ghost" href="/github?step=import">이전</a><button className="btn btn-primary" type="submit">연결</button></div>
                  </fieldset>
                </form>
              ) : <p className="muted" role="status">연결할 서비스와 저장소가 필요합니다.</p>}
            </section>
          ) : null}

          {step === 'sync' ? (
            <section className="form-surface stack activity-card">
              <div><h2>저장소 동기화</h2><p className="muted">권한과 기본 브랜치를 다시 확인합니다.</p></div>
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="sync" />
              {canSyncRepository ? (
                <form method="post" action={apiAction(`/github/repositories/${encodeURIComponent(selectedRepository.fullName)}/sync`, state.context)} className="stack">
                  <input type="hidden" name="_returnTo" value={`/github?step=sync&installation=${encodeURIComponent(selectedInstallation.installationId)}`} />
                  <p><strong>{selectedRepository.fullName}</strong></p>
                  <div className="workflow-actions"><a className="btn btn-ghost" href="/github?step=attach">이전</a><button className="btn btn-primary" type="submit">동기화</button></div>
                </form>
              ) : <p className="muted" role="status">동기화할 저장소가 없습니다.</p>}
            </section>
          ) : null}
        </div>
      </section>
    </ConsoleShell>
  );
}

function InstallationChooser({ installations, selectedId, step }: { installations: any[]; selectedId?: string; step: GitHubStep }) {
  if (installations.length < 2) return null;
  return (
    <nav className="section-nav" aria-label="GitHub 계정">
      {installations.map((installation) => <a key={installation.installationId} className={`section-nav-item ${String(installation.installationId) === String(selectedId) ? 'active' : ''}`} href={`/github?step=${step}&installation=${encodeURIComponent(installation.installationId)}`}><span><strong>{installation.accountLogin}</strong><small>저장소 {installation.repositoryCount || 0}개</small></span></a>)}
    </nav>
  );
}

function EmptyGitHubStep({ hasInstallation, hasRepositories, hasProjects }: { hasInstallation: boolean; hasRepositories: boolean; hasProjects: boolean }) {
  if (!hasInstallation) return <p className="muted" role="status">먼저 GitHub를 연결하세요.</p>;
  if (!hasRepositories) return <p className="muted" role="status">선택된 저장소가 없습니다. GitHub에서 권한을 추가하세요.</p>;
  if (!hasProjects) return <p className="muted" role="status">먼저 프로젝트를 만드세요.</p>;
  return null;
}

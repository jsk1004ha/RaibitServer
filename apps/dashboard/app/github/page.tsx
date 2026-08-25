import { apiAction, loadGitHubConsole } from '../../lib/api';
import { ConsoleShell, JsonCard, LoadErrorSummary, SectionNav } from '../../components/console-ui';

const steps = ['connect', 'import', 'attach', 'sync'] as const;
type GitHubStep = typeof steps[number];

export default async function GitHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedStep = String(query.step || 'connect');
  const step: GitHubStep = steps.includes(requestedStep as GitHubStep) ? requestedStep as GitHubStep : 'connect';
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
  const navItems = [
    { id: 'connect', label: 'GitHub 연결', description: 'App 설치', href: '/github?step=connect' },
    { id: 'import', label: '저장소 가져오기', description: '프로젝트 추가', href: '/github?step=import' },
    { id: 'attach', label: '서비스 연결', description: '실행 단위', href: '/github?step=attach' },
    { id: 'sync', label: '동기화', description: '연동 상태', href: '/github?step=sync' },
  ];

  return (
    <ConsoleShell active="github" eyebrow="저장소" orgValue="GitHub 연동" projectValue={`단계 ${steps.indexOf(step) + 1} / ${steps.length}`}>
      <section className="page page-focus">
        <header className="page-header"><div><h1 className="page-title">GitHub 연결</h1><p className="page-subtitle">설치 · 연결 · 동기화</p></div><span className="badge ok">웹훅 준비됨</span></header>
        <LoadErrorSummary issues={state.loadErrors} />
        <SectionNav items={navItems} current={step} label="저장소 연결 단계" variant="steps" />
        <div className="single-activity">
          {step === 'connect' ? <section className="form-surface stack activity-card"><div><h2>GitHub 연결</h2><p className="muted">검증된 App 설치</p></div><p className="muted">설치 ID나 토큰을 직접 입력하지 않습니다. GitHub App callback이 조직 소유권을 확인합니다.</p>{firstInstallation ? <dl className="detail-list"><div><dt>설치</dt><dd>{firstInstallation.accountLogin || firstInstallation.installationId}</dd></div><div><dt>상태</dt><dd>검증됨</dd></div></dl> : <p role="status">검증된 설치가 없습니다.</p>}<a className="btn btn-primary" href="/login">GitHub App 설치 상태 확인</a></section> : null}
          {step === 'import' ? <form id="import-repository" method="post" action={canImportRepository ? apiAction('/github/repositories/import', state.context) : undefined} className="form-surface stack activity-card"><input type="hidden" name="_returnTo" value="/github?step=attach" /><div><h2>저장소 가져오기</h2><p className="muted">프로젝트에 추가</p></div>{canImportRepository ? <fieldset className="stack"><label>프로젝트<select name="projectId" defaultValue={state.projects[0]?.id}>{state.projects.map((project: any) => <option key={project.id} value={project.id}>{project.name || project.slug}</option>)}</select></label><input type="hidden" name="integrationId" value={verifiedIntegrationId} /><label>설치 저장소<select name="repositoryId" defaultValue={authoritativeRepositoryId}>{state.repositories.map((repository: any) => <option key={`${repository.installationId}:${repository.githubRepoId || repository.id}`} value={repository.githubRepoId || repository.id}>{repository.fullName}</option>)}</select></label><label>서비스 이름<input name="serviceName" placeholder="web" /></label><div className="workflow-actions"><a className="btn btn-ghost" href="/github?step=connect">이전</a><button className="btn btn-primary" type="submit">저장소 가져오기</button></div></fieldset> : <p className="muted" role="status">검증된 설치와 저장소가 없습니다.</p>}</form> : null}
          {step === 'attach' ? <form method="post" action={canAttachRepository ? apiAction(`/projects/${firstService.projectId}/services/${firstService.id}/github`, state.context) : undefined} className="form-surface stack activity-card"><input type="hidden" name="_returnTo" value="/github?step=sync" /><div><h2>서비스에 저장소 연결</h2></div>{canAttachRepository ? <><p className="muted">{serviceProject?.name || firstService?.projectId} / {firstService?.name || firstService?.id}</p><fieldset className="stack"><input type="hidden" name="integrationId" value={verifiedIntegrationId} /><label>설치 저장소<select name="repositoryId" defaultValue={authoritativeRepositoryId}>{state.repositories.map((repository: any) => <option key={`${repository.installationId}:${repository.githubRepoId || repository.id}`} value={repository.githubRepoId || repository.id}>{repository.fullName}</option>)}</select></label><label>브랜치<input name="branch" defaultValue={firstRepository?.defaultBranch || 'main'} /></label><button className="btn btn-primary" type="submit">서비스에 연결</button></fieldset></> : <p className="muted" role="status">연결할 서비스가 없습니다.</p>}</form> : null}
          {step === 'sync' ? <div className="stack activity-card"><form method="post" action={canSyncRepository ? apiAction(`/github/repositories/${encodeURIComponent(firstRepository.fullName)}/sync`, state.context) : undefined} className="form-surface stack"><input type="hidden" name="_returnTo" value="/github?step=sync" /><div><h2>저장소 정보 동기화</h2></div>{canSyncRepository ? <p className="muted"><strong>{firstRepository.fullName}</strong></p> : <p className="muted" role="status">동기화할 저장소가 없습니다.</p>}<fieldset className="stack" disabled={!canSyncRepository}><button className="btn btn-primary" type="submit" disabled={!canSyncRepository}>정보 동기화</button></fieldset></form><JsonCard title="웹훅 / 미리보기 계약" value={{ webhookEndpoint: 'POST /github/webhooks', push: 'build-and-deploy', pullRequest: 'preview-deploy', closed: 'preview-cleanup' }} /></div> : null}
        </div>
      </section>
    </ConsoleShell>
  );
}

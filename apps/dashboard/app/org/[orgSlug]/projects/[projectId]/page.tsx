import { apiAction, collectLoadIssues, getJson, loadProjectConsole, postJson } from '../../../../../lib/api';
import { projectMainLink } from '../../../../../lib/project-main-link';
import { ConsoleShell, LoadErrorSummary, LogViewer, MetricStrip, SectionNav, StatusBadge } from '../../../../../components/console-ui';

const views = ['overview', 'services', 'new-service', 'edit-service', 'deployments', 'agent', 'resources', 'new-resource', 'environment', 'logs', 'settings'] as const;
type ProjectView = typeof views[number];

function queryText(value: string | string[] | undefined) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function exactPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default async function ProjectDetailPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ orgSlug, projectId }, query] = await Promise.all([params, searchParams]);
  const requestedView = queryText(query.view) || 'overview';
  const view: ProjectView = views.includes(requestedView as ProjectView) ? requestedView as ProjectView : 'overview';
  const state = await loadProjectConsole(projectId);
  const selectedServiceId = queryText(query.serviceId);
  const selectedService = state.services.find((service: any) => String(service.id) === selectedServiceId) || null;
  const serviceSettings = selectedService
    ? { ...(selectedService.desiredState || {}), ...(selectedService.desiredSpec || {}), ...selectedService }
    : null;
  const environmentService = selectedService || state.services[0] || null;
  const environment = view === 'environment' && environmentService
    ? await getJson(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(environmentService.id)}/env`, { entries: [] }, state.context)
    : null;
  const environmentEntries = environment?.body?.entries || [];
  const editedEnvironmentKey = queryText(query.envKey);
  const editedEnvironment = environmentEntries.find((entry: any) => String(entry.key) === editedEnvironmentKey) || null;
  const agentPlanResult = view === 'agent'
    ? await postJson(`/projects/${encodeURIComponent(projectId)}/deployment-agent/plan`, {}, {
      version: 'v1',
      generatedBy: 'deterministic',
      summary: '배포 계획을 불러오지 못했습니다.',
      blocked: true,
      canApply: false,
      deploymentOrder: [],
      services: [],
      security: { highestSeverity: 'none', critical: 0, high: 0, medium: 0, low: 0 },
    }, state.context)
    : null;
  const agentPlan = agentPlanResult?.body || null;
  const logService = state.services[0];
  const runtimeLogs = view === 'logs' && logService
    ? await getJson(`/services/${encodeURIComponent(logService.id)}/logs`, { logs: [] }, state.context)
    : null;
  const loadErrors = [
    ...state.loadErrors,
    ...(runtimeLogs ? collectLoadIssues([['런타임 로그', runtimeLogs]]) : []),
    ...(environment ? collectLoadIssues([['환경 변수', environment]]) : []),
    ...(agentPlanResult ? collectLoadIssues([['AI 배포 계획', agentPlanResult]]) : []),
  ];
  const projectName = state.project.name || state.project.slug || projectId;
  const mainLink = projectMainLink({
    organizationSlug: state.project.organizationSlug || state.project.organization?.slug || orgSlug,
    project: state.project,
    services: state.services,
    baseDomain: process.env.RAIBITSERVER_BASE_DOMAIN || process.env.BASE_DOMAIN,
  });
  const deletionPending = ['DELETE_REQUESTED', 'DELETING'].includes(String(state.project.status || '').toUpperCase());
  const base = `/org/${orgSlug}/projects/${projectId}`;
  const navItems = [
    { id: 'overview', label: '현황', description: '프로젝트 상태', href: `${base}?view=overview` },
    { id: 'services', label: '서비스', description: '실행 단위', href: `${base}?view=services` },
    { id: 'deployments', label: '배포', description: '배포 기록', href: `${base}?view=deployments` },
    { id: 'agent', label: 'AI 배포', description: '위협 점검·자동 실행', href: `${base}?view=agent` },
    { id: 'resources', label: '리소스', description: '데이터 계층', href: `${base}?view=resources` },
    { id: 'environment', label: '환경 변수', description: '비밀키 관리', href: `${base}?view=environment` },
    { id: 'logs', label: '로그', description: '실행 기록', href: `${base}?view=logs` },
    { id: 'settings', label: '설정', description: '프로젝트 관리', href: `${base}?view=settings` },
  ];

  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug} projectValue={projectName} projectId={projectId}>
      <section className="page page-focus" data-od-id="project-overview">
        <header className="page-header"><div><div className="project-title-line"><h1 className="page-title">{projectName}</h1>{mainLink ? <a className="project-main-link" href={mainLink.href} target="_blank" rel="noreferrer" aria-label={`${projectName} 메인 사이트 새 창에서 열기`} title={mainLink.href}><span>{mainLink.label}</span><span aria-hidden="true">↗</span></a> : null}</div><p className="page-subtitle">서비스 · 배포 · 리소스</p></div><StatusBadge status={state.project.status || 'healthy'} /></header>
        <LoadErrorSummary issues={loadErrors} />
        <SectionNav items={navItems} current={view === 'edit-service' ? 'services' : view} label="프로젝트 콘솔 화면" />

        {view === 'overview' ? <div className="project-overview project-overview-compact">
          <MetricStrip items={[
            { label: '서비스', value: state.services.length, detail: '실행 컨테이너', tone: 'ok' },
            { label: '리소스', value: state.resources.length, detail: '관리형 데이터', tone: 'info' },
            { label: '배포', value: state.deployments.length, detail: `미리보기 ${state.previewDeployments.length}개`, tone: 'warn' },
          ]} />
          <div className="overview-summary-grid">
            <section className="console-surface overview-operation-list">
              <div className="card-title"><h2>운영 구성</h2><StatusBadge status={state.project.status || 'healthy'} /></div>
              <a href={`${base}?view=services`}><span><strong>서비스</strong><small>웹·워커·예약 작업</small></span><b>{state.services.length}</b><i>관리 →</i></a>
              <a href={`${base}?view=resources`}><span><strong>리소스</strong><small>DB·캐시·스토리지</small></span><b>{state.resources.length}</b><i>관리 →</i></a>
              <a href={`${base}?view=deployments`}><span><strong>배포</strong><small>운영·미리보기 기록</small></span><b>{state.deployments.length}</b><i>확인 →</i></a>
            </section>
            <section className="console-surface overview-recent">
              <div className="card-title"><h2>최근 배포</h2><a className="subtle-link" href={`${base}?view=deployments`}>전체 보기 →</a></div>
              {state.deployments.length ? <div className="overview-recent-list">{state.deployments.slice(0, 4).map((deployment: any) => <a key={deployment.id} href={`${base}/deployments/${deployment.id}`}><span><strong>{deployment.serviceName || '서비스'}</strong><small>{deployment.deploymentType || 'production'}</small></span><StatusBadge status={deployment.status} /></a>)}</div> : <div className="overview-compact-empty"><strong>아직 배포가 없습니다.</strong><p>서비스에서 첫 배포를 시작하세요.</p><a className="subtle-link" href={`${base}?view=services`}>서비스로 이동 →</a></div>}
            </section>
          </div>
          <nav className="overview-quick-actions" aria-label="프로젝트 빠른 작업"><a href={`${base}?view=new-service`}>+ 서비스 만들기</a><a href={`${base}?view=new-resource`}>+ 리소스 추가</a><a href="/github?step=attach">↗ 저장소 연결</a></nav>
        </div> : null}

        {view === 'new-service' ? <form method="post" action={apiAction(`/projects/${projectId}/services`, state.context)} className="form-surface stack single-activity activity-card">
          <input type="hidden" name="_returnTo" value={`${base}?view=services`} />
          <div><h2>서비스 만들기</h2><p className="muted">컨테이너 실행 단위</p></div>
          <div className="form-grid"><label>서비스 이름 <input name="name" placeholder="예: web" required /></label><label>서비스 유형 <select name="type" defaultValue="web"><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></select></label><label>소스 유형 <select name="sourceType" defaultValue="github"><option value="github">GitHub / Git 소스</option><option value="image">빌드된 이미지</option><option value="local">로컬 Dockerfile</option></select></label><label>저장소 URL <input name="repoUrl" placeholder="https://github.com/org/repo.git" /></label><label>브랜치 <input name="branch" placeholder="main" /></label><label>이미지 <input name="imageUrl" placeholder="registry.example.com/team/web:tag" /></label><label>Dockerfile 경로 <input name="dockerfilePath" placeholder="Dockerfile" /></label><label>빌드 컨텍스트 <input name="buildContext" placeholder="." /></label></div>
          <div className="workflow-actions"><a className="btn btn-ghost" href={`${base}?view=services`}>취소</a><button className="btn btn-primary" type="submit">서비스 만들기</button></div>
        </form> : null}

        {view === 'services' ? <section className="console-surface single-activity activity-card">
          <div className="card-title"><h2>서비스</h2><div className="inline-actions"><span className="badge info">{state.services.length}개</span><a className="btn btn-primary" href={`${base}?view=new-service`}>새 서비스</a></div></div>
          {state.services.length ? <table className="table"><thead><tr><th>이름</th><th>유형</th><th>상태</th><th>소스</th><th>배포</th><th>관리</th></tr></thead><tbody>{state.services.map((service: any) => <tr key={service.id}><td><strong>{service.name || service.slug}</strong><p className="muted">{service.id}</p></td><td className="mono">{service.type || 'web'}</td><td><StatusBadge status={service.status || 'created'} /></td><td className="mono">{service.repoUrl || service.imageUrl || '소스 없음'}</td><td className="table-actions"><div className="service-deploy-actions"><form method="post" action={apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)}><input type="hidden" name="_returnTo" value={`${base}?view=deployments`} /><input type="hidden" name="deploymentType" value="production" /><button className="btn btn-primary" type="submit">운영 배포</button></form><form method="post" action={apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)}><input type="hidden" name="_returnTo" value={`${base}?view=deployments`} /><input type="hidden" name="deploymentType" value="preview" /><button className="btn" type="submit">미리보기</button></form></div></td><td><a className="btn btn-ghost" href={`${base}?view=edit-service&serviceId=${encodeURIComponent(service.id)}`}>설정</a></td></tr>)}</tbody></table> : <div className="empty-state"><strong>서비스가 없습니다.</strong><a className="btn btn-primary" href={`${base}?view=new-service`}>첫 서비스 만들기</a></div>}
        </section> : null}

        {view === 'edit-service' ? serviceSettings ? <form method="post" action={apiAction(`/services/${serviceSettings.id}`, state.context)} className="form-surface stack single-activity activity-card">
          <input type="hidden" name="_method" value="PATCH" />
          <input type="hidden" name="_returnTo" value={`${base}?view=services`} />
          <div><h2>{serviceSettings.name || '서비스'} 설정</h2><p className="muted">빌드와 실행 설정</p></div>
          <div className="form-grid">
            <label>서비스 이름 <input name="name" defaultValue={serviceSettings.name || ''} required /></label>
            <label>서비스 유형 <select name="type" defaultValue={String(serviceSettings.type || 'web').toLowerCase()}><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></select></label>
            <label>소스 유형 <select name="sourceType" defaultValue={String(serviceSettings.sourceType || 'github').toLowerCase()}><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="zip">ZIP</option><option value="image">빌드된 이미지</option><option value="local">로컬 Dockerfile</option></select></label>
            <label>빌드 방식 <select name="buildMode" defaultValue={String(serviceSettings.buildMode || 'auto').toLowerCase().replaceAll('_', '-')}><option value="auto">자동</option><option value="dockerfile">Dockerfile</option><option value="buildpack">Buildpack</option><option value="framework">프레임워크</option><option value="custom">직접 설정</option><option value="prebuilt-image">빌드된 이미지</option><option value="generated">자동 생성</option></select></label>
            <label>저장소 URL <input name="repoUrl" type="url" defaultValue={serviceSettings.repoUrl || ''} placeholder="https://github.com/org/repo.git" /></label>
            <label>브랜치 <input name="branch" defaultValue={serviceSettings.branch || ''} placeholder="main" /></label>
            <label>루트 경로 <input name="rootDirectory" defaultValue={serviceSettings.rootDirectory || ''} placeholder="." /></label>
            <label>빌드 컨텍스트 <input name="buildContext" defaultValue={serviceSettings.buildContext || ''} placeholder="." /></label>
            <label>Dockerfile 경로 <input name="dockerfilePath" defaultValue={serviceSettings.dockerfilePath || ''} placeholder="Dockerfile" title="폴더가 아닌 Dockerfile을 입력하세요." /></label>
            <label>이미지 <input name="imageUrl" defaultValue={serviceSettings.imageUrl || serviceSettings.image || ''} placeholder="registry.example.com/team/web:tag" /></label>
            <label>설치 명령 <input name="installCommand" defaultValue={serviceSettings.installCommand || ''} placeholder="npm ci" /></label>
            <label>빌드 명령 <input name="buildCommand" defaultValue={serviceSettings.buildCommand || ''} placeholder="npm run build" /></label>
            <label>시작 명령 <input name="startCommand" defaultValue={serviceSettings.startCommand || ''} placeholder="npm start" /></label>
            <label>출력 경로 <input name="outputDirectory" defaultValue={serviceSettings.outputDirectory || ''} placeholder="dist" /></label>
            <label>포트 <input name="port" type="number" min="1" max="65535" defaultValue={serviceSettings.port || ''} placeholder="3000" /></label>
          </div>
          <div className="workflow-actions"><a className="btn btn-ghost" href={`${base}?view=services`}>취소</a><button className="btn btn-primary" type="submit">설정 저장</button></div>
        </form> : <div className="empty-state single-activity"><strong>서비스를 찾을 수 없습니다.</strong><a className="btn" href={`${base}?view=services`}>서비스로 이동</a></div> : null}

        {view === 'deployments' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>배포 내역</h2><span className="badge info">로그와 이벤트</span></div>{state.deployments.length ? <table className="table"><thead><tr><th>서비스</th><th>유형</th><th>상태</th><th>이미지</th><th>상세</th></tr></thead><tbody>{state.deployments.map((deployment: any) => <tr key={deployment.id}><td>{deployment.serviceName}</td><td>{deployment.deploymentType}</td><td><StatusBadge status={deployment.status} /></td><td className="mono">{deployment.imageDigest || deployment.imageUrl || '이미지 대기 중'}</td><td><a className="subtle-link" href={`${base}/deployments/${deployment.id}`}>배포 상세</a></td></tr>)}</tbody></table> : <p className="muted">아직 배포가 없습니다.</p>}</section> : null}

        {view === 'agent' && agentPlan ? <div className="stack single-activity">
          <MetricStrip items={[
            { label: '배포 대상', value: agentPlan.deploymentOrder?.length || 0, detail: agentPlan.generatedBy === 'external-ai' ? '외부 AI 순서 제안' : '내장 규칙 순서', tone: 'info' },
            { label: '치명적 위험', value: agentPlan.security?.critical || 0, detail: '발견 즉시 차단', tone: agentPlan.security?.critical ? 'warn' : 'ok' },
            { label: '높은 위험', value: agentPlan.security?.high || 0, detail: '해결 전 배포 불가', tone: agentPlan.security?.high ? 'warn' : 'ok' },
          ]} />
          <section className="console-surface activity-card">
            <div className="card-title"><div><h2>AI 배포 관리자</h2><p className="muted">서비스를 다시 읽고 보안 정책을 통과한 배포만 순서대로 실행합니다.</p></div><span className={`badge ${agentPlan.blocked ? 'danger' : 'ok'}`}>{agentPlan.blocked ? '보안 차단' : '실행 가능'}</span></div>
            <p>{agentPlan.summary}</p>
            <p className="muted">외부 AI에는 서비스 이름·유형과 위협 코드만 전달합니다. 비밀값은 전송하지 않으며, AI 제안은 서버의 결정적 보안 검사를 우회할 수 없습니다.</p>
            {agentPlan.services?.length ? <table className="table"><thead><tr><th>서비스</th><th>판정</th><th>보안 점검 결과</th></tr></thead><tbody>{agentPlan.services.map((service: any) => <tr key={service.serviceId}><td><strong>{service.name || service.serviceId}</strong><p className="muted mono">{service.type}</p></td><td><span className={`badge ${service.eligible ? 'ok' : 'danger'}`}>{service.eligible ? '배포 가능' : '수정 필요'}</span></td><td>{service.findings?.length ? <div className="stack">{service.findings.map((finding: any) => <div key={`${finding.code}:${finding.field || ''}`}><span className={`badge ${finding.severity === 'critical' || finding.severity === 'high' ? 'danger' : 'warn'}`}>{finding.severity}</span> <strong className="mono">{finding.code}</strong><p className="muted">{finding.message}</p></div>)}</div> : <span className="muted">발견된 위협 없음</span>}</td></tr>)}</tbody></table> : <div className="empty-state"><strong>점검할 서비스가 없습니다.</strong><a className="btn btn-primary" href={`${base}?view=new-service`}>서비스 만들기</a></div>}
          </section>
          <form method="post" action={apiAction(`/projects/${projectId}/deployment-agent/apply`, state.context)} className="form-surface stack activity-card">
            <input type="hidden" name="_returnTo" value={`${base}?view=deployments`} />
            <input type="hidden" name="deploymentType" value="production" />
            <div><h2>검증된 계획 실행</h2><p className="muted">버튼을 누르는 순간 현재 설정을 다시 검사하고, 통과한 경우에만 운영 배포를 대기열에 넣습니다.</p></div>
            <button className="btn btn-primary" type="submit" disabled={!agentPlan.canApply}>{agentPlan.canApply ? `${agentPlan.deploymentOrder.length}개 서비스 자동 배포` : '보안 문제를 먼저 해결하세요'}</button>
          </form>
        </div> : null}

        {view === 'resources' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>관리형 리소스</h2><div className="inline-actions"><span className="badge ok">{state.resources.length}개</span><a className="btn btn-primary" href={`${base}?view=new-resource`}>리소스 추가</a></div></div>{state.resources.length ? <div className="data-list">{state.resources.map((resource: any) => <a key={resource.id} href={`${base}/resources/${resource.id}/console`}><span><strong>{resource.name}</strong><small>{resource.engine}</small></span><StatusBadge status={resource.status || 'provisioning'} /><span aria-hidden="true">→</span></a>)}</div> : <div className="empty-state"><strong>리소스가 없습니다.</strong><a className="btn btn-primary" href={`${base}?view=new-resource`}>첫 리소스 추가</a></div>}</section> : null}

        {view === 'new-resource' ? <form method="post" action={apiAction(`/projects/${projectId}/resources`, state.context)} className="form-surface stack single-activity activity-card"><input type="hidden" name="_returnTo" value={`${base}?view=resources`} /><div><h2>리소스 추가</h2><p className="muted">관리형 데이터 계층</p></div><div className="form-grid"><label>리소스 이름 <input name="name" placeholder="예: postgres" required /></label><label>엔진 <select name="engine" defaultValue="postgresql"><option value="postgresql">PostgreSQL</option><option value="sqlite">SQLite</option><option value="redis">Redis</option><option value="valkey">Valkey</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option><option value="mongodb">MongoDB</option><option value="object-storage">객체 저장소</option><option value="qdrant">Qdrant</option><option value="nats">NATS</option></select></label></div><div className="workflow-actions"><a className="btn btn-ghost" href={`${base}?view=resources`}>취소</a><button className="btn btn-primary" type="submit">리소스 추가</button></div></form> : null}

        {view === 'environment' ? environmentService ? <section className="environment-console single-activity">
          <div className="environment-service-picker" aria-label="환경 변수를 관리할 서비스">
            <span>서비스</span>
            <div>{state.services.map((service: any) => <a key={service.id} className={String(service.id) === String(environmentService.id) ? 'active' : ''} aria-current={String(service.id) === String(environmentService.id) ? 'page' : undefined} href={`${base}?view=environment&serviceId=${encodeURIComponent(service.id)}`}>{service.name || service.slug || service.id}</a>)}</div>
          </div>
          <div className="environment-layout">
            <section className="console-surface environment-list-panel">
              <div className="card-title"><div><h2>환경 변수</h2><p className="muted">{environmentService.name || '서비스'}에 저장된 값</p></div><span className="badge info">{environmentEntries.length}개</span></div>
              {environmentEntries.length ? <div className="environment-list">{environmentEntries.map((entry: any) => <div key={entry.key}><span><strong className="mono">{entry.key}</strong><small>{entry.source || 'api'} · {entry.isSecret ? '비밀값' : '일반값'}</small></span><code>{entry.isSecret ? (entry.valueMasked || '••••••••') : String(entry.value ?? entry.valueMasked ?? '')}</code><a className="subtle-link" href={`${base}?view=environment&serviceId=${encodeURIComponent(environmentService.id)}&envKey=${encodeURIComponent(entry.key)}`}>수정</a></div>)}</div> : <div className="empty-state"><strong>등록된 환경 변수가 없습니다.</strong><p>아래 폼이나 .env 가져오기로 첫 값을 추가하세요.</p></div>}
            </section>
            <div className="environment-editors">
              <form method="post" action={apiAction(`/projects/${projectId}/services/${environmentService.id}/env`, state.context)} className="form-surface stack">
                <input type="hidden" name="_returnTo" value={`${base}?view=environment&serviceId=${encodeURIComponent(environmentService.id)}`} />
                <div><h2>{editedEnvironment ? '환경 변수 수정' : '환경 변수 추가'}</h2><p className="muted">같은 키를 저장하면 새 값으로 안전하게 교체됩니다.</p></div>
                <label>키 <input name="key" pattern="[A-Za-z_][A-Za-z0-9_]*" defaultValue={editedEnvironment?.key || ''} readOnly={Boolean(editedEnvironment)} placeholder="API_TOKEN" autoComplete="off" required /></label>
                <label>값 <input name="value" type={editedEnvironment?.isSecret ? 'password' : 'text'} defaultValue={editedEnvironment?.isSecret ? '' : editedEnvironment?.value || ''} placeholder={editedEnvironment?.isSecret ? '새 비밀값 입력' : '값 입력'} autoComplete="new-password" required /></label>
                <label className="confirmation-control"><input name="isSecret" type="checkbox" defaultChecked={Boolean(editedEnvironment?.isSecret)} /><span>비밀값으로 암호화하여 저장하고 목록에는 마스킹하기</span></label>
                <div className="inline-actions">{editedEnvironment ? <a className="btn btn-ghost" href={`${base}?view=environment&serviceId=${encodeURIComponent(environmentService.id)}`}>취소</a> : null}<button className="btn btn-primary" type="submit">{editedEnvironment ? '새 값 저장' : '환경 변수 추가'}</button></div>
              </form>
              <form method="post" action={apiAction(`/projects/${projectId}/services/${environmentService.id}/env-file`, state.context)} className="form-surface stack">
                <input type="hidden" name="_returnTo" value={`${base}?view=environment&serviceId=${encodeURIComponent(environmentService.id)}`} />
                <div><h2>.env 텍스트 가져오기</h2><p className="muted">한 줄에 <code>KEY=value</code> 형식으로 붙여 넣으세요. 비밀로 보이는 키는 자동 분류됩니다.</p></div>
                <label>.env 내용 <textarea name="content" rows={8} placeholder={'NODE_ENV=production\nAPI_TOKEN=your-secret'} autoComplete="off" required /></label>
                <button className="btn" type="submit">.env 가져오기</button>
              </form>
            </div>
          </div>
        </section> : <div className="empty-state single-activity"><strong>환경 변수를 연결할 서비스가 없습니다.</strong><a className="btn btn-primary" href={`${base}?view=new-service`}>서비스 만들기</a></div> : null}

        {view === 'logs' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>런타임 로그</h2><span className="badge info">{logService?.name || '서비스'}</span></div>{logService ? <LogViewer rows={runtimeLogs?.body?.logs || []} field="line" empty="표시할 런타임 로그가 없습니다." /> : <p className="muted">서비스 없음</p>}</section> : null}

        {view === 'settings' ? <section className="form-surface danger-zone single-activity activity-card">
          <div><h2>프로젝트 삭제</h2><p className="muted">서비스와 리소스도 삭제됩니다.</p></div>
          {deletionPending ? <div className="empty-state"><StatusBadge status={state.project.status} /><strong>삭제 요청됨</strong></div> : <form method="post" action={apiAction(`/projects/${projectId}`, state.context)} className="stack">
            <input type="hidden" name="_method" value="DELETE" />
            <input type="hidden" name="_returnTo" value={`/org/${orgSlug}/projects`} />
            <label>확인을 위해 <strong>{projectName}</strong> 입력 <input name="_confirmProject" autoComplete="off" pattern={exactPattern(String(projectName))} required /></label>
            <button className="btn btn-danger" type="submit">프로젝트 삭제</button>
          </form>}
        </section> : null}
      </section>
    </ConsoleShell>
  );
}

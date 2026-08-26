import { apiAction, collectLoadIssues, getJson, loadProjectConsole } from '../../../../../lib/api';
import { ConsoleShell, LoadErrorSummary, LogViewer, MetricStrip, SectionNav, StatusBadge } from '../../../../../components/console-ui';

const views = ['overview', 'services', 'new-service', 'edit-service', 'deployments', 'resources', 'new-resource', 'logs', 'settings'] as const;
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
  const logService = state.services[0];
  const runtimeLogs = view === 'logs' && logService
    ? await getJson(`/services/${encodeURIComponent(logService.id)}/logs`, { logs: [] }, state.context)
    : null;
  const loadErrors = runtimeLogs
    ? [...state.loadErrors, ...collectLoadIssues([['런타임 로그', runtimeLogs]])]
    : state.loadErrors;
  const projectName = state.project.name || state.project.slug || projectId;
  const deletionPending = ['DELETE_REQUESTED', 'DELETING'].includes(String(state.project.status || '').toUpperCase());
  const base = `/org/${orgSlug}/projects/${projectId}`;
  const navItems = [
    { id: 'overview', label: '현황', description: '프로젝트 상태', href: `${base}?view=overview` },
    { id: 'services', label: '서비스', description: '실행 단위', href: `${base}?view=services` },
    { id: 'deployments', label: '배포', description: '배포 기록', href: `${base}?view=deployments` },
    { id: 'resources', label: '리소스', description: '데이터 계층', href: `${base}?view=resources` },
    { id: 'logs', label: '로그', description: '실행 기록', href: `${base}?view=logs` },
    { id: 'settings', label: '설정', description: '프로젝트 관리', href: `${base}?view=settings` },
  ];

  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug} projectValue={projectName} projectId={projectId}>
      <section className="page page-focus" data-od-id="project-overview">
        <header className="page-header"><div><h1 className="page-title">{projectName}</h1><p className="page-subtitle">서비스 · 배포 · 리소스</p></div><StatusBadge status={state.project.status || 'healthy'} /></header>
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
          {state.services.length ? <table className="table"><thead><tr><th>이름</th><th>유형</th><th>상태</th><th>소스</th><th>배포</th><th>관리</th></tr></thead><tbody>{state.services.map((service: any) => <tr key={service.id}><td><strong>{service.name || service.slug}</strong><p className="muted">{service.id}</p></td><td className="mono">{service.type || 'web'}</td><td><StatusBadge status={service.status || 'created'} /></td><td className="mono">{service.repoUrl || service.imageUrl || '소스 없음'}</td><td className="table-actions"><form method="post" action={apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)} className="inline-actions"><input type="hidden" name="_returnTo" value={`${base}?view=deployments`} /><input type="hidden" name="deploymentType" value="production" /><button className="btn btn-primary" type="submit">운영 배포</button></form><form method="post" action={apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)} className="inline-actions"><input type="hidden" name="_returnTo" value={`${base}?view=deployments`} /><input type="hidden" name="deploymentType" value="preview" /><button className="btn" type="submit">미리보기</button></form></td><td><a className="btn btn-ghost" href={`${base}?view=edit-service&serviceId=${encodeURIComponent(service.id)}`}>설정</a></td></tr>)}</tbody></table> : <div className="empty-state"><strong>서비스가 없습니다.</strong><a className="btn btn-primary" href={`${base}?view=new-service`}>첫 서비스 만들기</a></div>}
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

        {view === 'resources' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>관리형 리소스</h2><div className="inline-actions"><span className="badge ok">{state.resources.length}개</span><a className="btn btn-primary" href={`${base}?view=new-resource`}>리소스 추가</a></div></div>{state.resources.length ? <div className="data-list">{state.resources.map((resource: any) => <a key={resource.id} href={`${base}/resources/${resource.id}/console`}><span><strong>{resource.name}</strong><small>{resource.engine}</small></span><StatusBadge status={resource.status || 'provisioning'} /><span aria-hidden="true">→</span></a>)}</div> : <div className="empty-state"><strong>리소스가 없습니다.</strong><a className="btn btn-primary" href={`${base}?view=new-resource`}>첫 리소스 추가</a></div>}</section> : null}

        {view === 'new-resource' ? <form method="post" action={apiAction(`/projects/${projectId}/resources`, state.context)} className="form-surface stack single-activity activity-card"><input type="hidden" name="_returnTo" value={`${base}?view=resources`} /><div><h2>리소스 추가</h2><p className="muted">관리형 데이터 계층</p></div><div className="form-grid"><label>리소스 이름 <input name="name" placeholder="예: postgres" required /></label><label>엔진 <select name="engine" defaultValue="postgresql"><option value="postgresql">PostgreSQL</option><option value="sqlite">SQLite</option><option value="redis">Redis</option><option value="valkey">Valkey</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option><option value="mongodb">MongoDB</option><option value="object-storage">객체 저장소</option><option value="qdrant">Qdrant</option><option value="nats">NATS</option></select></label></div><div className="workflow-actions"><a className="btn btn-ghost" href={`${base}?view=resources`}>취소</a><button className="btn btn-primary" type="submit">리소스 추가</button></div></form> : null}

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

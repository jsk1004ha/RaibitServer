import { apiAction, loadProjectConsole } from '../../../../../lib/api';
import { ConsoleShell, MetricStrip, StatusBadge } from '../../../../../components/console-ui';
import { LoadErrorSummary } from '../../../../../components/console-ui';

export default async function ProjectDetailPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const state = await loadProjectConsole(projectId);
  const projectName = state.project.name || state.project.slug || projectId;
  return (
    <ConsoleShell active="projects" orgValue={orgSlug} projectValue={projectName} crumbs={`${orgSlug} / ${projectName} / 개요`} actions={<><a className="btn" href="#services">새 서비스</a>{state.services.length ? <button className="btn btn-primary" type="submit" form="deploy-first-service">배포</button> : <a className="btn btn-primary" href="#services">서비스 먼저 만들기</a>}</>}>
      <section className="page" data-od-id="project-overview">
        <header className="page-header">
          <div><p className="eyebrow">프로젝트 콘솔</p><h1 className="page-title">{projectName}</h1><p className="page-subtitle">서비스, 배포, 리소스 현황을 확인하고 세부 운영 화면으로 이동하세요.</p></div>
          <StatusBadge status={state.project.status || 'healthy'} />
        </header>

        <LoadErrorSummary issues={state.loadErrors} />

        <ol className="tabs" aria-label="프로젝트 영역" style={{ listStyle: 'none', paddingLeft: 0 }}>
          <li><a className="tab active" aria-current="location" href="#overview">개요</a></li>
          <li><a className="tab" href="#services">서비스</a></li>
          <li><a className="tab" href="#deployments">배포</a></li>
          <li><a className="tab" href="#resources">리소스</a></li>
          <li><span className="tab tab-disabled" aria-disabled="true">도메인 · 준비 중</span></li>
          <li><span className="tab tab-disabled" aria-disabled="true">환경 변수 · 준비 중</span></li>
          <li><span className="tab tab-disabled" aria-disabled="true">감사 · 준비 중</span></li>
          <li><span className="tab tab-disabled" aria-disabled="true">설정 · 준비 중</span></li>
        </ol>

        <div id="overview" className="section-anchor">
          <MetricStrip items={[
            { label: '서비스', value: state.services.length, detail: '웹, 워커, 예약·일회성 작업', tone: 'ok' },
            { label: '리소스', value: state.resources.length, detail: '관리형 카탈로그', tone: 'info' },
            { label: '배포', value: state.deployments.length, detail: `미리보기 ${state.previewDeployments.length}개`, tone: 'warn' },
          ]} />
        </div>

        <section className="dashboard-grid">
          <article className="stack">
            <section className="card section-anchor" id="services">
              <div className="card-title"><h2>서비스 만들기</h2><span className="badge info">Dockerfile 우선</span></div>
              <form method="post" action={apiAction(`/projects/${projectId}/services`, state.context)} className="form-grid">
                <label>서비스 이름 <input name="name" placeholder="예: web" required /></label>
                <label>서비스 유형 <select name="type" defaultValue="web"><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></select></label>
                <label>소스 유형 <select name="sourceType" defaultValue="github"><option value="github">GitHub / Git 소스</option><option value="image">빌드된 이미지</option><option value="local">로컬 Dockerfile</option></select></label>
                <label>저장소 URL <input name="repoUrl" placeholder="https://github.com/org/repo.git" /></label>
                <label>브랜치 <input name="branch" placeholder="main" /></label>
                <label>이미지 <input name="imageUrl" placeholder="registry.example.com/team/web:tag" /></label>
                <label>Dockerfile 경로 <input name="dockerfilePath" placeholder="Dockerfile" /></label>
                <label>빌드 컨텍스트 <input name="buildContext" placeholder="." /></label>
                <button type="submit">서비스 만들기</button>
              </form>
            </section>

            <section className="card">
              <div className="card-title"><h2>서비스와 배포</h2><a className="btn btn-ghost" href="#deployments">배포 내역</a></div>
              <table className="table"><thead><tr><th>이름</th><th>유형</th><th>상태</th><th>소스</th><th>작업</th></tr></thead><tbody>
                {state.services.map((service: any, index: number) => (
                  <tr key={service.id}><td><strong>{service.name || service.slug}</strong><p className="muted">{service.id}</p></td><td className="mono">{service.type || 'web'}</td><td><StatusBadge status={service.status || 'created'} /></td><td className="mono">{service.repoUrl || service.imageUrl || '소스 없음'}</td><td className="table-actions"><form id={index === 0 ? 'deploy-first-service' : undefined} method="post" action={apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)} className="inline-actions"><input type="hidden" name="deploymentType" value="production" /><button type="submit">운영 환경에 배포</button></form><form method="post" action={apiAction(`/projects/${projectId}/services/${service.id}/deployments`, state.context)} className="inline-actions" style={{ marginTop: 8 }}><input type="hidden" name="deploymentType" value="preview" /><button type="submit">미리보기 만들기</button></form></td></tr>
                ))}
              </tbody></table>
            </section>

            <section className="card section-anchor" id="deployments">
              <div className="card-title"><h2>배포 내역</h2><span className="badge info">로그와 이벤트</span></div>
              {state.deployments.length ? <table className="table"><tbody>{state.deployments.map((deployment: any) => <tr key={deployment.id}><td>{deployment.serviceName}</td><td>{deployment.deploymentType}</td><td><StatusBadge status={deployment.status} /></td><td className="mono">{deployment.imageDigest || deployment.imageUrl || '이미지 대기 중'}</td><td>{deployment.errorCode || deployment.errorMessage || '오류 없음'}</td><td><a className="subtle-link" href={`/org/${orgSlug}/projects/${projectId}/deployments/${deployment.id}`}>빌드 로그·배포 이벤트 상세 화면에서 불러오기</a></td></tr>)}</tbody></table> : <p className="muted">아직 배포가 없습니다.</p>}
              <h3 style={{ marginTop: 18 }}>미리보기 배포</h3>
              {state.previewDeployments.length ? <ul>{state.previewDeployments.map((deployment: any) => <li key={deployment.id}><a className="subtle-link" href={`/org/${orgSlug}/projects/${projectId}/deployments/${deployment.id}`}>{deployment.serviceName} PR #{deployment.pullRequestNumber || 'manual'} · {deployment.status}</a></li>)}</ul> : <p className="muted">미리보기 배포가 없습니다.</p>}
            </section>
          </article>

          <aside className="stack">
            <section className="card section-anchor" id="resources">
              <div className="card-title"><h2>리소스 추가</h2><span className="badge ok">카탈로그</span></div>
              <form method="post" action={apiAction(`/projects/${projectId}/resources`, state.context)} className="stack">
                <label>리소스 이름 <input name="name" placeholder="예: postgres" required /></label>
                <label>엔진 <select name="engine" defaultValue="postgresql"><option value="postgresql">PostgreSQL</option><option value="sqlite">SQLite</option><option value="redis">Redis</option><option value="valkey">Valkey</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option><option value="mongodb">MongoDB</option><option value="object-storage">객체 저장소</option><option value="qdrant">Qdrant</option><option value="nats">NATS</option></select></label>
                <button type="submit">리소스 추가</button>
              </form>
            </section>
            <section className="card">
              <div className="card-title"><h2>관리형 리소스</h2><span className="badge ok">공급자 관리</span></div>
              <p className="muted">스키마, 데이터 탐색, /console/query 작업은 리소스 상세 화면의 /console/schema 경로에서 필요한 때만 불러옵니다.</p>
              <div className="stack" style={{ marginTop: 12 }}>{state.resources.map((resource: any) => <article key={resource.id} className="card"><div className="card-title"><h2>{resource.name}</h2><StatusBadge status={resource.status || 'provisioning'} /></div><p className="mono muted">{resource.engine}</p><a className="subtle-link" href={`/org/${orgSlug}/projects/${projectId}/resources/${resource.id}/console`}>리소스 콘솔 상세 화면에서 불러오기</a></article>)}</div>
            </section>
            <section className="card danger-zone"><div className="card-title"><h2>위험 영역</h2><span className="badge danger">감사 로그 필수</span></div><p className="muted">프로젝트 삭제, 운영 배포 되돌리기, 보안 정보 교체에는 확인 문구와 감사 로그가 필요합니다.</p></section>
          </aside>
        </section>

        <section className="grid grid-3" style={{ marginTop: 16 }}>
          <article className="card"><div className="card-title"><h2>빌드 로그</h2><span className="badge info">필요할 때</span></div><p className="muted">선택한 배포의 마스킹된 로그를 상세 화면에서 불러오기</p></article>
          <article className="card"><div className="card-title"><h2>배포 이벤트</h2><span className="badge info">필요할 때</span></div><p className="muted">선택한 배포의 이벤트를 상세 화면에서 불러오기</p></article>
          <article className="card"><div className="card-title"><h2>런타임 로그</h2><span className="badge info">준비 중</span></div><p className="muted" role="status">서비스별 런타임 로그 화면은 준비 중입니다. 현재는 배포 상세 화면에서 빌드 로그와 이벤트를 확인하세요.</p></article>
        </section>
      </section>
    </ConsoleShell>
  );
}

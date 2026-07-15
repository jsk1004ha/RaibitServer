import { apiAction } from '../../../../../lib/api';
import { ConsoleShell } from '../../../../../components/console-ui';

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return (
    <ConsoleShell active="create-project" orgValue={orgSlug} crumbs={`${orgSlug} / 프로젝트 만들기`}>
      <section className="page" data-od-id="create-project">
        <header className="page-header"><div><p className="eyebrow">새 프로젝트</p><h1 className="page-title">프로젝트 만들기</h1><p className="page-subtitle">소스와 첫 서비스를 정하고 필요한 관리형 리소스를 선택하세요.</p></div><span className="badge info">3단계</span></header>
        <div className="dashboard-grid">
          <form method="post" action={apiAction('/projects')} className="card stack">
            <input type="hidden" name="_returnTo" value={`/org/${orgSlug}/projects`} />
            <ol className="tabs" aria-label="프로젝트 만들기 단계" style={{ listStyle: 'none', paddingLeft: 0 }}><li className="tab active">1 소스</li><li className="tab">2 서비스</li><li className="tab">3 리소스</li></ol>
            <section className="stack">
              <div className="card-title"><h2>프로젝트와 소스</h2><span className="badge info">필수</span></div>
              <div className="form-grid">
                <label>프로젝트 이름 <input name="name" required placeholder="동아리 웹사이트" /></label>
                <label>슬러그 <input name="slug" placeholder="club-website" /></label>
                <label>조직 <input value={orgSlug} readOnly aria-describedby="organization-scope-note" /></label>
                <p className="muted" id="organization-scope-note">실제 조직 권한은 로그인한 계정에서 확인합니다.</p>
                <label>저장소 URL <input name="repoUrl" placeholder="https://github.com/rabbit-club/club-api" /></label>
                <label>브랜치 <input name="branch" defaultValue="main" /></label>
                <label>소스 유형 <select name="sourceType" defaultValue="github"><option value="github">GitHub / Git 저장소</option><option value="image">빌드된 이미지</option><option value="local">로컬 Dockerfile</option></select></label>
              </div>
            </section>
            <section className="stack">
              <div className="card-title"><h2>첫 서비스</h2><span className="badge ok">컨테이너</span></div>
              <div className="form-grid">
                <label>서비스 이름 <input name="serviceName" defaultValue="web" required /></label>
                <label>서비스 유형 <select name="type" defaultValue="web"><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></select></label>
                <label>이미지 <input name="image" placeholder="registry.example.com/team/web:tag" /></label>
                <label>Dockerfile 경로 <input name="dockerfilePath" placeholder="Dockerfile" /></label>
                <label>빌드 컨텍스트 <input name="buildContext" defaultValue="." /></label>
              </div>
            </section>
            <section className="stack">
              <div className="card-title"><h2>관리형 리소스</h2><span className="badge info">선택</span></div>
              <div className="form-grid">
                <label>데이터베이스 <select name="database" defaultValue="none"><option value="none">추가 안 함</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></select></label>
                <label>캐시 <select name="cache" defaultValue="none"><option value="none">추가 안 함</option><option value="redis">Redis</option><option value="valkey">Valkey</option></select></label>
              </div>
            </section>
            <p className="callout">연결 보안 정보는 서비스 환경 변수에 마스킹된 값으로 연결되며 원문은 콘솔에 표시하지 않습니다.</p>
            <div className="toolbar"><a className="btn" href={`/org/${orgSlug}/projects`}>취소</a><button type="submit">프로젝트 만들기</button></div>
          </form>
          <aside className="stack">
            <article className="card"><h2>생성될 원하는 상태</h2><p className="muted" style={{ marginTop: 8 }}>제출 전에 프로젝트 구성을 확인하세요.</p><pre className="code-panel" style={{ padding: 12, marginTop: 12 }}>project: club-api{`\n`}services:{`\n`}  - web: Dockerfile{`\n`}resources:{`\n`}  - postgresql{`\n`}  - redis{`\n`}security:{`\n`}  nonRoot: true{`\n`}  networkPolicy: default</pre></article>
            <article className="card"><div className="card-title"><h2>할당량 미리보기</h2><span className="badge warn">주의</span></div><p className="muted">프로젝트 8/10 · 서비스 15/20 · DB 저장소 4.2GB/10GB</p><div className="meter" style={{ '--value': '42%', marginTop: 12 } as any}><span></span></div></article>
          </aside>
        </div>
      </section>
    </ConsoleShell>
  );
}

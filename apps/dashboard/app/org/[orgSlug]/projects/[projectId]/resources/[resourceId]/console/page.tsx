import { apiAction, loadResourceConsole } from '../../../../../../../../lib/api';
import { ConsoleShell, JsonCard, MetricCard, StatusBadge } from '../../../../../../../../components/console-ui';

const ENGINE_COMMANDS: Record<string, { query: string; command: string; help: string }> = {
  postgresql: { query: 'SELECT 1', command: 'SELECT 1', help: 'SQL 쿼리, 스키마·테이블 탐색, 백업·복원 명령을 지원합니다' },
  sqlite: { query: 'SELECT 1', command: 'PRAGMA table_info(health)', help: '공급자 소유 파일에서 SQLite 쿼리와 테이블 탐색을 지원합니다' },
  mysql: { query: 'SELECT 1', command: 'SHOW TABLES', help: 'MySQL 쿼리와 mysqldump 명령을 지원합니다' },
  mariadb: { query: 'SELECT 1', command: 'SHOW TABLES', help: 'MariaDB 호환 SQL 콘솔을 제공합니다' },
  mongodb: { query: 'db.health.find({})', command: 'db.getCollectionNames()', help: 'Mongo 컬렉션과 문서를 탐색합니다' },
  redis: { query: 'SCAN 0 MATCH * COUNT 100', command: 'GET health:ready', help: 'Redis 키, 값, TTL을 탐색합니다' },
  valkey: { query: 'SCAN 0 MATCH * COUNT 100', command: 'TTL health:ready', help: 'Valkey 키, 값, TTL을 탐색합니다' },
  'object-storage': { query: 'LIST objects', command: 'mc ls', help: '버킷과 객체의 조회·업로드·다운로드·삭제 명령을 지원합니다' },
  qdrant: { query: 'GET /collections', command: 'search health', help: 'Qdrant 컬렉션 탐색과 검색 확인을 지원합니다' },
  nats: { query: 'subjects', command: 'nats stream ls', help: 'NATS subject와 stream 연결 정보를 확인합니다' },
};

export default async function ResourceConsolePage({ params }: { params: Promise<{ orgSlug: string; projectId: string; resourceId: string }> }) {
  const { orgSlug, projectId, resourceId } = await params;
  const state = await loadResourceConsole(resourceId);
  const resource = state.resource || { id: resourceId, engine: 'resource' };
  const engine = String(resource.engine || '').toLowerCase();
  const defaults = ENGINE_COMMANDS[engine] || { query: 'SELECT 1', command: 'browse', help: '공급자 소유 콘솔 어댑터를 사용합니다' };
  return (
    <ConsoleShell active="projects" orgValue={orgSlug} projectValue={projectId} crumbs={`${projectId} / 리소스 / ${resource.name || resourceId}`} actions={<><a className="btn" href={`/org/${orgSlug}/projects/${projectId}`}>프로젝트 콘솔</a><button className="btn btn-danger" type="button" disabled aria-describedby="credential-rotation-note" title="공급자 교체 API 준비 중">자격 증명 교체</button><span className="muted" id="credential-rotation-note">공급자 교체 API 준비 중</span></>}>
      <section className="page" data-od-id="resource-console">
        <header className="page-header"><div><p className="eyebrow">{resource.name || resourceId}</p><h1 className="page-title">리소스 콘솔</h1><p className="page-subtitle">{defaults.help}. 실행에는 공급자 소유 보안 정보만 사용하며 사용자가 입력한 연결 URL은 반영하지 않습니다.</p></div><StatusBadge status={resource.status || 'provisioning'} /></header>
        <section className="grid grid-3">
          <MetricCard title="엔진" value={engine || 'resource'} detail={`공급자 ${resource.provider || 'managed'}`} />
          <MetricCard title="연결된 서비스" value={(resource.attachedServices || []).length || 0} detail="마스킹된 환경 변수 주입" tone="ok" />
          <article className="card"><p className="label">연결</p><h2 className="mono">{state.schema?.connectionInfo?.databaseUrl || state.browse?.connectionInfo?.databaseUrl || 'provider-owned-secret'}</h2><p className="muted">보안 정보 값은 마스킹됩니다.</p></article>
        </section>
        <nav className="tabs" aria-label="리소스 콘솔 영역"><a className="tab active" href="#schema">스키마</a><a className="tab" href="#query">쿼리</a><a className="tab" href="#backups">백업</a><a className="tab" href="#connection">연결</a></nav>
        <section className="dashboard-grid">
          <article className="card" id="query">
            <div className="card-title"><h2>쿼리</h2><span className="badge info">엔진별 기본값</span></div>
            <form method="post" action={apiAction(`/resources/${resourceId}/console/query`, state.context)} className="stack">
              <label className="field"><span className="label">조회·탐색 쿼리</span><textarea name="query" defaultValue={defaults.query} rows={5} className="textarea mono" /></label>
              <label><span><input type="checkbox" name="confirmed" value="true" /> 파괴적 쿼리 실행 확인</span></label>
              <button type="submit">쿼리 실행</button>
            </form>
            {/* GET /console/tables /console/keys /console/collections */}
          </article>
          <aside className="stack">
            <form id="provider-command" method="post" action={apiAction(`/resources/${resourceId}/console/command`, state.context)} className="card danger-zone">
              <h2>공급자 명령</h2><label>명령 <input name="command" defaultValue={defaults.command} /></label><label><span><input type="checkbox" name="confirmed" value="true" /> 변경·삭제 명령 실행 확인</span></label><button type="submit">공급자 명령 실행</button>
            </form>
            <section className="card" id="backups"><div className="card-title"><h2>백업</h2><span className="badge info">준비 중</span></div><p className="muted">백업 API 준비 중입니다. 공급자 백업 기능이 연결되면 이 영역에서 실행 내역을 확인할 수 있습니다.</p></section>
            <form id="provisioning" method="post" action={apiAction(`/resources/${resourceId}/provision`, state.context)} className="card"><h2>프로비저닝 계획</h2><input type="hidden" name="dryRun" value="true" /><button type="submit">프로비저닝 계획 만들기</button></form>
            <form id="connection" method="post" action={apiAction(`/resources/${resourceId}/attach`, state.context)} className="card"><h2>서비스 연결</h2><label>서비스 ID <input name="serviceId" placeholder="service id" required /></label><label>환경 변수 접두사 <input name="envPrefix" placeholder="선택 사항: ENV_PREFIX" /></label><button type="submit">서비스에 연결</button></form>
          </aside>
        </section>
        <section className="grid grid-3" id="schema" style={{ marginTop: 13 }}>
          <JsonCard title="마스킹된 연결 정보" value={state.schema?.connectionInfo || state.browse?.connectionInfo || { mode: 'provider-owned-secret' }} />
          <JsonCard title="스키마" value={state.schema} />
          <JsonCard title="테이블" value={state.tables} />
          <JsonCard title="컬렉션" value={state.collections} />
          <JsonCard title="키 / TTL" value={state.keys} />
          <JsonCard title="버킷 / 객체 / Subject" value={state.browse} />
        </section>
      </section>
    </ConsoleShell>
  );
}

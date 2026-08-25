import { apiAction, loadResourceConsole } from '../../../../../../../../lib/api';
import { ConsoleShell, JsonCard, LoadErrorSummary, MetricStrip, SectionNav, StatusBadge } from '../../../../../../../../components/console-ui';

const ENGINE_COMMANDS: Record<string, { query: string; command: string }> = {
  postgresql: { query: 'SELECT 1', command: 'SELECT 1' },
  sqlite: { query: 'SELECT 1', command: 'PRAGMA table_info(health)' },
  mysql: { query: 'SELECT 1', command: 'SHOW TABLES' },
  mariadb: { query: 'SELECT 1', command: 'SHOW TABLES' },
  mongodb: { query: 'db.health.find({})', command: 'db.getCollectionNames()' },
  redis: { query: 'SCAN 0 MATCH * COUNT 100', command: 'GET health:ready' },
  valkey: { query: 'SCAN 0 MATCH * COUNT 100', command: 'TTL health:ready' },
  'object-storage': { query: 'LIST objects', command: 'mc ls' },
  qdrant: { query: 'GET /collections', command: 'search health' },
  nats: { query: 'subjects', command: 'nats stream ls' },
};

const views = ['overview', 'schema', 'query', 'provider', 'backups', 'provision', 'connection'] as const;
type ResourceView = typeof views[number];

export default async function ResourceConsolePage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string; resourceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ orgSlug, projectId, resourceId }, queryParams] = await Promise.all([params, searchParams]);
  const requestedView = String(queryParams.view || 'overview');
  const view: ResourceView = views.includes(requestedView as ResourceView) ? requestedView as ResourceView : 'overview';
  const state = await loadResourceConsole(resourceId, view);
  const resource = state.resource || { id: resourceId, engine: 'resource' };
  const engine = String(resource.engine || '').toLowerCase();
  const defaults = ENGINE_COMMANDS[engine] || { query: 'SELECT 1', command: 'browse' };
  const base = `/org/${orgSlug}/projects/${projectId}/resources/${resourceId}/console`;
  const navItems = [
    { id: 'overview', label: '개요', description: '상태 요약', href: `${base}?view=overview` },
    { id: 'schema', label: '데이터 구조', description: '테이블·키', href: `${base}?view=schema` },
    { id: 'query', label: '쿼리', description: '데이터 조회', href: `${base}?view=query` },
    { id: 'connection', label: '연결', description: '서비스 연결', href: `${base}?view=connection` },
    { id: 'backups', label: '백업', description: '복구 지점', href: `${base}?view=backups` },
    { id: 'provision', label: '프로비저닝', description: '변경 계획', href: `${base}?view=provision` },
    { id: 'provider', label: '고급 명령', description: '직접 관리', href: `${base}?view=provider` },
  ];
  const connectionValue = state.schema?.connectionInfo?.databaseUrl || state.browse?.connectionInfo?.databaseUrl || 'provider-owned-secret';
  const engineLabel = engine === 'resource' || !engine ? '리소스' : engine;
  const providerLabel = resource.provider === 'managed' || !resource.provider ? '관리형' : resource.provider;
  const statusLabel = resource.status === 'provisioning' || !resource.status ? '준비 중' : resource.status;
  const connectionLabel = connectionValue === 'provider-owned-secret' ? '공급자 보안 연결' : connectionValue;

  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug} projectValue={projectId} projectId={projectId}>
      <section className="page page-focus" data-od-id="resource-console">
        <header className="page-header"><div><h1 className="page-title">{resource.name || '리소스 콘솔'}</h1><p className="page-subtitle">상태 · 데이터 · 연결</p></div><div className="page-header-actions"><StatusBadge status={resource.status || 'provisioning'} /><a className="btn" href={`/org/${orgSlug}/projects/${projectId}?view=resources`}>리소스 목록</a></div></header>
        <LoadErrorSummary issues={state.loadErrors} />
        <SectionNav items={navItems} current={view} label="리소스 콘솔 화면" />

        {view === 'overview' ? <section className="resource-overview"><MetricStrip items={[{ label: '엔진', value: engineLabel, detail: providerLabel, tone: 'info' }, { label: '상태', value: statusLabel, detail: '공급자 동기화', tone: 'ok' }, { label: '연결 서비스', value: (resource.attachedServices || []).length || 0, detail: '환경 변수 연결', tone: 'warn' }]} /><div className="console-surface resource-overview-grid"><section className="resource-overview-panel"><div className="card-title"><h2>리소스 정보</h2><StatusBadge status={resource.status || 'provisioning'} /></div><dl><div><dt>이름</dt><dd>{resource.name || resourceId}</dd></div><div><dt>공급자</dt><dd>{providerLabel}</dd></div><div><dt>연결 방식</dt><dd>{connectionLabel}</dd></div></dl></section><section className="resource-overview-panel resource-next-steps"><div className="card-title"><h2>빠른 시작</h2><a className="subtle-link" href="/guide?topic=resources">사용 안내 →</a></div><a href={`${base}?view=schema`}><span><strong>데이터 구조</strong><small>테이블·키</small></span><i>→</i></a><a href={`${base}?view=query`}><span><strong>쿼리 실행</strong><small>데이터 조회</small></span><i>→</i></a><a href={`${base}?view=connection`}><span><strong>서비스 연결</strong><small>환경 변수</small></span><i>→</i></a></section></div><div className="resource-security-row"><span><strong>보안 연결</strong><small>자격 증명 마스킹</small></span><code>{connectionLabel}</code></div></section> : null}
        {view === 'schema' ? <section className="console-surface single-activity activity-card stack"><div><h2>데이터 구조</h2><p className="muted">테이블 · 컬렉션 · 키</p></div><JsonCard title="구조 데이터" value={{ connection: state.schema?.connectionInfo || state.browse?.connectionInfo || { mode: 'provider-owned-secret' }, schema: state.schema, tables: state.tables, collections: state.collections, keys: state.keys, browse: state.browse }} />{/* GET /console/tables /console/keys /console/collections */}</section> : null}
        {view === 'query' ? <form method="post" action={apiAction(`/resources/${resourceId}/console/query`, state.context)} className="form-surface stack single-activity activity-card"><input type="hidden" name="_returnTo" value={`${base}?view=query`} /><div><h2>쿼리</h2><p className="muted">읽기 · 탐색</p></div><label className="field"><span className="label">쿼리</span><textarea name="query" defaultValue={defaults.query} rows={8} className="textarea mono" /></label><label className="confirmation-control"><input type="checkbox" name="confirmed" value="true" /><span>변경 쿼리 확인</span></label><button className="btn btn-primary" type="submit">쿼리 실행</button></form> : null}
        {view === 'provider' ? <form id="provider-command" method="post" action={apiAction(`/resources/${resourceId}/console/command`, state.context)} className="form-surface danger-zone stack single-activity activity-card"><input type="hidden" name="_returnTo" value={`${base}?view=provider`} /><div><h2>공급자 명령</h2><p className="muted">고급 관리</p></div><label>명령 <input name="command" defaultValue={defaults.command} /></label><label className="confirmation-control"><input type="checkbox" name="confirmed" value="true" required /><span>변경·삭제 확인</span></label><button className="btn btn-danger" type="submit">공급자 명령 실행</button></form> : null}
        {view === 'backups' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>백업</h2><span className="badge info">준비 중</span></div><p className="muted">복구 지점 준비 중</p></section> : null}
        {view === 'provision' ? <form id="provisioning" method="post" action={apiAction(`/resources/${resourceId}/provision`, state.context)} className="form-surface stack single-activity activity-card"><input type="hidden" name="_returnTo" value={`${base}?view=provision`} /><div><h2>프로비저닝</h2><p className="muted">변경 계획</p></div><input type="hidden" name="dryRun" value="true" /><button className="btn btn-primary" type="submit">계획 만들기</button></form> : null}
        {view === 'connection' ? <section className="form-surface stack single-activity activity-card"><div><h2>서비스 연결</h2><p className="muted">환경 변수 연결</p></div><form id="connection" method="post" action={apiAction(`/resources/${resourceId}/attach`, state.context)} className="stack"><input type="hidden" name="_returnTo" value={`${base}?view=connection`} /><label>서비스 ID <input name="serviceId" placeholder="service id" required /></label><label>환경 변수 접두사 <input name="envPrefix" placeholder="선택 사항: ENV_PREFIX" /></label><button className="btn btn-primary" type="submit">서비스에 연결</button></form></section> : null}
      </section>
    </ConsoleShell>
  );
}

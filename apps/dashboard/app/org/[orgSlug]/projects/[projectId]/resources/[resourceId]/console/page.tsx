import { apiAction, loadResourceConsole } from '../../../../../../../../lib/api';
import { ConsoleShell, LoadErrorSummary, MetricStrip, SectionNav, StatusBadge } from '../../../../../../../../components/console-ui';
import { ResourceQueryConsole } from '../../../../../../../../components/resource-query-console';
import { ResourceProvisionActions } from '@/components/resource-provision-actions';
import { OperationSubmit } from '@/components/operation-submit';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

function isResourceView(value: string): value is ResourceView {
  return views.some((view) => view === value);
}

type StructureRow = {
  readonly kind: string;
  readonly name: string;
  readonly detail: string;
};

function structureRows(kind: string, value: unknown): readonly StructureRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === 'string') return { kind, name: entry, detail: '—' };
    if (!entry || typeof entry !== 'object') return { kind, name: `${kind} ${index + 1}`, detail: String(entry ?? '—') };
    const values: ReadonlyMap<string, unknown> = new Map(Object.entries(entry));
    const name = ['name', 'tableName', 'collectionName', 'key', 'id']
      .map((key) => values.get(key))
      .find((candidate) => typeof candidate === 'string' || typeof candidate === 'number');
    const detail = ['type', 'dataType', 'namespace', 'description']
      .map((key) => values.get(key))
      .find((candidate) => typeof candidate === 'string' || typeof candidate === 'number');
    return {
      kind,
      name: String(name ?? `${kind} ${index + 1}`),
      detail: String(detail ?? JSON.stringify(entry)),
    };
  });
}

export default async function ResourceConsolePage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string; resourceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ orgSlug, projectId, resourceId }, queryParams] = await Promise.all([params, searchParams]);
  const requestedView = String(queryParams.view || 'overview');
  const view: ResourceView = isResourceView(requestedView) ? requestedView : 'overview';
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
  const connectionLabel = connectionValue === 'provider-owned-secret' ? '공급자 보안 연결' : '마스킹된 보안 연결';
  const rows = [
    ...structureRows('테이블', state.tables?.tables || state.tables),
    ...structureRows('컬렉션', state.collections?.collections || state.collections),
    ...structureRows('키', state.keys?.keys || state.keys),
  ];
  const schemaDocument = state.schema?.schema && typeof state.schema.schema === 'object' && !Array.isArray(state.schema.schema)
    ? Object.fromEntries(Object.entries(state.schema.schema).filter(([key]) => key !== 'connectionInfo'))
    : {};

  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug} projectValue={projectId} projectId={projectId}>
      <section className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-6 md:px-6 md:py-8" data-od-id="resource-console">
        <header className="flex min-w-0 flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0"><p className="mb-1 text-xs font-medium text-muted-foreground">리소스 ID · <span className="break-all font-mono">{resourceId}</span></p><h1 className="break-words text-3xl leading-tight font-medium tracking-tight text-foreground">{resource.name || '리소스 콘솔'}</h1><p className="mt-2 text-sm text-muted-foreground">데이터 구조, 쿼리와 서비스 연결을 관리합니다.</p></div>
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={resource.status || 'provisioning'} /><a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={`/org/${orgSlug}/projects/${projectId}?view=resources`}>리소스 목록</a></div>
        </header>
        <LoadErrorSummary issues={state.loadErrors} />
        <SectionNav items={navItems} current={view} label="리소스 콘솔 화면" />

        {view === 'overview' ? <section className="resource-overview flex min-w-0 flex-col gap-4"><MetricStrip items={[{ label: '엔진', value: engineLabel, detail: providerLabel, tone: 'info' }, { label: '상태', value: statusLabel, detail: '공급자 동기화', tone: 'ok' }, { label: '연결 서비스', value: (resource.attachedServices || []).length || 0, detail: '환경 변수 연결', tone: 'warn' }]} /><div className="resource-overview-grid grid min-w-0 gap-4 lg:grid-cols-2"><Card><CardHeader className="border-b"><CardTitle><h2>리소스 정보</h2></CardTitle><CardDescription>공급자에서 동기화한 읽기 전용 상태입니다.</CardDescription><CardAction><StatusBadge status={resource.status || 'provisioning'} /></CardAction></CardHeader><CardContent className="overflow-x-auto px-0"><Table><TableHeader><TableRow><TableHead className="pl-4">항목</TableHead><TableHead>현재 값</TableHead></TableRow></TableHeader><TableBody>{[['이름', resource.name || resourceId], ['공급자', providerLabel], ['연결 방식', connectionLabel]].map(([label, value]) => <TableRow key={label}><TableCell className="pl-4 font-medium">{label}</TableCell><TableCell className="max-w-0 break-all whitespace-normal">{String(value)}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card><Card><CardHeader className="border-b"><CardTitle><h2>빠른 시작</h2></CardTitle><CardDescription>자주 쓰는 운영 화면으로 이동합니다.</CardDescription><CardAction><a className="text-sm underline underline-offset-4" href="/guide?topic=resources">사용 안내</a></CardAction></CardHeader><CardContent className="flex flex-col gap-1">{[['데이터 구조', '테이블·키', 'schema'], ['쿼리 실행', '데이터 조회', 'query'], ['서비스 연결', '환경 변수', 'connection']].map(([label, description, target]) => <a className="flex min-h-12 items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm hover:bg-muted" href={`${base}?view=${target}`} key={target}><span className="min-w-0"><strong className="block font-medium">{label}</strong><small className="text-muted-foreground">{description}</small></span><span aria-hidden="true">→</span></a>)}</CardContent></Card></div><div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"><span><strong className="block text-sm font-medium">보안 연결</strong><small className="text-muted-foreground">자격 증명 마스킹</small></span><code className="break-all text-xs">{connectionLabel}</code></div></section> : null}
        {view === 'schema' ? <section className="flex min-w-0 flex-col gap-4"><Card><CardHeader className="border-b"><CardTitle><h2>데이터 구조</h2></CardTitle><CardDescription>테이블 · 컬렉션 · 키</CardDescription></CardHeader><CardContent className="overflow-x-auto px-0">{rows.length ? <Table><TableHeader><TableRow><TableHead className="pl-4">종류</TableHead><TableHead>이름</TableHead><TableHead>세부 정보</TableHead></TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={`${row.kind}-${row.name}-${index}`}><TableCell className="pl-4">{row.kind}</TableCell><TableCell className="break-all whitespace-normal font-mono text-xs">{row.name}</TableCell><TableCell className="break-all whitespace-normal">{row.detail}</TableCell></TableRow>)}</TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>표시할 데이터 구조가 없습니다.</EmptyTitle><EmptyDescription>공급자가 테이블, 컬렉션 또는 키를 반환하면 여기에 표시됩니다.</EmptyDescription></EmptyHeader></Empty>}</CardContent></Card><Card><CardHeader className="border-b"><CardTitle><h2>구조 데이터</h2></CardTitle><CardDescription>연결 자격 증명을 제외한 공급자 스키마입니다.</CardDescription></CardHeader><CardContent className="code-panel max-h-80 rounded-none border-0 p-4"><pre className="break-all whitespace-pre-wrap font-mono text-xs">{JSON.stringify(schemaDocument, null, 2)}</pre></CardContent></Card>{/* GET /console/tables /console/keys /console/collections */}</section> : null}
        {view === 'query' ? <Card><CardHeader className="border-b"><CardTitle><h2>쿼리</h2></CardTitle><CardDescription>엔진 기본값으로 시작해 읽기 또는 탐색 작업을 실행합니다.</CardDescription></CardHeader><CardContent><ResourceQueryConsole action={apiAction(`/resources/${resourceId}/console/query`, state.context)} defaultQuery={defaults.query} returnTo={`${base}?view=query`} /></CardContent></Card> : null}
        {view === 'provider' ? <Card className="border-destructive/30"><CardHeader className="border-b border-destructive/20 bg-destructive/5"><CardTitle><h2>공급자 명령</h2></CardTitle><CardDescription>변경 또는 삭제를 포함할 수 있는 고급 관리 작업입니다.</CardDescription></CardHeader><CardContent><form id="provider-command" method="post" action={apiAction(`/resources/${resourceId}/console/command`, state.context)}><input type="hidden" name="_returnTo" value={`${base}?view=provider`} /><FieldGroup><Field><FieldLabel htmlFor="provider-command-input">명령</FieldLabel><Input id="provider-command-input" name="command" defaultValue={defaults.command} autoComplete="off" className="font-mono" /><FieldDescription>대상과 명령을 검토한 뒤 명시적으로 확인하세요.</FieldDescription></Field><label className="confirmation-control"><input type="checkbox" name="confirmed" value="true" required /><span>변경·삭제 확인</span></label><button className={buttonVariants({ variant: 'destructive' })} type="submit">공급자 명령 실행</button></FieldGroup></form></CardContent></Card> : null}
        {view === 'backups' ? <section aria-labelledby="backups-heading"><Card><CardHeader className="border-b"><CardTitle><h2 id="backups-heading">백업</h2></CardTitle><CardDescription>공급자가 제공하는 복구 지점</CardDescription></CardHeader><CardContent><Empty><EmptyHeader><EmptyTitle>복구 지점 준비 중</EmptyTitle><EmptyDescription>사용 가능한 백업이 생기면 이 화면에 표시됩니다.</EmptyDescription></EmptyHeader></Empty></CardContent></Card></section> : null}
        {view === 'provision' ? <ResourceProvisionActions action={apiAction(`/resources/${resourceId}/provision`, state.context)} availability={resource.availability} resourceStatus={String(resource.status || '')} returnTo={`${base}?view=provision`} /> : null}
        {view === 'connection' ? <section aria-labelledby="connection-heading"><Card><CardHeader className="border-b"><CardTitle><h2 id="connection-heading">서비스 연결</h2></CardTitle><CardDescription>리소스 연결 정보를 서비스 환경 변수로 연결합니다.</CardDescription></CardHeader><CardContent><OperationSubmit action={apiAction(`/resources/${resourceId}/attach`, state.context)} id="connection" pendingLabel="리소스 연결 요청을 확인하고 있습니다." returnTo={`${base}?view=connection`} submitClassName={buttonVariants()} submitLabel="서비스에 연결"><FieldGroup><Field><FieldLabel htmlFor="service-id">서비스 ID</FieldLabel><Input id="service-id" name="serviceId" placeholder="service id" required autoComplete="off" /></Field><Field><FieldLabel htmlFor="env-prefix">환경 변수 접두사</FieldLabel><Input id="env-prefix" name="envPrefix" placeholder="선택 사항: ENV_PREFIX" autoCapitalize="characters" autoComplete="off" /><FieldDescription>비워 두면 엔진 기본 접두사를 사용합니다.</FieldDescription></Field></FieldGroup></OperationSubmit></CardContent></Card></section> : null}
      </section>
    </ConsoleShell>
  );
}

import { randomUUID } from 'node:crypto';
import { collectLoadIssues, dashboardApiContext, getJson } from '../../../../../../../lib/api';
import { ConsoleShell, LoadErrorSummary, MetricStrip, SectionNav, StatusBadge } from '../../../../../../../components/console-ui';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { decodeDeploymentRouteSegment, encodeDeploymentRouteSegment } from '@/lib/deployment-route-segment';
import { DeploymentRecoveryAction } from '@/components/project-hub/deployment-recovery-action';
import { deploymentHistoryFromDetail } from '@/components/project-hub/deployment-history-model';
import { DeploymentActivityStream } from '@/components/project-hub/deployment-stream';

const views = ['overview', 'logs', 'events'] as const;
type DeploymentView = typeof views[number];

type DeploymentStreamRow = {
  readonly id?: unknown;
  readonly createdAt?: unknown;
  readonly timestamp?: unknown;
  readonly level?: unknown;
  readonly type?: unknown;
  readonly line?: unknown;
  readonly message?: unknown;
};

function isDeploymentView(value: string): value is DeploymentView {
  return views.some((view) => view === value);
}

function DeploymentStream({ rows, field, label, empty }: {
  readonly rows: readonly DeploymentStreamRow[];
  readonly field: 'line' | 'message';
  readonly label: string;
  readonly empty: string;
}) {
  return <div aria-label={label} className="log-viewer max-h-128 rounded-none border-0 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50" role="log" tabIndex={0}>
    {rows.length ? <ol className="divide-y divide-inverse-raised font-mono text-xs">{rows.map((row, index) => {
      const content = field === 'line' ? row.line : row.message;
      return <li className="grid min-w-0 gap-1 px-4 py-3 sm:grid-cols-[8rem_5rem_minmax(0,1fr)] sm:gap-3" key={String(row.id ?? index)}><time className="text-inverse-foreground/70">{String(row.createdAt || row.timestamp || '이벤트')}</time><span className="text-inverse-foreground/80">{String(row.level || row.type || '정보')}</span><span className="min-w-0 break-all whitespace-pre-wrap">{String(content || row.message || row.line || JSON.stringify(row))}</span></li>;
    })}</ol> : <p className="px-4 py-8 text-center text-sm text-inverse-foreground/70">{empty}</p>}
  </div>;
}

export default async function DeploymentDetailPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string; deploymentId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ orgSlug, projectId, deploymentId }, query] = await Promise.all([params, searchParams]);
  const decodedDeploymentId = decodeDeploymentRouteSegment(deploymentId);
  const encodedDeploymentId = encodeDeploymentRouteSegment(deploymentId);
  const requestedView = String(query.view || 'overview');
  const view: DeploymentView = isDeploymentView(requestedView) ? requestedView : 'overview';
  const context = await dashboardApiContext();
  const [deployment, logs, events] = await Promise.all([
    getJson(`/deployments/${encodedDeploymentId}`, { id: decodedDeploymentId, status: 'unknown' }, context),
    view === 'logs'
      ? getJson(`/deployments/${encodedDeploymentId}/logs`, { logs: [] }, context)
      : Promise.resolve({ ok: true, status: 200, body: { logs: [] } }),
    view === 'events'
      ? getJson(`/deployments/${encodedDeploymentId}/events`, { events: [] }, context)
      : Promise.resolve({ ok: true, status: 200, body: { events: [] } }),
  ]);
  const detail = deployment.body || {};
  const history = deploymentHistoryFromDetail(detail);
  const loadErrors = collectLoadIssues([['배포 정보', deployment], ['빌드 로그', logs], ['배포 이벤트', events]]);
  const base = `/org/${orgSlug}/projects/${projectId}/deployments/${encodedDeploymentId}`;
  const navItems = [
    { id: 'overview', label: '개요', description: '상태와 이미지', href: `${base}?view=overview` },
    { id: 'logs', label: '빌드 로그', description: '마스킹된 출력', href: `${base}?view=logs` },
    { id: 'events', label: '배포 이벤트', description: '상태 기록', href: `${base}?view=events` },
  ];

  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug} projectValue={projectId} projectId={projectId}>
      <section className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-6 md:px-6 md:py-8" data-od-id="deployment-detail">
        <header className="flex min-w-0 flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">배포 ID · <span className="break-all font-mono">{decodedDeploymentId}</span></p>
            <h1 className="text-3xl leading-tight font-medium tracking-tight text-foreground">배포 상세</h1>
            <p className="mt-2 text-sm text-muted-foreground">상태, 빌드 출력과 복구 작업을 한곳에서 확인합니다.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={history?.status || 'unknown'} />
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={`/org/${orgSlug}/projects/${projectId}?view=deployments`}>배포 목록</a>
          </div>
        </header>
        <LoadErrorSummary issues={loadErrors} />
        <SectionNav items={navItems} current={view} label="배포 상세 화면" />

        {view === 'overview' ? <div className="flex min-w-0 flex-col gap-4">
          <MetricStrip items={[{ label: '상태', value: history?.status || 'unknown', detail: '서버 확인', tone: 'ok' }, { label: '환경', value: history?.environment || detail.deploymentType || 'unknown', detail: '배포 대상', tone: 'info' }, { label: '실패', value: history?.health.healthFailureCode || detail.errorCode || '없음', detail: detail.errorMessage || '오류 없음', tone: history?.health.healthFailureCode || detail.errorCode || detail.errorMessage ? 'danger' : 'ok' }]} />
          <Card>
            <CardHeader className="border-b"><CardTitle><h2>이미지 정보</h2></CardTitle><CardDescription>상태는 빌더와 오케스트레이터가 갱신합니다.</CardDescription><CardAction><span className="text-xs text-muted-foreground">워커 관리</span></CardAction></CardHeader>
            <CardContent className="overflow-x-auto px-0">
              <Table>
                <TableHeader><TableRow><TableHead className="pl-4">항목</TableHead><TableHead>현재 값</TableHead></TableRow></TableHeader>
                <TableBody>
                  {[
                    ['소스 커밋', history?.source.commitSha || '대기 중'],
                    ['이미지 다이제스트', history?.source.imageDigest || detail.imageDigest || '대기 중'],
                    ['스냅샷 버전', history?.source.snapshotVersion ?? '대기 중'],
                    ['요청 실행자', history?.operation.requestedByUserId || '기록 없음'],
                    ['재시도 계보', history?.lineage.retryOfDeploymentId || history?.lineage.rollbackOfDeploymentId || history?.lineage.sourceDeploymentId || '없음'],
                    ['롤아웃 상태', history?.health.rolloutStatus || '기록 없음'],
                    ['공개 헬스', history?.health.publicHealthStatus || '기록 없음'],
                    ['이미지 URL', detail.imageUrl || '대기 중'],
                    ['실패', detail.errorCode || detail.errorMessage || '없음'],
                  ].map(([label, value]) => <TableRow key={label}><TableCell className="pl-4 font-medium">{label}</TableCell><TableCell className="max-w-0 break-all whitespace-normal font-mono text-xs">{String(value)}</TableCell></TableRow>)}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="border-b"><CardTitle><h2>복구 및 재실행</h2></CardTitle><CardDescription>표시되는 상태는 서버가 확인한 값입니다. 요청 직후 완료 상태를 추정하지 않습니다.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-raibit-lg">
              {history?.permissions.execute && history.eligibleAction ? <DeploymentRecoveryAction action={history.eligibleAction} idempotencyKey={history.eligibleAction.type === 'retry' || history.eligibleAction.type === 'redeploy' ? randomUUID() : null} returnTo={`${base}?view=overview`} /> : <p className="text-sm text-muted-foreground">{history?.permissions.execute ? history.recovery.reason || '현재 서버 상태에서는 안전한 복구 작업을 요청할 수 없습니다.' : '이 배포에 대한 실행 권한이 없습니다.'}</p>}
              <DeploymentActivityStream initialStatus={history?.status} streamHref={`/api/control/deployments/${encodedDeploymentId}/stream`} />
            </CardContent>
          </Card>
        </div> : null}
        {view === 'logs' ? <Card>
          <CardHeader className="border-b"><CardTitle><h2>빌드 로그</h2></CardTitle><CardDescription>민감한 값은 서버에서 마스킹된 출력입니다.</CardDescription><CardAction><span className="text-xs text-muted-foreground">마스킹됨</span></CardAction></CardHeader>
          <CardContent className="p-0"><DeploymentStream rows={logs.body?.logs || []} field="line" label="마스킹된 빌드 로그" empty="표시할 빌드 로그가 없습니다." /></CardContent>
        </Card> : null}
        {view === 'events' ? <Card>
          <CardHeader className="border-b"><CardTitle><h2>배포 이벤트</h2></CardTitle><CardDescription>오래된 이벤트부터 시간순으로 표시합니다.</CardDescription></CardHeader>
          <CardContent className="p-0"><DeploymentStream rows={events.body?.events || []} field="message" label="배포 이벤트 기록" empty="표시할 배포 이벤트가 없습니다." /></CardContent>
        </Card> : null}
      </section>
    </ConsoleShell>
  );
}

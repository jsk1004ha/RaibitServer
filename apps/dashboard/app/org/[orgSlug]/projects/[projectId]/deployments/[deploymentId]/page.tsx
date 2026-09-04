import { randomUUID } from 'node:crypto';
import { apiAction, collectLoadIssues, dashboardApiContext, getJson } from '../../../../../../../lib/api';
import { ConsoleShell, LoadErrorSummary, MetricStrip, SectionNav, StatusBadge } from '../../../../../../../components/console-ui';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { decodeDeploymentRouteSegment, encodeDeploymentRouteSegment } from '@/lib/deployment-route-segment';
import { OperationSubmit } from '@/components/operation-submit';
import { DeploymentActivityStream } from '@/components/project-hub/deployment-stream';

const views = ['overview', 'logs', 'events', 'rollback', 'cancel'] as const;
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
  const confirmedStatus = String(detail.status || '').trim().toUpperCase();
  const cancellationAllowed = new Set(['QUEUED', 'BUILDING', 'IMAGE_READY']).has(confirmedStatus);
  const rollbackAllowed = new Set(['READY', 'BUILD_FAILED', 'FAILED', 'CANCELLED']).has(confirmedStatus);
  const snapshotVersion = typeof detail.snapshotVersion === 'number' && Number.isInteger(detail.snapshotVersion) && detail.snapshotVersion > 0 ? detail.snapshotVersion : null;
  const retryRequestIdempotencyKey = snapshotVersion === null ? null : randomUUID();
  const redeployRequestIdempotencyKey = snapshotVersion === null ? null : randomUUID();
  const retryAllowed = snapshotVersion !== null && new Set(['BUILD_FAILED', 'FAILED', 'CANCELLED']).has(confirmedStatus);
  const redeployAllowed = snapshotVersion !== null && typeof detail.serviceId === 'string' && detail.serviceId.length > 0;
  const previewCleanupAllowed = snapshotVersion !== null && String(detail.deploymentType || '').toLowerCase() === 'preview' && confirmedStatus !== 'CLEANED_UP';
  const loadErrors = collectLoadIssues([['배포 정보', deployment], ['빌드 로그', logs], ['배포 이벤트', events]]);
  const base = `/org/${orgSlug}/projects/${projectId}/deployments/${encodedDeploymentId}`;
  const navItems = [
    { id: 'overview', label: '개요', description: '상태와 이미지', href: `${base}?view=overview` },
    { id: 'logs', label: '빌드 로그', description: '마스킹된 출력', href: `${base}?view=logs` },
    { id: 'events', label: '배포 이벤트', description: '상태 기록', href: `${base}?view=events` },
    { id: 'rollback', label: '롤백', description: '이전 이미지', href: `${base}?view=rollback` },
    { id: 'cancel', label: '취소', description: '진행 중단', href: `${base}?view=cancel` },
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
            <StatusBadge status={detail.status || 'unknown'} />
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={`/org/${orgSlug}/projects/${projectId}?view=deployments`}>배포 목록</a>
          </div>
        </header>
        <LoadErrorSummary issues={loadErrors} />
        <SectionNav items={navItems} current={view} label="배포 상세 화면" />

        {view === 'overview' ? <div className="flex min-w-0 flex-col gap-4">
          <MetricStrip items={[{ label: '상태', value: detail.status || 'unknown', detail: '워커 관리', tone: 'ok' }, { label: '유형', value: detail.deploymentType || 'production', detail: '배포 대상', tone: 'info' }, { label: '실패', value: detail.errorCode || '없음', detail: detail.errorMessage || '오류 없음', tone: detail.errorCode || detail.errorMessage ? 'danger' : 'ok' }]} />
          <Card>
            <CardHeader className="border-b"><CardTitle><h2>이미지 정보</h2></CardTitle><CardDescription>상태는 빌더와 오케스트레이터가 갱신합니다.</CardDescription><CardAction><span className="text-xs text-muted-foreground">워커 관리</span></CardAction></CardHeader>
            <CardContent className="overflow-x-auto px-0">
              <Table>
                <TableHeader><TableRow><TableHead className="pl-4">항목</TableHead><TableHead>현재 값</TableHead></TableRow></TableHeader>
                <TableBody>
                  {[
                    ['이미지 URL', detail.imageUrl || '대기 중'],
                    ['이미지 다이제스트', detail.imageDigest || '대기 중'],
                    ['미리보기 URL', detail.previewUrl || '미리보기 아님'],
                    ['실패', detail.errorCode || detail.errorMessage || '없음'],
                  ].map(([label, value]) => <TableRow key={label}><TableCell className="pl-4 font-medium">{label}</TableCell><TableCell className="max-w-0 break-all whitespace-normal font-mono text-xs">{String(value)}</TableCell></TableRow>)}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="border-b"><CardTitle><h2>복구 및 재실행</h2></CardTitle><CardDescription>표시되는 상태는 서버가 확인한 값입니다. 요청 직후 완료 상태를 추정하지 않습니다.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-raibit-lg">
              <div className="flex flex-wrap gap-raibit-sm">
                <OperationSubmit action={apiAction(`/deployments/${encodedDeploymentId}/retry`, context)} disabled={!retryAllowed} pendingLabel="재시도 요청을 확인하고 있습니다." returnTo={`${base}?view=overview`} submitClassName={buttonVariants({ variant: 'outline', size: 'sm' })} submitLabel="실패한 배포 다시 시도">{snapshotVersion !== null && retryRequestIdempotencyKey !== null ? <><input name="snapshotVersion" type="hidden" value={String(snapshotVersion)} /><input name="requestIdempotencyKey" type="hidden" value={retryRequestIdempotencyKey} /></> : null}</OperationSubmit>
                <OperationSubmit action={apiAction(`/services/${String(detail.serviceId || '')}/redeploy`, context)} disabled={!redeployAllowed} pendingLabel="재배포 요청을 확인하고 있습니다." returnTo={`${base}?view=overview`} submitClassName={buttonVariants({ variant: 'outline', size: 'sm' })} submitLabel="현재 구성으로 재배포">{snapshotVersion !== null && redeployRequestIdempotencyKey !== null ? <><input name="snapshotVersion" type="hidden" value={String(snapshotVersion)} /><input name="requestIdempotencyKey" type="hidden" value={redeployRequestIdempotencyKey} /></> : null}</OperationSubmit>
                <OperationSubmit action={apiAction(`/deployments/${encodedDeploymentId}/preview-cleanup`, context)} disabled={!previewCleanupAllowed} pendingLabel="미리보기 정리 요청을 확인하고 있습니다." returnTo={`${base}?view=overview`} submitClassName={buttonVariants({ variant: 'destructive', size: 'sm' })} submitLabel="미리보기 정리"><input name="confirmed" type="hidden" value="true" /></OperationSubmit>
              </div>
              {snapshotVersion === null ? <p className="text-sm text-muted-foreground">현재 서버 응답에 복구 작업에 필요한 스냅샷 버전이 없습니다. 새로 고친 뒤 다시 확인하세요.</p> : null}
              <DeploymentActivityStream initialStatus={typeof detail.status === 'string' ? detail.status : undefined} streamHref={`/api/control/deployments/${encodedDeploymentId}/stream`} />
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
        {view === 'rollback' ? <Card className="border-destructive/30">
          <CardHeader className="border-b border-destructive/20 bg-destructive/5"><CardTitle><h2>롤백 확인</h2></CardTitle><CardDescription>이전 READY 이미지로 되돌립니다. 실행 전 대상을 확인하세요.</CardDescription></CardHeader>
          <CardContent>{rollbackAllowed ? <OperationSubmit action={apiAction(`/deployments/${encodedDeploymentId}/rollback`, context)} id="rollback-deployment" pendingLabel="롤백 요청을 확인하고 있습니다." returnTo={`${base}?view=overview`} submitClassName={buttonVariants({ variant: 'destructive' })} submitLabel="롤백"><FieldGroup><Field><FieldLabel htmlFor="rollback-image">이전 이미지 URL</FieldLabel><Input id="rollback-image" name="imageUrl" placeholder="선택 사항" autoComplete="off" /><FieldDescription>비워 두면 서버가 직전 READY 이미지를 선택합니다.</FieldDescription></Field><label className="confirmation-control"><input type="checkbox" name="confirmed" value="true" required /><span>롤백 확인</span></label></FieldGroup></OperationSubmit> : <Empty><EmptyHeader><EmptyTitle>현재 상태에서는 롤백을 요청할 수 없습니다.</EmptyTitle><EmptyDescription>READY, BUILD_FAILED, FAILED, CANCELLED 상태에서만 이전 READY 이미지를 확인해 롤백할 수 있습니다.</EmptyDescription></EmptyHeader></Empty>}</CardContent>
        </Card> : null}
        {view === 'cancel' ? <Card className="border-destructive/30">
          <CardHeader className="border-b border-destructive/20 bg-destructive/5"><CardTitle><h2>배포 취소</h2></CardTitle><CardDescription>QUEUED, BUILDING, IMAGE_READY 상태의 배포만 중단할 수 있습니다.</CardDescription></CardHeader>
          <CardContent>{cancellationAllowed ? <OperationSubmit action={apiAction(`/deployments/${encodedDeploymentId}/cancel`, context)} pendingLabel="취소 요청을 확인하고 있습니다." returnTo={`${base}?view=overview`} submitClassName={buttonVariants({ variant: 'destructive' })} submitLabel="배포 취소"><FieldGroup><Field><FieldLabel htmlFor="cancel-reason">취소 사유</FieldLabel><Input id="cancel-reason" name="reason" placeholder="취소 이유" autoComplete="off" /><FieldDescription>운영 기록에 남길 선택 사항입니다.</FieldDescription></Field></FieldGroup></OperationSubmit> : <Empty><EmptyHeader><EmptyTitle>현재 상태에서는 취소할 수 없습니다.</EmptyTitle><EmptyDescription>QUEUED, BUILDING, IMAGE_READY 상태에서만 취소할 수 있습니다. 실행 중이거나 완료된 배포는 롤백 또는 서비스 삭제를 사용하세요.</EmptyDescription></EmptyHeader></Empty>}</CardContent>
        </Card> : null}
      </section>
    </ConsoleShell>
  );
}

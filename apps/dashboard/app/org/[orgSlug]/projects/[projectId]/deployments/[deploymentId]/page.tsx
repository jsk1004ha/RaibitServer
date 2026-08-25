import { apiAction, collectLoadIssues, dashboardApiContext, getJson } from '../../../../../../../lib/api';
import { ConsoleShell, LoadErrorSummary, LogViewer, MetricStrip, SectionNav, StatusBadge } from '../../../../../../../components/console-ui';

const views = ['overview', 'logs', 'events', 'rollback', 'cancel'] as const;
type DeploymentView = typeof views[number];

export default async function DeploymentDetailPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string; deploymentId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ orgSlug, projectId, deploymentId }, query] = await Promise.all([params, searchParams]);
  const requestedView = String(query.view || 'overview');
  const view: DeploymentView = views.includes(requestedView as DeploymentView) ? requestedView as DeploymentView : 'overview';
  const context = await dashboardApiContext();
  const [deployment, logs, events] = await Promise.all([
    getJson(`/deployments/${encodeURIComponent(deploymentId)}`, { id: deploymentId, status: 'unknown' }, context),
    view === 'logs'
      ? getJson(`/deployments/${encodeURIComponent(deploymentId)}/logs`, { logs: [] }, context)
      : Promise.resolve({ ok: true, status: 200, body: { logs: [] } }),
    view === 'events'
      ? getJson(`/deployments/${encodeURIComponent(deploymentId)}/events`, { events: [] }, context)
      : Promise.resolve({ ok: true, status: 200, body: { events: [] } }),
  ]);
  const detail = deployment.body || {};
  const cancellationAllowed = new Set(['QUEUED', 'BUILDING', 'IMAGE_READY']).has(String(detail.status || '').trim().toUpperCase());
  const loadErrors = collectLoadIssues([['배포 정보', deployment], ['빌드 로그', logs], ['배포 이벤트', events]]);
  const base = `/org/${orgSlug}/projects/${projectId}/deployments/${deploymentId}`;
  const navItems = [
    { id: 'overview', label: '개요', description: '상태와 이미지', href: `${base}?view=overview` },
    { id: 'logs', label: '빌드 로그', description: '마스킹된 출력', href: `${base}?view=logs` },
    { id: 'events', label: '배포 이벤트', description: '상태 기록', href: `${base}?view=events` },
    { id: 'rollback', label: '롤백', description: '이전 이미지', href: `${base}?view=rollback` },
    { id: 'cancel', label: '취소', description: '진행 중단', href: `${base}?view=cancel` },
  ];

  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug} projectValue={projectId} projectId={projectId}>
      <section className="page page-focus" data-od-id="deployment-detail">
        <header className="page-header"><div><h1 className="page-title">배포 상세</h1><p className="page-subtitle">상태 · 로그 · 복구</p></div><div className="page-header-actions"><StatusBadge status={detail.status || 'unknown'} /><a className="btn" href={`/org/${orgSlug}/projects/${projectId}?view=deployments`}>배포 목록</a></div></header>
        <LoadErrorSummary issues={loadErrors} />
        <SectionNav items={navItems} current={view} label="배포 상세 화면" />

        {view === 'overview' ? <div className="single-activity stack"><MetricStrip items={[{ label: '상태', value: detail.status || 'unknown', detail: '워커 관리', tone: 'ok' }, { label: '유형', value: detail.deploymentType || 'production', detail: '배포 대상', tone: 'info' }, { label: '실패', value: detail.errorCode || '없음', detail: detail.errorMessage || '오류 없음', tone: detail.errorCode || detail.errorMessage ? 'danger' : 'ok' }]} /><section className="console-surface activity-card"><div className="card-title"><h2>이미지 정보</h2><span className="badge info">워커 관리</span></div><dl className="detail-list"><div><dt>이미지 URL</dt><dd>{detail.imageUrl || '대기 중'}</dd></div><div><dt>이미지 다이제스트</dt><dd>{detail.imageDigest || '대기 중'}</dd></div><div><dt>미리보기 URL</dt><dd>{detail.previewUrl || '미리보기 아님'}</dd></div><div><dt>실패</dt><dd>{detail.errorCode || detail.errorMessage || '없음'}</dd></div></dl><p className="muted">상태는 빌더와 오케스트레이터가 갱신합니다.</p></section></div> : null}
        {view === 'logs' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>빌드 로그</h2><span className="badge info">마스킹됨</span></div><LogViewer rows={logs.body?.logs || []} field="line" empty="표시할 빌드 로그가 없습니다." /></section> : null}
        {view === 'events' ? <section className="console-surface single-activity activity-card"><div className="card-title"><h2>배포 이벤트</h2><span className="badge info">시간순</span></div><LogViewer rows={events.body?.events || []} field="message" empty="표시할 배포 이벤트가 없습니다." /></section> : null}
        {view === 'rollback' ? <section className="form-surface danger-zone single-activity activity-card"><div><h2>롤백 확인</h2><p className="muted">이전 READY 이미지</p></div><form id="rollback-deployment" method="post" action={apiAction(`/deployments/${deploymentId}/rollback`, context)} className="stack"><input type="hidden" name="_returnTo" value={`${base}?view=overview`} /><label>이전 이미지 URL <input name="imageUrl" placeholder="선택 사항" /></label><label className="confirmation-control"><input type="checkbox" name="confirmed" value="true" required /><span>롤백 확인</span></label><button className="btn btn-danger" type="submit">롤백</button></form></section> : null}
        {view === 'cancel' ? <section className="form-surface danger-zone single-activity activity-card"><div><h2>배포 취소</h2><p className="muted">진행 중인 배포</p></div>{cancellationAllowed ? <form method="post" action={apiAction(`/deployments/${deploymentId}/cancel`, context)} className="stack"><input type="hidden" name="_returnTo" value={`${base}?view=overview`} /><label>취소 사유 <input name="reason" placeholder="취소 이유" /></label><button className="btn btn-danger" type="submit">배포 취소</button></form> : <p className="muted">QUEUED, BUILDING, IMAGE_READY 상태에서만 취소할 수 있습니다. 실행 중이거나 완료된 배포는 롤백 또는 서비스 삭제를 사용하세요.</p>}</section> : null}
      </section>
    </ConsoleShell>
  );
}

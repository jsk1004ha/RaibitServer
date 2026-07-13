import { apiAction, getJson, dashboardApiContext } from '../../../../../../../lib/api';
import { ConsoleShell, LogViewer, MetricCard, StatusBadge } from '../../../../../../../components/console-ui';

export default async function DeploymentDetailPage({ params }: { params: Promise<{ orgSlug: string; projectId: string; deploymentId: string }> }) {
  const { orgSlug, projectId, deploymentId } = await params;
  const context = await dashboardApiContext();
  const [deployment, logs, events] = await Promise.all([
    getJson(`/deployments/${encodeURIComponent(deploymentId)}`, { id: deploymentId, status: 'unknown' }, context),
    getJson(`/deployments/${encodeURIComponent(deploymentId)}/logs`, { logs: [] }, context),
    getJson(`/deployments/${encodeURIComponent(deploymentId)}/events`, { events: [] }, context),
  ]);
  const detail = deployment.body || {};
  return (
    <ConsoleShell active="projects" orgValue={orgSlug} projectValue={projectId} crumbs={`${projectId} / 배포 / ${deploymentId}`} actions={<><a className="btn" href={`/org/${orgSlug}/projects/${projectId}`}>프로젝트 콘솔</a><button className="btn btn-danger" type="submit" form="rollback-deployment">롤백</button></>}>
      <section className="page" data-od-id="deployment-detail">
        <header className="page-header">
          <div><p className="eyebrow">배포</p><h1 className="page-title">배포 상세</h1><p className="page-subtitle">상태와 이미지, 실패 원인, 빌드 로그와 이벤트를 한 화면에서 확인하세요.</p></div>
          <StatusBadge status={detail.status || 'unknown'} />
        </header>
        <section className="grid grid-3">
          <MetricCard title="유형" value={detail.deploymentType || 'production'} detail="production / manual / preview" />
          <MetricCard title="이미지" value={detail.imageDigest || detail.imageUrl || '대기 중'} detail="레지스트리 이미지 또는 다이제스트" tone="ok" />
          <MetricCard title="실패" value={detail.errorCode || detail.errorMessage || '없음'} detail="정제된 실패 필드" tone={detail.errorCode || detail.errorMessage ? 'danger' : 'ok'} />
        </section>
        <section className="dashboard-grid" style={{ marginTop: 13 }}>
          <article className="stack">
            <section className="card">
              <div className="card-title"><h2>상태와 이미지</h2><span className="badge info">원하는 상태</span></div>
              <dl className="grid grid-3"><div><dt>상태</dt><dd>{detail.status || 'unknown'}</dd></div><div><dt>유형</dt><dd>{detail.deploymentType || 'production'}</dd></div><div><dt>이미지 URL</dt><dd>{detail.imageUrl || '대기 중'}</dd></div><div><dt>이미지 다이제스트</dt><dd>{detail.imageDigest || '대기 중'}</dd></div><div><dt>미리보기 URL</dt><dd>{detail.previewUrl || '미리보기 아님'}</dd></div><div><dt>실패</dt><dd>{detail.errorCode || detail.errorMessage || '없음'}</dd></div></dl>
              <form method="post" action={apiAction(`/deployments/${deploymentId}/status`, context)} className="form-grid" style={{ marginTop: 13 }}>
                <label>상태 <select name="status" defaultValue="BUILDING"><option>BUILDING</option><option>IMAGE_READY</option><option>DEPLOYING</option><option>READY</option><option>FAILED</option></select></label>
                <label>이미지 URL <input name="imageUrl" placeholder="IMAGE_READY 상태의 이미지 URL" /></label>
                <label>이미지 다이제스트 <input name="imageDigest" placeholder="sha256:..." /></label>
                <label>실패 메시지 <input name="errorMessage" placeholder="실패 원인" /></label>
                <button type="submit">상태 업데이트</button>
              </form>
            </section>
            <section className="card"><div className="card-title"><h2>빌드 로그</h2><span className="badge info">마스킹됨</span></div><LogViewer rows={logs.body?.logs || []} field="line" empty="표시할 빌드 로그가 없습니다." /></section>
          </article>
          <aside className="stack">
            <section className="card"><div className="card-title"><h2>배포 이벤트</h2><span className="badge info">실시간</span></div><LogViewer rows={events.body?.events || []} field="message" empty="표시할 배포 이벤트가 없습니다." /></section>
            <section className="card danger-zone"><h2>롤백 확인</h2><p className="muted" style={{ marginTop: 8 }}>이전 READY 이미지로 되돌립니다. 연결된 데이터베이스는 변경하지 않으며 새 배포 이벤트와 감사 로그가 기록됩니다.</p><form id="rollback-deployment" method="post" action={apiAction(`/deployments/${deploymentId}/rollback`, context)} className="stack" style={{ marginTop: 12 }}><label>이전 이미지 URL <input name="imageUrl" placeholder="선택 사항" /></label><button type="submit">롤백</button></form></section>
            <section className="card"><h2>배포 취소</h2><form method="post" action={apiAction(`/deployments/${deploymentId}/cancel`, context)} className="stack" style={{ marginTop: 12 }}><label>취소 사유 <input name="reason" placeholder="취소 이유" /></label><button type="submit">배포 취소</button></form></section>
          </aside>
        </section>
      </section>
    </ConsoleShell>
  );
}

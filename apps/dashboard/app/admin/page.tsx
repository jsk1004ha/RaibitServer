import { apiAction, loadAdminConsole } from '../../lib/api';
import { ConsoleShell, JsonCard, StatusBadge } from '../../components/console-ui';

const roleLabels: Record<string, string> = {
  ADMIN: '관리자',
  USER: '사용자',
};

const accountTypeLabels: Record<string, string> = {
  CLUB_MEMBER: '클럽 회원',
  NON_CLUB: '일반 사용자',
};

export default async function AdminPage() {
  const state = await loadAdminConsole();
  return (
    <ConsoleShell active="admin" eyebrow="관리" orgLabel="권한" orgValue="관리자" projectLabel="승인 대기" projectValue={`${state.pendingUsers.length}명`} crumbs="관리자 / 사용자 관리" actions={<a className="btn" href="/">운영 현황</a>}>
      <section className="page" data-od-id="admin-approval">
        <header className="page-header"><div><p className="eyebrow">관리자</p><h1 className="page-title">사용자 관리</h1><p className="page-subtitle">가입 승인 상태와 계정 유형을 관리하고 사용자별 할당량을 조정합니다. 모든 변경은 감사 로그에 기록됩니다.</p></div><span className="badge warn">승인 대기 {state.pendingUsers.length}명</span></header>
        <div className="grid grid-main">
          <section className="card">
            <div className="card-title"><h2>사용자</h2><span className="badge info">{state.users.length}명</span></div>
            <p className="muted">새 가입은 일반 사용자 / 승인 대기 상태로 시작하며 승인할 때 계정 유형이 확정됩니다.</p>
            <table className="table" style={{ marginTop: 12 }}><thead><tr><th>사용자</th><th>역할 / 계정</th><th>상태</th><th>작업</th></tr></thead><tbody>
              {state.users.length ? state.users.map((user: any) => <tr key={user.id}>
                <td><strong>{user.email || user.name}</strong><p className="muted mono">{user.id}</p></td><td>{roleLabels[user.role || 'USER'] || '사용자'} / {accountTypeLabels[user.accountType] || '일반 사용자'}</td><td><StatusBadge status={user.approvalStatus} /></td>
                <td className="table-actions"><form method="post" action={apiAction(`/admin/users/${user.id}/approve`, state.context)} className="inline-actions"><input type="hidden" name="accountType" value="CLUB_MEMBER" /><button type="submit">클럽 회원으로 승인</button></form><form method="post" action={apiAction(`/admin/users/${user.id}/approve`, state.context)} className="inline-actions" style={{ marginTop: 8 }}><input type="hidden" name="accountType" value="NON_CLUB" /><button type="submit">일반 사용자로 승인</button></form><form method="post" action={apiAction(`/admin/users/${user.id}/reject`, state.context)} className="inline-actions danger-zone" style={{ marginTop: 8 }}><button className="btn-danger" type="submit">거절</button></form></td>
              </tr>) : <tr><td colSpan={4}>표시할 사용자가 없습니다.</td></tr>}
            </tbody></table>
          </section>
          <aside className="stack">
            <section className="card"><h2>할당량 편집</h2><p className="muted" style={{ marginTop: 8 }}>변경 전후 값과 작업자가 감사 로그에 남습니다.</p>{state.users[0] ? <form method="post" action={apiAction(`/admin/users/${state.users[0].id}/quota`, state.context)} className="form-grid" style={{ marginTop: 12 }}><label>프로젝트 수 <input name="maxProjects" placeholder="maxProjects" /></label><label>서비스 수 <input name="maxServices" placeholder="maxServices" /></label><button type="submit">할당량 저장</button></form> : null}</section>
            <section className="card danger-zone"><h2>거절 확인</h2><p className="muted" style={{ marginTop: 8 }}>거절된 사용자는 프로젝트, 서비스, 배포, 리소스를 만들 수 없습니다. 작업 전에 대상 계정을 다시 확인하세요.</p></section>
          </aside>
        </div>
        <section className="grid grid-3" style={{ marginTop: 16 }}><JsonCard title="할당량" value={state.quotas} /><JsonCard title="사용량" value={state.usage} /><JsonCard title="감사 로그" value={(state.auditLogs || []).slice(-10)} /></section>
      </section>
    </ConsoleShell>
  );
}

import { redirect } from 'next/navigation';
import { apiAction, loadAdminConsole } from '../../lib/api';
import { ConsoleShell, LoadErrorSummary, StatusBadge } from '../../components/console-ui';

const roleLabels: Record<string, string> = { ADMIN: '관리자', USER: '사용자' };
const accountTypeLabels: Record<string, string> = { CLUB_MEMBER: '클럽 회원', NON_CLUB: '일반 사용자' };

export default async function AdminPage() {
  const state = await loadAdminConsole();
  if (!state.authorized) redirect('/console');
  const managedUsers = [...state.bannedUsers, ...state.approvedUsers];

  return (
    <ConsoleShell active="admin" eyebrow="관리" orgLabel="권한" orgValue="관리자" projectLabel="승인 대기" projectValue={`${state.pendingUsers.length}명`}>
      <section className="page" data-od-id="admin-approval">
        <header className="page-header"><div><h1 className="page-title">가입 신청 확인</h1><p className="page-subtitle">신청자 · 권한</p></div><div className="page-header-actions"><span className="badge warn">승인 대기 {state.pendingUsers.length}명</span><a className="btn" href="/console">콘솔로 돌아가기</a></div></header>
        <LoadErrorSummary issues={state.loadErrors} />
        <section className="console-surface admin-approval-card">
          <div className="card-title"><h2>승인 대기 신청</h2><span className="badge info">{state.pendingUsers.length}명</span></div>
          <table className="table" style={{ marginTop: 12 }}>
            <thead><tr><th>사용자</th><th>신청 / 현재 계정</th><th>상태</th><th>작업</th></tr></thead>
            <tbody>{state.pendingUsers.length ? state.pendingUsers.map((user: any) => <tr key={user.id}>
              <td><strong>{user.name || '이름 미입력'}</strong><p>{user.studentId ? `학번 ${user.studentId}` : '학번 미입력'}</p><p className="muted">{user.email}</p></td>
              <td><strong>{user.clubMemberClaim ? '신청: 라이빗 동아리원' : '신청: 비동아리원'}</strong><p className="muted">현재 {roleLabels[user.role || 'USER'] || '사용자'} / {accountTypeLabels[user.accountType] || '일반 사용자'}</p></td>
              <td><StatusBadge status={user.approvalStatus} /></td>
              <td className="table-actions">
                <form method="post" action={apiAction(`/admin/users/${user.id}/approve`, state.context)} className="inline-actions"><input type="hidden" name="accountType" value="CLUB_MEMBER" /><button className="btn btn-primary" type="submit">클럽 회원 승인</button></form>
                <form method="post" action={apiAction(`/admin/users/${user.id}/approve`, state.context)} className="inline-actions" style={{ marginTop: 8 }}><input type="hidden" name="accountType" value="NON_CLUB" /><button className="btn" type="submit">일반 사용자 승인</button></form>
                <form method="post" action={apiAction(`/admin/users/${user.id}/reject`, state.context)} className="inline-actions danger-zone" style={{ marginTop: 8 }}><label className="confirmation-control"><input type="checkbox" name="confirmed" value="true" required /><span>거절 확인</span></label><button className="btn btn-danger" type="submit">거절</button></form>
              </td>
            </tr>) : <tr><td colSpan={4}>표시할 사용자가 없습니다.</td></tr>}</tbody>
          </table>
        </section>
        <section className="console-surface admin-approval-card" style={{ marginTop: 20 }}>
          <div className="card-title"><h2>사용자 이용 제한</h2><span className="badge info">밴 {state.bannedUsers.length}명</span></div>
          <p className="muted" style={{ marginTop: 8 }}>사유를 기록해 영구 또는 지정 시각까지 이용을 제한합니다. 밴 즉시 기존 로그인 세션이 모두 만료됩니다.</p>
          <table className="table" style={{ marginTop: 12 }}>
            <thead><tr><th>사용자</th><th>계정</th><th>제한 상태</th><th>작업</th></tr></thead>
            <tbody>{managedUsers.length ? managedUsers.map((user: any) => <tr key={user.id}>
              <td><strong>{user.name || '이름 미입력'}</strong><p className="muted">{user.email}</p></td>
              <td>{roleLabels[user.role || 'USER'] || '사용자'} / {accountTypeLabels[user.accountType] || '일반 사용자'}</td>
              <td>{user.isBanned ? <><span className="badge danger">밴</span><p>{user.banReason || '사유 없음'}</p><p className="muted">{user.banExpiresAt ? `${new Date(user.banExpiresAt).toLocaleString('ko-KR')}까지` : '영구 제한'}</p></> : <span className="badge ok">정상</span>}</td>
              <td className="table-actions">
                {user.isBanned ? <form method="post" action={apiAction(`/admin/users/${user.id}/unban`, state.context)} className="inline-actions"><button className="btn" type="submit">밴 해제</button></form> : <form method="post" action={apiAction(`/admin/users/${user.id}/ban`, state.context)} className="inline-actions danger-zone">
                  <label><span className="muted">사유</span><input name="reason" required maxLength={500} placeholder="이용 제한 사유" /></label>
                  <label><span className="muted">해제 시각 (비우면 영구)</span><input name="expiresAt" type="datetime-local" /></label>
                  <button className="btn btn-danger" type="submit">밴</button>
                </form>}
              </td>
            </tr>) : <tr><td colSpan={4}>관리할 승인 사용자가 없습니다.</td></tr>}</tbody>
          </table>
        </section>
      </section>
    </ConsoleShell>
  );
}

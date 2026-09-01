import { redirect } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { ActionLink, Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiAction, loadAdminConsole } from '../../lib/api';
import { ConsoleShell, LoadErrorSummary } from '../../components/console-ui';

const roleLabels: Record<string, string> = { ADMIN: '관리자', USER: '사용자' };
const accountTypeLabels: Record<string, string> = { CLUB_MEMBER: '클럽 회원', NON_CLUB: '일반 사용자' };
const destructiveActionClassName = 'w-full bg-destructive text-destructive-foreground hover:bg-destructive/90';

type ManagedUser = {
  readonly id: string;
  readonly name?: string;
  readonly studentId?: string;
  readonly email?: string;
  readonly role?: string;
  readonly accountType: string;
  readonly approvalStatus?: string;
  readonly clubMemberClaim?: boolean;
  readonly isBanned?: boolean;
  readonly banReason?: string;
  readonly banExpiresAt?: string;
};

export default async function AdminPage() {
  const state = await loadAdminConsole();
  if (!state.authorized) redirect('/console');
  const managedUsers = [...state.bannedUsers, ...state.approvedUsers];

  return (
    <ConsoleShell active="admin" eyebrow="관리" orgLabel="권한" orgValue="관리자" projectLabel="승인 대기" projectValue={`${state.pendingUsers.length}명`}>
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8 md:py-10" data-od-id="admin-approval" data-t14-admin>
        <header className="flex flex-col gap-4 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 flex-col gap-1"><p className="text-sm font-medium text-primary">사용자 관리</p><h1 className="text-3xl font-medium tracking-tight text-foreground text-balance">가입 신청 확인</h1><p className="max-w-2xl text-sm leading-6 text-muted-foreground text-pretty">신청자의 동아리 소속과 계정 상태를 확인한 뒤 승인 또는 거절하세요.</p></div>
          <div className="flex flex-wrap items-center gap-3"><Badge variant={state.pendingUsers.length ? 'default' : 'outline'}>승인 대기 {state.pendingUsers.length}명</Badge><ActionLink href="/console">콘솔로 돌아가기</ActionLink></div>
        </header>
        <LoadErrorSummary issues={state.loadErrors} />

        <Card>
          <CardHeader className="border-b border-border"><div className="flex items-start justify-between gap-4"><div><CardTitle><h2>승인 대기 신청</h2></CardTitle><CardDescription className="mt-1">신청 정보와 현재 계정 유형을 함께 검토합니다.</CardDescription></div><Badge variant="secondary">{state.pendingUsers.length}명</Badge></div></CardHeader>
          <CardContent className="p-0">
            {state.pendingUsers.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>사용자</TableHead><TableHead>신청 / 현재 계정</TableHead><TableHead>상태</TableHead><TableHead className="min-w-64">작업</TableHead></TableRow></TableHeader>
                <TableBody>{state.pendingUsers.map((user: ManagedUser) => <TableRow key={user.id}>
                  <TableCell className="align-top"><strong>{user.name || '이름 미입력'}</strong><p className="mt-1 text-sm">{user.studentId ? `학번 ${user.studentId}` : '학번 미입력'}</p><p className="mt-1 max-w-52 truncate text-sm text-muted-foreground" title={user.email}>{user.email}</p></TableCell>
                  <TableCell className="align-top"><strong>{user.clubMemberClaim ? '신청: 라이빗 동아리원' : '신청: 비동아리원'}</strong><p className="mt-1 text-sm text-muted-foreground">현재 {roleLabels[user.role || 'USER'] || '사용자'} / {accountTypeLabels[user.accountType] || '일반 사용자'}</p></TableCell>
                  <TableCell className="align-top"><Badge className="border-primary/25 bg-primary-soft text-primary" variant="outline" data-status={user.approvalStatus}>승인 대기</Badge></TableCell>
                  <TableCell className="align-top"><div className="flex min-w-60 flex-col gap-2">
                    <form method="post" action={apiAction(`/admin/users/${user.id}/approve`, state.context)}><input type="hidden" name="accountType" value="CLUB_MEMBER" /><Button className="w-full" type="submit">클럽 회원 승인</Button></form>
                    <form method="post" action={apiAction(`/admin/users/${user.id}/approve`, state.context)}><input type="hidden" name="accountType" value="NON_CLUB" /><Button className="w-full" variant="outline" type="submit">일반 사용자 승인</Button></form>
                    <form method="post" action={apiAction(`/admin/users/${user.id}/reject`, state.context)} className="space-y-2 rounded-md border border-destructive/25 bg-destructive/5 p-3"><label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-foreground"><input className="size-4 accent-primary" type="checkbox" name="confirmed" value="true" required /><span>거절 확인</span></label><Button className={destructiveActionClassName} variant="destructive" type="submit">거절</Button></form>
                  </div></TableCell>
                </TableRow>)}</TableBody>
              </Table>
            ) : <Empty className="min-h-48" role="status"><EmptyHeader><EmptyTitle>표시할 사용자가 없습니다.</EmptyTitle><EmptyDescription>새 가입 신청이 들어오면 이곳에서 검토할 수 있습니다.</EmptyDescription></EmptyHeader></Empty>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border"><div className="flex items-start justify-between gap-4"><div><CardTitle><h2>사용자 이용 제한</h2></CardTitle><CardDescription className="mt-1 max-w-3xl text-pretty">사유를 기록해 영구 또는 지정 시각까지 이용을 제한합니다. 밴 즉시 기존 로그인 세션이 모두 만료됩니다.</CardDescription></div><Badge variant={state.bannedUsers.length ? 'destructive' : 'secondary'}>밴 {state.bannedUsers.length}명</Badge></div></CardHeader>
          <CardContent className="p-0">
            {managedUsers.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>사용자</TableHead><TableHead>계정</TableHead><TableHead>제한 상태</TableHead><TableHead className="min-w-72">작업</TableHead></TableRow></TableHeader>
                <TableBody>{managedUsers.map((user: ManagedUser) => <TableRow key={user.id}>
                  <TableCell className="align-top"><strong>{user.name || '이름 미입력'}</strong><p className="mt-1 max-w-52 truncate text-sm text-muted-foreground" title={user.email}>{user.email}</p></TableCell>
                  <TableCell className="align-top">{roleLabels[user.role || 'USER'] || '사용자'} / {accountTypeLabels[user.accountType] || '일반 사용자'}</TableCell>
                  <TableCell className="align-top">{user.isBanned ? <div className="flex flex-col items-start gap-1"><Badge variant="destructive">밴</Badge><p className="max-w-56 break-words text-sm">{user.banReason || '사유 없음'}</p><p className="text-sm text-muted-foreground">{user.banExpiresAt ? `${new Date(user.banExpiresAt).toLocaleString('ko-KR')}까지` : '영구 제한'}</p></div> : <Badge variant="secondary">정상</Badge>}</TableCell>
                  <TableCell className="align-top">{user.isBanned ? (
                    <form method="post" action={apiAction(`/admin/users/${user.id}/unban`, state.context)}><Button className="w-full" variant="outline" type="submit">밴 해제</Button></form>
                  ) : (
                    <form method="post" action={apiAction(`/admin/users/${user.id}/ban`, state.context)} className="rounded-md border border-destructive/25 bg-destructive/5 p-3"><FieldGroup className="gap-3"><Field><FieldLabel htmlFor={`ban-reason-${user.id}`}>사유</FieldLabel><Input id={`ban-reason-${user.id}`} name="reason" required maxLength={500} placeholder="이용 제한 사유" /></Field><Field><FieldLabel htmlFor={`ban-expiry-${user.id}`}>해제 시각</FieldLabel><Input id={`ban-expiry-${user.id}`} name="expiresAt" type="datetime-local" /><FieldDescription>비우면 영구 제한됩니다.</FieldDescription></Field><Button className={destructiveActionClassName} variant="destructive" type="submit">밴</Button></FieldGroup></form>
                  )}</TableCell>
                </TableRow>)}</TableBody>
              </Table>
            ) : <Empty className="min-h-48" role="status"><EmptyHeader><EmptyTitle>관리할 승인 사용자가 없습니다.</EmptyTitle><EmptyDescription>승인된 사용자가 생기면 이용 제한 상태를 관리할 수 있습니다.</EmptyDescription></EmptyHeader></Empty>}
          </CardContent>
        </Card>
      </section>
    </ConsoleShell>
  );
}

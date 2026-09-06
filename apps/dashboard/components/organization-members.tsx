'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { UserAvatar } from '@/components/user-avatar';
import { apiAction } from '@/lib/api-action';

const roles = ['OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER'] as const;
type MembershipRole = typeof roles[number];

export type OrganizationMember = Readonly<{
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  version: number;
  createdAt: string;
  user: Readonly<{ id: string; email: string; name: string | null; avatarUrl: string | null }>;
}>;

export type OrganizationInvite = Readonly<{
  id: string;
  organizationId: string;
  email: string;
  role: string;
  tokenVersion: number;
  invitedByUserId: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}>;

type ActionState = Readonly<{ kind: 'idle' | 'pending' | 'success' | 'error'; message?: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function payload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function actionError(status: number, body: unknown): string {
  const code = record(body)?.error;
  if (status === 401) return '로그인이 필요하거나 세션이 만료되었습니다.';
  if (status === 403) return '이 작업을 수행할 권한이 없습니다.';
  if (status === 404) return '요청한 구성원을 찾을 수 없습니다.';
  if (status === 409 && code === 'LAST_OWNER') return '마지막 소유자는 역할을 바꾸거나 제거할 수 없습니다.';
  if (status === 409) return '다른 변경 사항이 먼저 반영되었습니다. 페이지를 새로고침해 다시 확인하세요.';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
}

function roleLabel(role: string): string {
  return { OWNER: '소유자', ADMIN: '관리자', MAINTAINER: '유지관리자', DEVELOPER: '개발자', DB_ADMIN: 'DB 관리자', VIEWER: '뷰어' }[role] ?? role;
}

function canManage(actor: OrganizationMember | undefined, target: OrganizationMember): boolean {
  if (!actor) return false;
  if (actor.role === 'OWNER') return true;
  return actor.role === 'ADMIN' && target.role !== 'OWNER';
}

export function OrganizationMembers({ initialInvites, initialMembers, organizationId, userId }: Readonly<{
  initialInvites: readonly OrganizationInvite[];
  initialMembers: readonly OrganizationMember[];
  organizationId: string;
  userId: string | null;
}>) {
  const [members, setMembers] = useState<readonly OrganizationMember[]>(initialMembers);
  const [invites, setInvites] = useState<readonly OrganizationInvite[]>(initialInvites);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<MembershipRole>('DEVELOPER');
  const [inviteState, setInviteState] = useState<ActionState>({ kind: 'idle' });
  const [actionState, setActionState] = useState<ActionState>({ kind: 'idle' });
  const [confirming, setConfirming] = useState<{ kind: 'remove' | 'revoke' | 'leave'; target: OrganizationMember | OrganizationInvite } | null>(null);
  const currentMember = useMemo(() => members.find((member) => member.userId === userId), [members, userId]);

  async function request(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<{ ok: boolean; body: unknown; status: number }> {
    try {
      const response = await fetch(apiAction(path), {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { ok: response.ok, body: await payload(response), status: response.status };
    } catch {
      return { ok: false, body: null, status: 0 };
    }
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inviteState.kind === 'pending') return;
    setInviteState({ kind: 'pending' });
    const result = await request(`/organizations/${encodeURIComponent(organizationId)}/invites`, 'POST', { email: inviteEmail, role: inviteRole });
    const issued = record(result.body)?.invite;
    if (!result.ok || !record(issued)) {
      setInviteState({ kind: 'error', message: actionError(result.status, result.body) });
      return;
    }
    const invite = issued as unknown as OrganizationInvite;
    setInvites((rows) => [invite, ...rows.filter((row) => row.email !== invite.email)]);
    setInviteEmail('');
    setInviteState({ kind: 'success', message: '초대 요청을 접수했습니다.' });
  }

  async function changeRole(member: OrganizationMember, role: string): Promise<void> {
    if (!roles.includes(role as MembershipRole) || role === member.role || actionState.kind === 'pending') return;
    setActionState({ kind: 'pending' });
    const result = await request(`/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(member.id)}`, 'PATCH', { role, expectedVersion: member.version });
    const changed = record(result.body)?.membership;
    if (!result.ok || !record(changed)) {
      setActionState({ kind: 'error', message: actionError(result.status, result.body) });
      return;
    }
    setMembers((rows) => rows.map((row) => row.id === member.id ? changed as unknown as OrganizationMember : row));
    setActionState({ kind: 'success', message: '구성원 역할을 변경했습니다.' });
  }

  async function confirmAction(): Promise<void> {
    if (!confirming || actionState.kind === 'pending') return;
    setActionState({ kind: 'pending' });
    const target = confirming.target;
    const result = confirming.kind === 'leave'
      ? await request(`/organizations/${encodeURIComponent(organizationId)}/leave`, 'POST', { expectedVersion: (target as OrganizationMember).version })
      : confirming.kind === 'remove'
        ? await request(`/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent((target as OrganizationMember).id)}`, 'DELETE', { expectedVersion: (target as OrganizationMember).version })
        : await request(`/organizations/${encodeURIComponent(organizationId)}/invites/${encodeURIComponent((target as OrganizationInvite).id)}`, 'DELETE');
    if (!result.ok) {
      setActionState({ kind: 'error', message: actionError(result.status, result.body) });
      return;
    }
    if (confirming.kind === 'leave') {
      setActionState({ kind: 'success', message: '조직에서 나왔습니다. 멤버십이 변경되어 다시 로그인해 주세요.' });
    } else if (confirming.kind === 'remove') {
      setMembers((rows) => rows.filter((member) => member.id !== (target as OrganizationMember).id));
      setActionState({ kind: 'success', message: '구성원을 제거했습니다.' });
    } else {
      setInvites((rows) => rows.map((invite) => invite.id === (target as OrganizationInvite).id ? { ...invite, revokedAt: new Date().toISOString() } : invite));
      setActionState({ kind: 'success', message: '초대를 취소했습니다.' });
    }
    setConfirming(null);
  }

  async function resend(invite: OrganizationInvite): Promise<void> {
    if (actionState.kind === 'pending') return;
    setActionState({ kind: 'pending' });
    const result = await request(`/organizations/${encodeURIComponent(organizationId)}/invites`, 'POST', { email: invite.email, role: invite.role });
    const issued = record(result.body)?.invite;
    if (!result.ok || !record(issued)) {
      setActionState({ kind: 'error', message: actionError(result.status, result.body) });
      return;
    }
    const replacement = issued as unknown as OrganizationInvite;
    setInvites((rows) => [replacement, ...rows.filter((row) => row.email !== replacement.email)]);
    setActionState({ kind: 'success', message: '새 초대를 요청했습니다.' });
  }

  const confirmationTitle = confirming?.kind === 'leave' ? '조직에서 나갈까요?' : confirming?.kind === 'remove' ? '구성원을 제거할까요?' : '초대를 취소할까요?';
  const confirmationDescription = confirming?.kind === 'leave'
    ? '이 조직의 프로젝트와 구성원 관리 권한을 잃습니다. 마지막 소유자는 먼저 다른 소유자를 지정해야 합니다.'
    : confirming?.kind === 'remove'
      ? '제거된 구성원은 이 조직의 프로젝트와 운영 정보에 접근할 수 없습니다.'
      : '이 초대 링크는 더 이상 사용할 수 없습니다.';

  return (
    <div className="flex flex-col gap-6">
      {actionState.kind === 'success' ? <Alert role="status" variant="notice"><AlertTitle>완료</AlertTitle><AlertDescription>{actionState.message}</AlertDescription></Alert> : null}
      {actionState.kind === 'error' ? <Alert role="alert" variant="destructive"><AlertTitle>작업을 완료하지 못했습니다.</AlertTitle><AlertDescription>{actionState.message}</AlertDescription></Alert> : null}
      <Card>
        <CardHeader><CardTitle><h2>구성원 초대</h2></CardTitle><CardDescription>초대받은 이메일과 인증된 계정 이메일이 같아야 초대를 수락할 수 있습니다.</CardDescription></CardHeader>
        <form onSubmit={submitInvite}>
          <CardContent><FieldGroup className="sm:grid sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end"><Field><FieldLabel htmlFor="organization-invite-email">이메일</FieldLabel><Input autoComplete="email" disabled={inviteState.kind === 'pending'} id="organization-invite-email" name="email" onChange={(event) => setInviteEmail(event.target.value)} required type="email" value={inviteEmail} /></Field><Field><FieldLabel htmlFor="organization-invite-role">역할</FieldLabel><Select disabled={inviteState.kind === 'pending'} id="organization-invite-role" onChange={(event) => setInviteRole(event.target.value as MembershipRole)} value={inviteRole}>{roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</Select></Field></FieldGroup></CardContent>
          <CardFooter className="flex flex-wrap justify-between gap-3"><div aria-live="polite">{inviteState.kind === 'success' ? <span className="text-sm text-muted-foreground">{inviteState.message}</span> : null}{inviteState.kind === 'error' ? <span className="text-sm text-destructive">{inviteState.message}</span> : null}</div><Button disabled={inviteState.kind === 'pending'} type="submit">{inviteState.kind === 'pending' ? <><Spinner data-icon="inline-start" />초대 요청 중</> : '초대 보내기'}</Button></CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle><h2>구성원</h2></CardTitle><CardDescription>역할 변경과 제거 권한은 서버가 현재 조직 멤버십으로 다시 확인합니다.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {members.map((member) => {
            const manageable = canManage(currentMember, member);
            return <article className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center" key={member.id}>
              <div className="flex min-w-0 flex-1 items-center gap-3"><UserAvatar avatarUrl={member.user.avatarUrl} email={member.user.email} name={member.user.name} /><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{member.user.name || member.user.email}</p><p className="truncate text-sm text-muted-foreground">{member.user.email}</p></div><Badge className="ml-auto" variant="secondary">{roleLabel(member.role)}</Badge></div>
              {manageable ? <div className="flex flex-wrap items-center gap-2"><Select aria-label={`${member.user.email} 역할`} className="w-36" disabled={actionState.kind === 'pending'} onChange={(event) => void changeRole(member, event.target.value)} value={member.role}>{roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</Select>{member.userId !== userId ? <Button disabled={actionState.kind === 'pending'} onClick={() => setConfirming({ kind: 'remove', target: member })} size="sm" type="button" variant="destructive">제거</Button> : null}</div> : null}
            </article>;
          })}
          {!members.length ? <p className="text-sm text-muted-foreground">표시할 구성원이 없습니다.</p> : null}
        </CardContent>
        {currentMember ? <CardFooter className="justify-end"><Button disabled={actionState.kind === 'pending'} onClick={() => setConfirming({ kind: 'leave', target: currentMember })} type="button" variant="outline">조직 나가기</Button></CardFooter> : null}
      </Card>

      <Card>
        <CardHeader><CardTitle><h2>보낸 초대</h2></CardTitle><CardDescription>다시 보내면 기존 초대 링크는 취소되고 새 링크가 발급됩니다.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {invites.map((invite) => <article className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center" key={invite.id}><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-foreground">{invite.email}</p><p className="text-xs text-muted-foreground">{roleLabel(invite.role)} · {invite.revokedAt ? '취소됨' : invite.acceptedAt ? '수락됨' : '대기 중'}</p></div>{!invite.revokedAt && !invite.acceptedAt ? <div className="flex flex-wrap gap-2"><Button disabled={actionState.kind === 'pending'} onClick={() => void resend(invite)} size="sm" type="button" variant="outline">다시 보내기</Button><Button disabled={actionState.kind === 'pending'} onClick={() => setConfirming({ kind: 'revoke', target: invite })} size="sm" type="button" variant="destructive">취소</Button></div> : null}</article>)}
          {!invites.length ? <p className="text-sm text-muted-foreground">보낸 초대가 없습니다.</p> : null}
        </CardContent>
      </Card>

      <Dialog onOpenChange={(open) => { if (!open) setConfirming(null); }} open={Boolean(confirming)}>
        <DialogContent><DialogHeader><DialogTitle>{confirmationTitle}</DialogTitle><DialogDescription>{confirmationDescription}</DialogDescription></DialogHeader><DialogFooter><Button onClick={() => setConfirming(null)} type="button" variant="outline">취소</Button><Button disabled={actionState.kind === 'pending'} onClick={() => void confirmAction()} type="button" variant={confirming?.kind === 'revoke' ? 'destructive' : 'default'}>{actionState.kind === 'pending' ? <><Spinner data-icon="inline-start" />처리 중</> : '계속'}</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}

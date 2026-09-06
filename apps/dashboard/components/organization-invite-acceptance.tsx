'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { apiAction } from '@/lib/api';

type AcceptanceState =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'accepted' | 'already-member' }>
  | Readonly<{ kind: 'login-required' }>
  | Readonly<{ kind: 'error' }>;

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function OrganizationInviteAcceptance({ token }: Readonly<{ token: string }>) {
  const [state, setState] = useState<AcceptanceState>({ kind: 'ready' });

  useEffect(() => {
    window.history.replaceState(null, '', '/organization-invites/accept');
  }, []);

  async function accept(): Promise<void> {
    if (state.kind === 'pending') return;
    setState({ kind: 'pending' });
    try {
      const response = await fetch(apiAction('/organization-invites/accept'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await responseBody(response);
      if (response.status === 401) {
        setState({ kind: 'login-required' });
        return;
      }
      if (!response.ok) {
        setState({ kind: 'error' });
        return;
      }
      const result = body && typeof body === 'object' ? body as { status?: unknown } : {};
      setState(result.status === 'already_member' ? { kind: 'already-member' } : result.status === 'accepted' ? { kind: 'accepted' } : { kind: 'error' });
    } catch {
      setState({ kind: 'error' });
    }
  }

  const complete = state.kind === 'accepted' || state.kind === 'already-member';
  return (
    <Card>
      <CardHeader><p className="text-xs font-medium text-muted-foreground">ORGANIZATION INVITE</p><CardTitle><h1>조직 초대</h1></CardTitle><CardDescription>초대를 수락하면 이 조직의 권한이 계정에 추가됩니다.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state.kind === 'login-required' ? <Alert variant="destructive"><AlertTitle>로그인 확인이 필요합니다.</AlertTitle><AlertDescription>초대받은 이메일로 인증된 계정에 로그인한 뒤, 보안을 위해 초대 이메일을 다시 열어 주세요.</AlertDescription></Alert> : null}
        {state.kind === 'error' ? <Alert variant="destructive"><AlertTitle>초대를 수락할 수 없습니다.</AlertTitle><AlertDescription>초대가 만료되었거나 취소되었을 수 있습니다. 초대받은 이메일과 인증된 계정을 확인한 뒤 새 초대를 요청해 주세요.</AlertDescription></Alert> : null}
        {complete ? <Alert role="status" variant="notice"><AlertTitle>{state.kind === 'accepted' ? '초대를 수락했습니다.' : '이미 이 조직의 구성원입니다.'}</AlertTitle><AlertDescription>멤버십이 변경되었으므로 다시 로그인한 뒤 콘솔을 열어 주세요.</AlertDescription></Alert> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        {state.kind === 'login-required' ? <Button render={<a href="/login" />}>로그인하기</Button> : null}
        {complete ? <Button render={<a href="/login" />}>다시 로그인하기</Button> : null}
        {!complete && state.kind !== 'login-required' ? <Button disabled={state.kind === 'pending'} onClick={() => void accept()} type="button">{state.kind === 'pending' ? <><Spinner data-icon="inline-start" />초대 수락 중</> : '초대 수락'}</Button> : null}
      </CardFooter>
    </Card>
  );
}

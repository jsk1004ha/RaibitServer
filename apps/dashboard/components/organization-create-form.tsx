'use client';

import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { apiAction } from '@/lib/api-action';

type CreateState =
  | Readonly<{ kind: 'idle' | 'pending' }>
  | Readonly<{ kind: 'error'; message: string }>
  | Readonly<{ kind: 'auth-required' }>
  | Readonly<{ kind: 'created-needs-reauthentication'; next: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiresReauthentication(body: unknown): boolean {
  const response = record(body);
  return response?.reauthenticationRequired === true || response?.requiresReauthentication === true;
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(status: number, body: unknown): string {
  const code = record(body)?.error;
  if (status === 401 || code === 'organization_creation_auth_required') return '보안을 위해 다시 로그인한 뒤 새 작업 공간을 만들어 주세요.';
  if (code === 'email_not_verified') return '이메일 인증을 완료한 뒤 새 작업 공간을 만들 수 있습니다.';
  if (code === 'account_not_approved') return '계정 승인이 완료된 뒤 새 작업 공간을 만들 수 있습니다.';
  if (code === 'account_banned') return '현재 계정에서는 새 작업 공간을 만들 수 없습니다.';
  if (status === 403) return '새 작업 공간은 이메일 인증과 승인된 계정에서만 만들 수 있습니다. 승인 상태를 확인해 주세요.';
  if (status === 409 || code === 'organization_slug_already_exists') return '이미 사용 중인 작업 공간 주소입니다. 다른 주소를 입력해 주세요.';
  if (status === 400) return '작업 공간 이름과 주소를 확인해 주세요.';
  return '작업 공간을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function OrganizationCreateForm() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [state, setState] = useState<CreateState>({ kind: 'idle' });

  async function createOrganization(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state.kind === 'pending') return;
    setState({ kind: 'pending' });
    try {
      const response = await fetch(apiAction('/organizations'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ name, slug }),
      });
      const body = await responsePayload(response);
      if (!response.ok) {
        setState(response.status === 401 ? { kind: 'auth-required' } : { kind: 'error', message: errorMessage(response.status, body) });
        return;
      }
      if (requiresReauthentication(body)) {
        const organization = record(record(body)?.organization);
        const organizationId = organization?.id;
        const next = typeof organizationId === 'string' && organizationId.trim()
          ? `/org/${encodeURIComponent(organizationId)}/projects` : '/console';
        setState({ kind: 'created-needs-reauthentication', next });
        return;
      }
      setState({ kind: 'error', message: '작업 공간 생성 결과를 확인하지 못했습니다. 다시 로그인한 뒤 새 작업 공간 목록을 확인해 주세요.' });
    } catch {
      setState({ kind: 'error', message: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle><h1>새 작업 공간 만들기</h1></CardTitle><CardDescription>프로젝트와 팀원을 함께 관리할 공간을 만듭니다.</CardDescription></CardHeader>
      <form onSubmit={createOrganization}>
        <CardContent className="flex flex-col gap-5"><FieldGroup><Field><FieldLabel htmlFor="organization-name">작업 공간 이름</FieldLabel><Input autoComplete="organization" disabled={state.kind === 'pending'} id="organization-name" maxLength={128} name="name" onChange={(event) => setName(event.target.value)} required value={name} /></Field><Field><FieldLabel htmlFor="organization-slug">작업 공간 주소</FieldLabel><Input aria-describedby="organization-slug-description" autoCapitalize="none" autoComplete="off" disabled={state.kind === 'pending'} id="organization-slug" maxLength={63} name="slug" onChange={(event) => setSlug(event.target.value.toLowerCase())} pattern="[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?" required value={slug} /><FieldDescription id="organization-slug-description">소문자, 숫자, 하이픈만 사용할 수 있습니다. 이미 사용 중인 주소는 선택할 수 없습니다.</FieldDescription></Field></FieldGroup>
          {state.kind === 'error' ? <Alert role="alert" variant="destructive"><AlertTitle>작업 공간을 만들지 못했습니다.</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
          {state.kind === 'auth-required' ? <Alert role="alert" variant="destructive"><AlertTitle>로그인이 필요합니다.</AlertTitle><AlertDescription>새 작업 공간이 만들어지지 않았습니다. 다시 로그인한 뒤 요청을 다시 시도해 주세요.</AlertDescription></Alert> : null}
          {state.kind === 'created-needs-reauthentication' ? <Alert role="status" variant="notice"><AlertTitle>새 작업 공간을 만들었습니다.</AlertTitle><AlertDescription>다시 로그인하면 새 작업 공간에서 프로젝트를 만들 수 있습니다.</AlertDescription></Alert> : null}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">{state.kind === 'auth-required' || state.kind === 'created-needs-reauthentication' ? <Button render={<a href={`/login?next=${encodeURIComponent(state.kind === 'created-needs-reauthentication' ? state.next : '/organizations/new')}`} />}>다시 로그인하기</Button> : <Button disabled={state.kind === 'pending'} type="submit">{state.kind === 'pending' ? <><Spinner data-icon="inline-start" />작업 공간 만드는 중</> : '작업 공간 만들기'}</Button>}</CardFooter>
      </form>
    </Card>
  );
}

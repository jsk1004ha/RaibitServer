'use client';

import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

const recoveryModes = ['forgot', 'reset'] as const;

type RecoveryMode = typeof recoveryModes[number];
type RequestTarget = 'request' | 'complete';
type RecoveryState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending'; target: RequestTarget }>
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'error'; target: RequestTarget; message: string }>;

function retryAfterSeconds(value: string | null): number {
  if (!value || !/^\d{1,4}$/.test(value)) return 0;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : 0;
}

function errorMessage(status: number, target: RequestTarget): string {
  if (status === 429) return '요청이 많습니다. 안내된 시간 뒤에 다시 시도해 주세요.';
  if (target === 'complete' && status === 403) return '코드가 올바르지 않거나 만료되었습니다. 새 코드를 요청해 다시 시도해 주세요.';
  if (target === 'complete' && status === 400) return '비밀번호는 8자 이상으로 입력해 주세요.';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function PasswordRecoveryForm({
  mode,
  requestAction,
  completeAction,
}: Readonly<{
  mode: RecoveryMode;
  requestAction: string;
  completeAction: string;
}>) {
  const [state, setState] = useState<RecoveryState>({ kind: 'idle' });
  const [requestedEmail, setRequestedEmail] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const messageRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const requestPending = state.kind === 'pending' && state.target === 'request';
  const completePending = state.kind === 'pending' && state.target === 'complete';
  const requestError = state.kind === 'error' && state.target === 'request' ? state.message : '';
  const completeError = state.kind === 'error' && state.target === 'complete' ? state.message : '';
  const showRequest = mode === 'forgot' && state.kind !== 'accepted' && state.kind !== 'completed'
    && !(state.kind === 'pending' && state.target === 'complete')
    && !(state.kind === 'error' && state.target === 'complete');
  const showComplete = mode === 'reset' || state.kind === 'accepted' || completePending || Boolean(completeError);
  const busy = requestPending || completePending;

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setCooldownSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);

  useEffect(() => {
    if (state.kind === 'accepted') codeRef.current?.focus();
    if (state.kind === 'error' || state.kind === 'completed') messageRef.current?.focus();
  }, [state.kind]);

  async function submitRequest(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || cooldownSeconds > 0) return;
    const email = new FormData(event.currentTarget).get('email');
    if (typeof email !== 'string') return;

    setState({ kind: 'pending', target: 'request' });
    try {
      const response = await fetch(requestAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
      if (response.status !== 202) {
        setCooldownSeconds(retryAfter);
        setState({ kind: 'error', target: 'request', message: errorMessage(response.status, 'request') });
        return;
      }
      setRequestedEmail(email.trim());
      setCooldownSeconds(retryAfter);
      setState({ kind: 'accepted' });
    } catch {
      setState({ kind: 'error', target: 'request', message: errorMessage(0, 'request') });
    }
  }

  async function submitComplete(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const formData = new FormData(event.currentTarget);
    const email = formData.get('email');
    const code = formData.get('code');
    const newPassword = formData.get('newPassword');
    const confirmPassword = formData.get('confirmPassword');
    if (typeof email !== 'string' || typeof code !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') return;
    if (newPassword !== confirmPassword) {
      setState({ kind: 'error', target: 'complete', message: '새 비밀번호와 확인 입력이 일치하지 않습니다.' });
      return;
    }

    setState({ kind: 'pending', target: 'complete' });
    try {
      const response = await fetch(completeAction, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), newPassword }),
      });
      if (response.status !== 200) {
        setState({ kind: 'error', target: 'complete', message: errorMessage(response.status, 'complete') });
        return;
      }
      setState({ kind: 'completed' });
    } catch {
      setState({ kind: 'error', target: 'complete', message: errorMessage(0, 'complete') });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {state.kind === 'accepted' ? <div ref={messageRef} tabIndex={-1}><Alert role="status" variant="notice"><AlertTitle>코드를 보냈습니다</AlertTitle><AlertDescription>입력하신 이메일로 계정 존재 여부와 관계없이 안내를 보냈습니다. 코드는 만료되거나 여러 번 틀리면 사용할 수 없습니다.</AlertDescription></Alert></div> : null}
      {state.kind === 'completed' ? <div ref={messageRef} tabIndex={-1}><Alert role="status" variant="notice"><AlertTitle>비밀번호를 변경했습니다</AlertTitle><AlertDescription>보안을 위해 자동 로그인하지 않습니다. 새 비밀번호로 로그인해 주세요.</AlertDescription></Alert></div> : null}
      {requestError ? <div ref={messageRef} tabIndex={-1}><Alert variant="destructive"><AlertTitle>확인해 주세요</AlertTitle><AlertDescription>{requestError}</AlertDescription></Alert></div> : null}
      {completeError ? <div ref={messageRef} tabIndex={-1}><Alert variant="destructive"><AlertTitle>확인해 주세요</AlertTitle><AlertDescription>{completeError}</AlertDescription></Alert></div> : null}

      {showRequest ? <form action={requestAction} method="post" onSubmit={submitRequest} className="auth-form">
        <input name="_returnTo" type="hidden" value="/login?mode=forgot" />
        <FieldGroup>
          <Field data-disabled={requestPending || cooldownSeconds > 0 || undefined} data-invalid={Boolean(requestError) || undefined}>
            <FieldLabel htmlFor="recovery-email">이메일</FieldLabel>
            <Input aria-invalid={Boolean(requestError) || undefined} autoComplete="email" disabled={requestPending || cooldownSeconds > 0} id="recovery-email" name="email" required type="email" />
            <FieldDescription>가입 여부와 관계없이 동일한 안내를 보냅니다.</FieldDescription>
          </Field>
          <Button disabled={requestPending || cooldownSeconds > 0} type="submit">
            {requestPending ? <Spinner data-icon="inline-start" /> : null}
            {requestPending ? '요청 중...' : cooldownSeconds > 0 ? `${cooldownSeconds}초 후 다시 요청` : '재설정 코드 받기'}
          </Button>
        </FieldGroup>
      </form> : null}

      {showComplete && state.kind !== 'completed' ? <form action={completeAction} method="post" onSubmit={submitComplete} className="auth-form">
        <input name="_returnTo" type="hidden" value="/login?mode=reset" />
        <FieldGroup>
          <Field data-disabled={completePending || undefined} data-invalid={Boolean(completeError) || undefined}>
            <FieldLabel htmlFor="reset-email">이메일</FieldLabel>
            <Input aria-invalid={Boolean(completeError) || undefined} autoComplete="email" defaultValue={requestedEmail} disabled={completePending} id="reset-email" name="email" required type="email" />
          </Field>
          <Field data-disabled={completePending || undefined} data-invalid={Boolean(completeError) || undefined}>
            <FieldLabel htmlFor="reset-code">6자리 재설정 코드</FieldLabel>
            <Input aria-invalid={Boolean(completeError) || undefined} autoComplete="one-time-code" disabled={completePending} id="reset-code" inputMode="numeric" maxLength={6} name="code" pattern="[0-9]{6}" ref={codeRef} required />
            <FieldDescription>코드는 6자리 숫자이며, 만료되거나 여러 번 틀리면 새 코드를 요청해야 합니다.</FieldDescription>
          </Field>
          <Field data-disabled={completePending || undefined} data-invalid={Boolean(completeError) || undefined}>
            <FieldLabel htmlFor="reset-password">새 비밀번호</FieldLabel>
            <Input aria-invalid={Boolean(completeError) || undefined} autoComplete="new-password" disabled={completePending} id="reset-password" minLength={8} name="newPassword" required type="password" />
            <FieldDescription>8자 이상으로 입력해 주세요.</FieldDescription>
          </Field>
          <Field data-disabled={completePending || undefined} data-invalid={Boolean(completeError) || undefined}>
            <FieldLabel htmlFor="reset-password-confirm">새 비밀번호 확인</FieldLabel>
            <Input aria-invalid={Boolean(completeError) || undefined} autoComplete="new-password" disabled={completePending} id="reset-password-confirm" minLength={8} name="confirmPassword" required type="password" />
          </Field>
          <Button disabled={completePending} type="submit">
            {completePending ? <Spinner data-icon="inline-start" /> : null}
            {completePending ? '변경 중...' : '비밀번호 변경'}
          </Button>
        </FieldGroup>
      </form> : null}

      {state.kind === 'completed' ? <a className="w-fit text-sm font-medium text-foreground underline underline-offset-4" href="/login?mode=login">로그인으로 이동</a> : null}
      {mode === 'forgot' && !showRequest && state.kind !== 'completed' ? <Button onClick={() => setState({ kind: 'idle' })} variant="outline">코드 다시 요청</Button> : null}
    </div>
  );
}

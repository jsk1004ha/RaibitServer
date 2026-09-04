'use client';

import type { FormEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { controlPlaneErrorCode } from '@/lib/control-plane-errors.js';

type PublicOperationError = Readonly<{
  code: string;
  retryable: boolean;
  message: string;
}>;

type OperationResult = Readonly<{
  operationId: string;
  status?: string;
  streamHref?: string;
}>;

type SubmitState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'success'; result: OperationResult }>
  | Readonly<{ kind: 'error'; error: PublicOperationError }>;

type FormValue = string | readonly string[];

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown, fallback: string, limit = 280): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, limit) : fallback;
}

function publicError(payload: unknown, status: number): PublicOperationError {
  const record = asRecord(payload);
  const error = asRecord(record?.error);
  const code = controlPlaneErrorCode(error ?? record, status);
  const permission = status === 401 || status === 403 || ['forbidden', 'permission_denied', 'authentication_required'].includes(code);
  const retryable = error?.retryable === true || (!permission && status >= 500);
  return {
    code,
    retryable,
    message: safeText(error?.message ?? record?.message, permission ? '이 작업을 실행할 권한이 없습니다.' : '요청을 처리하지 못했습니다.'),
  };
}

function operationResult(payload: unknown): OperationResult | null {
  const record = asRecord(payload);
  const operationId = safeText(record?.operationId, '', 200);
  if (!operationId) return null;
  const statusValue = record?.status ?? record?.state;
  const status = typeof statusValue === 'string' ? safeText(statusValue, '', 80) : undefined;
  const streamHref = typeof record?.streamHref === 'string' ? record.streamHref : undefined;
  return { operationId, ...(status ? { status } : {}), ...(streamHref ? { streamHref } : {}) };
}

function formPayload(formData: FormData): Readonly<Record<string, FormValue>> | null {
  const payload: Record<string, FormValue> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string') return null;
    const previous = payload[key];
    payload[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return payload;
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function sameOriginStreamHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && /^https?:$/.test(url.protocol)
      ? `${url.pathname}${url.search}${url.hash}`
      : null;
  } catch {
    return null;
  }
}

export function OperationSubmit({
  action,
  children,
  className,
  disabled = false,
  id,
  pendingLabel = '요청을 확인하고 있습니다.',
  returnTo,
  submitClassName,
  submitLabel,
}: Readonly<{
  action: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
  pendingLabel?: string;
  returnTo: string;
  submitClassName: string;
  submitLabel: string;
}>) {
  const running = useRef(false);
  const focusOrigin = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const busy = state.kind === 'pending';
  const streamHref = state.kind === 'success' ? sameOriginStreamHref(state.result.streamHref) : null;

  useEffect(() => {
    if (busy || !focusOrigin.current) return;
    const origin = focusOrigin.current;
    focusOrigin.current = null;
    if (document.activeElement === document.body && origin.isConnected && !origin.disabled) origin.focus();
  }, [busy]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    if (running.current || disabled) {
      event.preventDefault();
      return;
    }
    const formData = new FormData(event.currentTarget);
    const body = formPayload(formData);
    if (!body) return;

    event.preventDefault();
    running.current = true;
    focusOrigin.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setState({ kind: 'pending' });
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        setState({ kind: 'error', error: publicError(payload, response.status) });
        return;
      }
      const result = operationResult(payload);
      if (!result) {
        setState({ kind: 'error', error: { code: 'invalid_operation_response', retryable: false, message: '서버 응답에 작업 식별자가 없습니다. 현재 상태를 새로 고쳐 확인하세요.' } });
        return;
      }
      setState({ kind: 'success', result });
    } catch {
      setState({ kind: 'error', error: { code: 'operation_request_unavailable', retryable: true, message: '응답을 받지 못했습니다. 현재 상태를 확인한 뒤 다시 시도하세요.' } });
    } finally {
      running.current = false;
    }
  }

  return (
    <form action={action} className={className} id={id} method="post" onSubmit={submit}>
      <input name="_returnTo" type="hidden" value={returnTo} />
      {children}
      <div aria-atomic="true" aria-live="polite" className="flex min-w-0 flex-col gap-raibit-sm">
        {busy ? <p role="status" className="text-sm text-muted-foreground">{pendingLabel}</p> : null}
        {state.kind === 'success' ? <Alert variant="notice"><AlertTitle>작업 요청을 접수했습니다.</AlertTitle><AlertDescription className="break-words [overflow-wrap:anywhere]">작업 ID: <span className="font-mono">{state.result.operationId}</span>{state.result.status ? <span className="block">서버 확인 상태: {state.result.status}</span> : null}{streamHref ? <a className="mt-raibit-xs block w-fit" href={streamHref}>작업 스트림 열기</a> : null}</AlertDescription></Alert> : null}
        {state.kind === 'error' ? <Alert variant="destructive"><AlertTitle>{state.error.code === 'forbidden' || state.error.code === 'permission_denied' || state.error.code === 'authentication_required' ? '권한 확인 필요' : state.error.retryable ? '다시 시도할 수 있습니다' : '작업 요청을 확인하세요'}</AlertTitle><AlertDescription className="break-words [overflow-wrap:anywhere]">{state.error.message}<span className="block font-mono text-xs">{state.error.code}</span>{state.error.retryable ? <span className="block">현재 상태를 확인한 뒤 다시 시도할 수 있습니다.</span> : null}</AlertDescription></Alert> : null}
      </div>
      <button aria-busy={busy} className={submitClassName} disabled={disabled || busy} type="submit">{busy ? pendingLabel : submitLabel}</button>
    </form>
  );
}

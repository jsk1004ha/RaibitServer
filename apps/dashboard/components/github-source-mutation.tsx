'use client';

import type { FormEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { CircleCheckIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { GitHubConflictRecovery, githubConflictFromPayload } from './github-conflict-recovery';

type Intent = { readonly fingerprint: string; readonly idempotencyKey: string };
type State = 'idle' | 'pending' | 'success' | 'error';

type Props = {
  readonly action: string;
  readonly catalogHref: (installationId: string) => string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly formId?: string;
  readonly pendingLabel: string;
  readonly projectHrefs: Readonly<Record<string, string>>;
  readonly returnTo: string;
  readonly submitLabel: string;
};

export function GitHubSourceMutation({ action, catalogHref, children, disabled = false, formId, pendingLabel, projectHrefs, returnTo, submitLabel }: Props) {
  const intent = useRef<Intent | null>(null);
  const focusOrigin = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<State>('idle');
  const [conflict, setConflict] = useState<ReturnType<typeof githubConflictFromPayload>>(null);
  const busy = state === 'pending';

  useEffect(() => {
    if (busy || !focusOrigin.current) return;
    const origin = focusOrigin.current;
    focusOrigin.current = null;
    if (document.activeElement === document.body && origin.isConnected && !origin.disabled) origin.focus();
  }, [busy]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || disabled) return;
    const body = mutationBody(new FormData(event.currentTarget));
    if (!body) {
      setState('error');
      return;
    }
    const fingerprint = JSON.stringify(Object.entries(body).sort(([left], [right]) => left.localeCompare(right)));
    const idempotencyKey = intent.current?.fingerprint === fingerprint ? intent.current.idempotencyKey : crypto.randomUUID();
    intent.current = { fingerprint, idempotencyKey };
    focusOrigin.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setConflict(null);
    setState('pending');
    try {
      const response = await fetch(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, idempotencyKey }),
      });
      const payload = await responsePayload(response);
      if (response.ok) {
        setState('success');
        return;
      }
      const parsedConflict = githubConflictFromPayload(payload);
      setConflict(parsedConflict);
      setState('error');
    } catch (error) {
      if (error instanceof TypeError) {
        setState('error');
        return;
      }
      throw error;
    }
  }

  function focusField(id: string): void {
    const element = document.getElementById(id);
    if (element instanceof HTMLInputElement) element.focus();
  }

  return (
    <form action={action} id={formId} method="post" onSubmit={submit}>
      <input name="_returnTo" type="hidden" value={returnTo} />
      {children}
      <div aria-atomic="true" aria-live="polite" className="mt-4 flex flex-col items-start gap-3">
        {busy ? <p role="status" className="text-sm text-muted-foreground"><Spinner data-icon="inline-start" />{pendingLabel}</p> : null}
        {state === 'success' ? <Alert role="status" variant="notice"><CircleCheckIcon /><AlertTitle>요청이 완료되었습니다.</AlertTitle><AlertDescription>같은 요청 키로 중복 생성하지 않았습니다. <a href={returnTo}>다음 단계로 이동</a></AlertDescription></Alert> : null}
        {state === 'error' && conflict ? <GitHubConflictRecovery catalogHref={catalogHref} conflict={conflict} onCancel={() => setConflict(null)} onFocusBranch={() => focusField('github-attach-branch')} onFocusSlug={() => focusField('github-import-service-slug')} projectHrefs={projectHrefs} /> : null}
        {state === 'error' && !conflict ? <Alert variant="destructive"><AlertTitle>요청을 처리하지 못했습니다.</AlertTitle><AlertDescription>현재 상태를 확인한 뒤 다시 시도하세요. 기존 연결을 덮어쓰지 않았습니다.</AlertDescription></Alert> : null}
      </div>
      <div className="mt-4 flex justify-end"><Button aria-busy={busy} disabled={disabled || busy} type="submit">{busy ? <><Spinner data-icon="inline-start" />{pendingLabel}</> : submitLabel}</Button></div>
    </form>
  );
}

function mutationBody(formData: FormData): Readonly<Record<string, string | number>> | null {
  const output: Record<string, string | number> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string' || key === '_returnTo') return null;
    if (key === 'expectedCatalogGeneration') {
      if (!/^\d+$/.test(value)) return null;
      output[key] = Number(value);
      continue;
    }
    if ((key === 'serviceSlug' || key === 'serviceName') && value === '') continue;
    output[key] = value;
  }
  return output;
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

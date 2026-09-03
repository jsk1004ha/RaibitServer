'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { ResourceAvailabilitySchema, ResourceProvisionResultSchema } from '@raibitserver/schemas';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

type Intent = 'preview-plan' | 'live-provision';
type Result = z.infer<typeof ResourceProvisionResultSchema>;
type ActionState = { status: 'idle' } | { status: 'loading'; intent: Intent } | { status: 'result'; result: Result } | { status: 'error'; message: string };
const responseSchema = z.object({ result: ResourceProvisionResultSchema });

export function ResourceProvisionActions({ action, availability, resourceStatus }: Readonly<{ action: string; availability: unknown; resourceStatus: string }>) {
  const router = useRouter();
  const running = useRef(false);
  const focusOrigin = useRef<{ button: HTMLButtonElement; moved: boolean } | null>(null);
  const [state, setState] = useState<ActionState>({ status: 'idle' });
  const parsed = ResourceAvailabilitySchema.safeParse(availability);
  const allowed = parsed.success ? parsed.data : null;
  const busy = state.status === 'loading';
  const canPreview = allowed?.permitted === true && allowed.preview;
  const canLive = allowed?.permitted === true && allowed.live && !['READY', 'RECONCILING', 'DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(resourceStatus.toUpperCase());

  useEffect(() => {
    const origin = focusOrigin.current;
    if (!origin) return;
    if (!busy) {
      focusOrigin.current = null;
      if (!origin.moved && document.activeElement === document.body && origin.button.isConnected && !origin.button.disabled) origin.button.focus();
      return;
    }
    const moved = () => { origin.moved = true; };
    const focused = (event: FocusEvent) => { if (event.target !== origin.button && event.target !== document.body) moved(); };
    const keyPressed = (event: KeyboardEvent) => { if (event.key === 'Tab') moved(); };
    document.addEventListener('pointerdown', moved);
    document.addEventListener('focusin', focused);
    document.addEventListener('keydown', keyPressed);
    return () => {
      document.removeEventListener('pointerdown', moved);
      document.removeEventListener('focusin', focused);
      document.removeEventListener('keydown', keyPressed);
    };
  }, [busy]);

  async function request(intent: Intent, button: HTMLButtonElement): Promise<void> {
    if (running.current || (intent === 'preview-plan' ? !canPreview : !canLive)) return;
    focusOrigin.current = document.activeElement === button ? { button, moved: false } : null;
    running.current = true;
    setState({ status: 'loading', intent });
    try {
      const response = await fetch(action, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ intent }) });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setState({ status: 'error', message: '요청이 거부되었습니다. 서버의 엔진 지원 상태, 권한과 리소스 상태를 확인해 주세요.' });
        return;
      }
      const result = responseSchema.safeParse(payload);
      if (!result.success || result.data.result.intent !== intent) {
        setState({ status: 'error', message: '서버 응답을 확인할 수 없습니다. 실행 완료로 간주하지 말고 현재 상태를 다시 확인해 주세요.' });
        return;
      }
      setState({ status: 'result', result: result.data.result });
      if (intent === 'live-provision') router.refresh();
    } catch {
      setState({ status: 'error', message: '응답을 받지 못했습니다. 다시 요청하기 전에 현재 리소스 상태를 확인해 주세요.' });
    } finally {
      running.current = false;
    }
  }

  return (
    <Card id="provisioning">
      <CardHeader><CardTitle><h2>프로비저닝</h2></CardTitle><CardDescription>계획 미리보기와 실제 실행 요청은 별도 작업입니다.</CardDescription></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-raibit-lg">
        <p className="text-sm text-muted-foreground">미리보기는 저장된 상태와 실행 대기열을 바꾸지 않습니다. 실제 실행 요청은 Go 공급자에 전달할 희망 상태를 저장하며, 연결 검증 전에는 준비 완료가 아닙니다.</p>
        <Alert><AlertTitle>현재 서버: {allowed?.environment === 'local' ? '로컬 전용' : allowed?.environment === 'release' ? '운영 릴리스' : '설정 확인 필요'}</AlertTitle><AlertDescription>{canLive ? '로컬 검증용 실행 요청이 가능합니다. 운영 릴리스 지원을 의미하지 않습니다.' : '현재 엔진, 권한 또는 리소스 상태에서는 실제 실행을 요청할 수 없습니다.'}<span className="block break-all font-mono text-xs">{allowed?.reasonCode ?? 'RESOURCE_ENVIRONMENT_UNAVAILABLE'}</span></AlertDescription></Alert>
        <div aria-live="polite" aria-atomic="true" className="min-w-0">
          {busy ? <p role="status" className="text-sm">{state.intent === 'preview-plan' ? '계획을 확인하고 있습니다.' : '실제 실행을 요청하고 있습니다.'}</p> : null}
          {state.status === 'error' ? <Alert variant="destructive"><AlertTitle>요청 확인 필요</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
          {state.status === 'result' ? <Alert><AlertTitle>{state.result.intent === 'preview-plan' ? '계획 미리보기 완료 · 실행하지 않음' : '실행 요청 접수 · 준비 완료 아님'}</AlertTitle><AlertDescription>{state.result.intent === 'preview-plan' ? '리소스 상태와 실행 대기열은 변경되지 않았습니다.' : '상태는 PROVISIONING입니다. 실제 준비 여부는 공급자의 연결 검증 후 확인하세요.'}</AlertDescription></Alert> : null}
        </div>
        {state.status === 'result' && state.result.intent === 'preview-plan' ? <section aria-label="프로비저닝 계획" className="min-w-0"><h3 className="mb-raibit-sm text-sm font-medium">공급자 계획 · PLAN_ONLY</h3><pre tabIndex={0} aria-label="공급자 계획 내용" className="code-panel max-h-80 overflow-auto p-raibit-lg text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(state.result.plan, null, 2)}</pre></section> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-raibit-sm">
        <Button variant="outline" type="button" disabled={busy || !canPreview} aria-busy={busy && state.intent === 'preview-plan'} onClick={(event) => request('preview-plan', event.currentTarget)}>계획 미리보기</Button>
        <Button type="button" disabled={busy || !canLive} aria-busy={busy && state.intent === 'live-provision'} onClick={(event) => request('live-provision', event.currentTarget)}>실제 실행 요청</Button>
      </CardFooter>
    </Card>
  );
}

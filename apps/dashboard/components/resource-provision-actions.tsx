'use client';

import { ResourceAvailabilitySchema } from '@raibitserver/schemas';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { OperationSubmit } from '@/components/operation-submit';

type Intent = 'preview-plan' | 'live-provision';

export function ResourceProvisionActions({ action, availability, resourceStatus, returnTo }: Readonly<{ action: string; availability: unknown; resourceStatus: string; returnTo: string }>) {
  const parsed = ResourceAvailabilitySchema.safeParse(availability);
  const allowed = parsed.success ? parsed.data : null;
  const canPreview = allowed?.permitted === true && allowed.preview;
  const canLive = allowed?.permitted === true && allowed.live && !['READY', 'RECONCILING', 'DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(resourceStatus.toUpperCase());

  return (
    <Card id="provisioning">
      <CardHeader><CardTitle><h2>프로비저닝</h2></CardTitle><CardDescription className="break-keep">계획 미리보기와 실제 실행 요청은 별도 작업입니다.</CardDescription></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-raibit-lg">
        <p className="break-keep text-sm text-muted-foreground">미리보기는 저장된 상태와 실행 대기열을 <span className="whitespace-nowrap">바꾸지 않습니다</span>. 실제 실행 요청은 Go 공급자에 전달할 희망 상태를 저장하며, 연결 검증 전에는 준비 완료가 아닙니다.</p>
        <Alert className="break-keep"><AlertTitle>현재 서버: {allowed?.environment === 'local' ? '로컬 전용' : allowed?.environment === 'release' ? '운영 릴리스' : '설정 확인 필요'}</AlertTitle><AlertDescription>{canLive ? '로컬 검증용 실행 요청이 가능합니다. 운영 릴리스 지원을 의미하지 않습니다.' : '현재 엔진, 권한 또는 리소스 상태에서는 실제 실행을 요청할 수 없습니다.'}<span className="block break-all font-mono text-xs">{allowed?.reasonCode ?? 'RESOURCE_ENVIRONMENT_UNAVAILABLE'}</span></AlertDescription></Alert>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-raibit-sm">
        <OperationSubmit action={action} className="contents" disabled={!canPreview} pendingLabel="계획 요청을 확인하고 있습니다." returnTo={returnTo} submitClassName={buttonVariants({ variant: 'outline' })} submitLabel="계획 미리보기"><input name="intent" type="hidden" value="preview-plan" /></OperationSubmit>
        <OperationSubmit action={action} className="contents" disabled={!canLive} pendingLabel="실제 실행 요청을 확인하고 있습니다." returnTo={returnTo} submitClassName={buttonVariants()} submitLabel="실제 실행 요청"><input name="intent" type="hidden" value="live-provision" /></OperationSubmit>
      </CardFooter>
    </Card>
  );
}

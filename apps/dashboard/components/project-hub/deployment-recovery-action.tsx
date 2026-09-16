'use client';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { OperationSubmit } from '@/components/operation-submit';
import type { DeploymentHistoryAction } from './deployment-history-model';

const actionLabels: Readonly<Record<DeploymentHistoryAction['type'], string>> = {
  retry: '재시도',
  redeploy: '재배포',
  cancel: '취소',
  rollback: '롤백',
};

const actionDescriptions: Readonly<Record<DeploymentHistoryAction['type'], string>> = {
  retry: '같은 불변 스냅샷으로 후속 배포를 하나만 요청합니다.',
  redeploy: '현재 서비스 구성을 새 배포로 요청합니다.',
  cancel: '진행 중인 배포의 중단을 요청합니다.',
  rollback: '서버가 확인한 이전 READY 배포를 대상으로 롤백을 요청합니다.',
};

export function DeploymentRecoveryAction({ action, idempotencyKey, returnTo }: Readonly<{
  action: DeploymentHistoryAction;
  idempotencyKey: string | null;
  returnTo: string;
}>) {
  const label = actionLabels[action.type];
  const requiresIdempotencyKey = action.type === 'retry' || action.type === 'redeploy';
  const hasRequiredKey = !requiresIdempotencyKey || (idempotencyKey !== null && action.snapshotVersion !== null);
  const disabled = !hasRequiredKey;

  return <Dialog>
    <DialogTrigger render={<Button size="sm" variant={action.type === 'cancel' || action.type === 'rollback' ? 'destructive' : 'outline'} disabled={disabled} />}>
      {label}
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{label} 요청 확인</DialogTitle>
        <DialogDescription>{actionDescriptions[action.type]} 작업 요청은 완료를 의미하지 않으며, 서버 상태와 작업 스트림에서 결과를 확인합니다.</DialogDescription>
      </DialogHeader>
      <OperationSubmit action={`/api/control${action.href}`} pendingLabel={`${label} 요청을 확인하고 있습니다.`} returnTo={returnTo} submitClassName={buttonVariants({ variant: action.type === 'cancel' || action.type === 'rollback' ? 'destructive' : 'default' })} submitLabel={`${label} 요청`}>
        {requiresIdempotencyKey && idempotencyKey !== null ? <input name="requestIdempotencyKey" type="hidden" value={idempotencyKey} /> : null}
        {requiresIdempotencyKey && action.snapshotVersion !== null ? <input name="snapshotVersion" type="hidden" value={String(action.snapshotVersion)} /> : null}
        {action.type === 'rollback' ? <input name="confirmed" type="hidden" value="true" /> : null}
      </OperationSubmit>
      <DialogFooter showCloseButton />
    </DialogContent>
  </Dialog>;
}

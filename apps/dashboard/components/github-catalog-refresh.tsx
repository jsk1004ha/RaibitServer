'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

type Props = {
  readonly installationId: string;
  readonly expectedIntegrationVersion: number;
  readonly expectedGeneration: number;
  readonly canRefresh: boolean;
  readonly refreshing: boolean;
};

type RequestState = 'idle' | 'pending' | 'success' | 'stale' | 'error';

export function GitHubCatalogRefresh({ installationId, expectedIntegrationVersion, expectedGeneration, canRefresh, refreshing }: Props) {
  const router = useRouter();
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const canSubmit = canRefresh && !refreshing && requestState !== 'pending';

  async function refresh() {
    if (!canSubmit) return;
    setRequestState('pending');
    try {
      const response = await fetch(`/api/control/github/installations/${encodeURIComponent(installationId)}/repositories/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedIntegrationVersion, expectedGeneration }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && isRefreshed(payload)) {
        setRequestState('success');
        router.refresh();
        return;
      }
      setRequestState(response.status === 409 ? 'stale' : 'error');
    } catch (error) {
      if (error instanceof TypeError) {
        setRequestState('error');
        return;
      }
      throw error;
    }
  }

  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <Button disabled={!canSubmit} onClick={refresh} type="button" variant="outline">
        {requestState === 'pending' || refreshing ? <><Spinner data-icon="inline-start" />새로고침 중</> : requestState === 'stale' || requestState === 'error' ? '새로고침 다시 시도' : '저장소 새로고침'}
      </Button>
      {!canRefresh ? <p className="text-sm text-muted-foreground">OWNER 또는 ADMIN만 연결된 GitHub 소스를 새로고침할 수 있습니다.</p> : null}
      {requestState === 'success' ? <Alert role="status" variant="notice"><CircleCheckIcon /><AlertTitle>저장소 목록을 새로고침했습니다.</AlertTitle><AlertDescription>최신 목록을 표시합니다.</AlertDescription></Alert> : null}
      {requestState === 'stale' ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>목록 상태가 변경되었습니다.</AlertTitle><AlertDescription>최신 목록을 확인한 뒤 다시 시도하세요.</AlertDescription></Alert> : null}
      {requestState === 'error' ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>저장소 목록을 새로고침하지 못했습니다.</AlertTitle><AlertDescription>권한과 연결 상태를 확인한 뒤 다시 시도하세요.</AlertDescription></Alert> : null}
    </div>
  );
}

function isRefreshed(value: unknown): boolean {
  return isRecord(value) && value.refreshed === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

'use client';

import { useState } from 'react';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';

export const githubLifecycleStatuses = ['ACTIVE', 'SUSPENDED', 'DISCONNECTED', 'DELETED'] as const;
export type GitHubLifecycleStatus = typeof githubLifecycleStatuses[number];

export type GitHubLifecycleIntegration = {
  readonly id: string;
  readonly organizationId: string;
  readonly accountLogin: string | null;
  readonly installationId: string | null;
  readonly status: GitHubLifecycleStatus;
  readonly version: number;
  readonly connected: boolean;
  readonly credentialIssuance: 'allowed' | 'denied';
  readonly externalGitHubSettingsUrl: string;
  readonly reattachUrl: string;
};

type Props = {
  readonly integration: GitHubLifecycleIntegration;
  readonly canDisconnect: boolean;
};

type RequestState = 'idle' | 'pending' | 'success' | 'stale' | 'error';

const statusContent: Readonly<Record<GitHubLifecycleStatus, { readonly label: string; readonly variant: 'default' | 'secondary' | 'destructive' | 'outline'; readonly description: string }>> = {
  ACTIVE: { label: '연결됨', variant: 'default', description: '새 빌드에서 GitHub 소스 접근을 사용할 수 있습니다.' },
  SUSPENDED: { label: '일시 중지됨', variant: 'outline', description: 'GitHub 설치가 일시 중지되어 새 빌드의 소스 접근이 차단되었습니다.' },
  DISCONNECTED: { label: 'RAIBITSERVER 연결 해제됨', variant: 'secondary', description: 'RAIBITSERVER의 설치 바인딩과 향후 자격 증명 발급이 해제되었습니다.' },
  DELETED: { label: 'GitHub 설치 삭제됨', variant: 'destructive', description: 'GitHub에서 설치가 삭제되어 새 빌드의 소스 접근이 차단되었습니다.' },
};

export function GitHubLifecycleControls({ integration, canDisconnect }: Props) {
  const [status, setStatus] = useState(integration.status);
  const [version, setVersion] = useState(integration.version);
  const [connected, setConnected] = useState(integration.connected);
  const [credentialIssuance, setCredentialIssuance] = useState(integration.credentialIssuance);
  const [confirmed, setConfirmed] = useState(false);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const current = statusContent[status];
  const canSubmit = canDisconnect && connected && requestState !== 'pending' && confirmed;
  const settingsUrl = safeGitHubSettingsUrl(integration.externalGitHubSettingsUrl);
  const reattachUrl = safeReattachUrl(integration.reattachUrl);

  async function disconnect() {
    if (!canSubmit) return;
    setRequestState('pending');
    try {
      const response = await fetch(`/api/control/organizations/${encodeURIComponent(integration.organizationId)}/integrations/github/${encodeURIComponent(integration.id)}/disconnect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const disconnected = disconnectedIntegration(payload);
      if (response.ok && disconnected) {
        setStatus(disconnected.status);
        setVersion(disconnected.version);
        setConnected(false);
        setCredentialIssuance(disconnected.credentialIssuance);
        setConfirmed(false);
        setRequestState('success');
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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle><h2>연결 상태</h2></CardTitle>
          <Badge variant={current.variant}>{current.label}</Badge>
        </div>
        <CardDescription>{integration.accountLogin || 'GitHub 계정'} · 버전 {version}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{current.description}</p>
        <p className="text-sm text-muted-foreground">새 빌드 자격 증명: {credentialIssuance === 'allowed' ? '발급 가능' : '발급 차단됨'}</p>
        <Alert variant="default">
          <CircleAlertIcon />
          <AlertTitle>배포 중인 서비스는 유지됩니다.</AlertTitle>
          <AlertDescription>현재 배포된 서비스는 계속 실행됩니다. 이 연결을 해제하거나 GitHub 접근이 해제되면 이후 빌드의 소스 접근만 차단됩니다.</AlertDescription>
        </Alert>
        {requestState === 'success' ? (
          <Alert role="status" variant="notice">
            <CircleCheckIcon />
            <AlertTitle>RAIBITSERVER 연결이 해제되었습니다.</AlertTitle>
            <AlertDescription>GitHub App은 제거되지 않습니다. 신뢰된 설치 또는 콜백 흐름으로 다시 연결하세요.</AlertDescription>
          </Alert>
        ) : null}
        {requestState === 'stale' ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>연결 상태가 변경되었습니다.</AlertTitle>
            <AlertDescription>최신 상태를 확인한 뒤 다시 시도하세요.</AlertDescription>
          </Alert>
        ) : null}
        {requestState === 'error' ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>연결을 해제하지 못했습니다.</AlertTitle>
            <AlertDescription>권한과 연결 상태를 확인한 뒤 다시 시도하세요.</AlertDescription>
          </Alert>
        ) : null}
        {canDisconnect && connected ? (
          <FieldGroup>
            <Field data-disabled={requestState === 'pending' || undefined} orientation="horizontal">
              <Checkbox aria-label="RAIBITSERVER 연결 해제의 영향을 확인했습니다." checked={confirmed} disabled={requestState === 'pending'} id={`github-disconnect-${integration.id}`} onCheckedChange={setConfirmed} />
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor={`github-disconnect-${integration.id}`}>RAIBITSERVER 연결 해제의 영향을 확인했습니다.</FieldLabel>
                <FieldDescription>GitHub App은 제거하지 않으며, 새 빌드만 GitHub 소스에 접근할 수 없게 됩니다.</FieldDescription>
              </div>
            </Field>
          </FieldGroup>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {settingsUrl ? <a className="text-sm font-medium text-primary underline-offset-4 hover:underline" href={settingsUrl} rel="noreferrer" target="_blank">GitHub 설치 설정 열기</a> : null}
        {!connected && reattachUrl ? <a className="text-sm font-medium text-primary underline-offset-4 hover:underline sm:mr-auto" href={reattachUrl}>신뢰된 연결 흐름으로 다시 연결</a> : null}
        {canDisconnect && connected ? <Button disabled={!canSubmit} onClick={disconnect} type="button" variant="destructive">{requestState === 'pending' ? <><Spinner data-icon="inline-start" />연결 해제 중</> : 'RAIBITSERVER 연결 해제'}</Button> : null}
      </CardFooter>
    </Card>
  );
}

function safeGitHubSettingsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeReattachUrl(value: string): string | null {
  try {
    const url = new URL(value, 'https://dashboard.invalid');
    return url.origin === 'https://dashboard.invalid' && (url.pathname === '/github' || url.pathname === '/github/install')
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}

function disconnectedIntegration(value: unknown): { readonly status: 'DISCONNECTED'; readonly version: number; readonly credentialIssuance: 'denied' } | null {
  if (!isRecord(value) || !isRecord(value.integration)) return null;
  const { status, version, credentialIssuance } = value.integration;
  return status === 'DISCONNECTED' && credentialIssuance === 'denied' && typeof version === 'number' && Number.isSafeInteger(version) && version > 0
    ? { status, version, credentialIssuance }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ActionLink, Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { apiAction } from '@/lib/api';
import type { CustomDomainRecord, ProjectHubData, ServiceRecord } from './types';

const MAX_STATUS_POLLS = 6;
const STATUS_POLL_INTERVAL_MS = 5_000;

type JsonRecord = Readonly<Record<string, unknown>>;
type Challenge = Readonly<{ domainId: string; hostname: string; token: string; operation: 'domains-create' | 'domains-rotate' }>;
type DomainOperation = 'domains-create' | 'domains-rotate' | 'domains-verify' | 'domains-status' | 'domains-delete';
type Mutation = Readonly<{ kind: 'idle' }> | Readonly<{ kind: 'pending'; operation: DomainOperation }> | Readonly<{ kind: 'error'; operation: DomainOperation; code: string }> | Readonly<{ kind: 'success'; operation: DomainOperation }>;

const statusLabels: Record<string, string> = {
  PENDING_VERIFICATION: '검증 대기', VERIFIED: '검증됨', ROUTING: '경로 준비 중', READY: '준비됨', FAILED: '확인 필요', DELETING: '삭제 정리 중',
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : count(value);
}

function customDomain(value: unknown): CustomDomainRecord | null {
  const domain = record(value);
  const cleanup = record(domain?.cleanupBarrier);
  const id = text(domain?.id);
  const organizationId = text(domain?.organizationId);
  const projectId = text(domain?.projectId);
  const serviceId = text(domain?.serviceId);
  const hostname = text(domain?.hostname);
  const status = text(domain?.status);
  const verificationVersion = count(domain?.verificationVersion);
  const issuedAt = nullableText(domain?.issuedAt);
  const expiresAt = nullableText(domain?.expiresAt);
  const verifiedAt = nullableText(domain?.verifiedAt);
  const verificationRequestedAt = nullableText(domain?.verificationRequestedAt);
  const lastCheckedAt = nullableText(domain?.lastCheckedAt);
  const nextCheckAt = nullableText(domain?.nextCheckAt);
  const consecutiveFailures = count(domain?.consecutiveFailures);
  const tlsStatus = text(domain?.tlsStatus);
  const desiredGeneration = count(domain?.desiredGeneration);
  const controllerLeaseGeneration = nullableCount(domain?.controllerLeaseGeneration);
  const certificateObservedGeneration = nullableCount(domain?.certificateObservedGeneration);
  const routeObservedGeneration = nullableCount(domain?.routeObservedGeneration);
  const deletionRequestedAt = nullableText(domain?.deletionRequestedAt);
  const actorUserId = nullableText(domain?.actorUserId);
  const lastErrorCode = nullableText(domain?.lastErrorCode);
  const lastErrorMessage = nullableText(domain?.lastErrorMessage);
  const createdAt = text(domain?.createdAt);
  const updatedAt = text(domain?.updatedAt);
  const cleanupVersion = count(cleanup?.version);
  const cleanupBarrier = domain?.cleanupBarrier === null ? null : cleanup && cleanupVersion !== null && typeof cleanup.complete === 'boolean'
    ? { version: cleanupVersion, certificateAbsentObservedVersion: nullableCount(cleanup.certificateAbsentObservedVersion), routeAbsentObservedVersion: nullableCount(cleanup.routeAbsentObservedVersion), complete: cleanup.complete }
    : null;
  if (!id || !organizationId || !projectId || !serviceId || !hostname || !status || verificationVersion === null || (issuedAt === null && domain?.issuedAt !== null) || (expiresAt === null && domain?.expiresAt !== null) || (verifiedAt === null && domain?.verifiedAt !== null) || (verificationRequestedAt === null && domain?.verificationRequestedAt !== null) || (lastCheckedAt === null && domain?.lastCheckedAt !== null) || (nextCheckAt === null && domain?.nextCheckAt !== null) || consecutiveFailures === null || !tlsStatus || desiredGeneration === null || (controllerLeaseGeneration === null && domain?.controllerLeaseGeneration !== null) || (certificateObservedGeneration === null && domain?.certificateObservedGeneration !== null) || (routeObservedGeneration === null && domain?.routeObservedGeneration !== null) || (deletionRequestedAt === null && domain?.deletionRequestedAt !== null) || (actorUserId === null && domain?.actorUserId !== null) || (lastErrorCode === null && domain?.lastErrorCode !== null) || (lastErrorMessage === null && domain?.lastErrorMessage !== null) || !createdAt || !updatedAt || (domain?.cleanupBarrier !== null && !cleanupBarrier)) return null;
  return { id, organizationId, projectId, serviceId, hostname, status, verificationVersion, issuedAt, expiresAt, verifiedAt, verificationRequestedAt, lastCheckedAt, nextCheckAt, consecutiveFailures, tlsStatus, desiredGeneration, controllerLeaseGeneration, certificateObservedGeneration, routeObservedGeneration, cleanupBarrier, deletionRequestedAt, actorUserId, lastErrorCode, lastErrorMessage, createdAt, updatedAt };
}

function responseError(value: unknown, status: number): string {
  const payload = record(value);
  return text(payload?.code) ?? text(payload?.error) ?? (status === 403 ? 'permission_denied' : status === 409 ? 'DOMAIN_VERSION_CONFLICT' : 'domain_request_failed');
}

function errorMessage(code: string): string {
  if (code === 'permission_denied' || code === 'forbidden') return '이 작업을 수행할 권한이 없습니다.';
  if (code === 'DOMAIN_VERSION_CONFLICT') return '도메인 상태가 다른 작업으로 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도하세요.';
  if (code === 'DOMAIN_HOSTNAME_INVALID') return '공개 DNS 호스트 이름을 다시 확인하세요.';
  if (code === 'DOMAIN_PLATFORM_ZONE_FORBIDDEN') return 'RAIBIT 생성 URL 영역은 사용자 도메인으로 연결할 수 없습니다.';
  if (code === 'DOMAIN_SERVICE_NOT_PUBLIC_WEB') return '공개 웹 서비스만 사용자 도메인에 연결할 수 있습니다.';
  if (code === 'DOMAIN_HOSTNAME_CONFLICT') return '이 호스트 이름은 이미 다른 도메인 연결에 사용 중입니다.';
  if (code === 'DOMAIN_DELETING') return '삭제 정리 중인 도메인입니다. 정리 상태를 확인하세요.';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
}

function safeControllerError(domain: CustomDomainRecord): string | null {
  const code = domain.lastErrorCode;
  if (!code) return null;
  if (/DNS|VERIFY|CHALLENGE/i.test(code)) return 'DNS TXT 레코드 이름과 값을 다시 확인한 뒤 상태를 재확인하세요.';
  if (/TLS|CERTIFICATE/i.test(code)) return 'DNS 검증 후 TLS 인증서 상태를 조정기가 다시 확인합니다.';
  if (/ROUTE|INGRESS/i.test(code)) return '검증은 완료되었지만 경로 준비를 다시 확인해야 합니다.';
  return '조정기가 안전한 오류 상태를 보고했습니다. 상태를 다시 확인하세요.';
}

function isPublicWebService(service: ServiceRecord): boolean {
  const status = String(service.status || '').toUpperCase();
  return String(service.type || 'web').toLowerCase() === 'web' && !service.deletionRequestedAt && !['DELETE_REQUESTED', 'DELETING', 'DELETED'].includes(status);
}

function validHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '');
  if (hostname.length > 253 || hostname.length < 4 || hostname.endsWith('.raibitserver.app')) return false;
  return hostname.split('.').length > 1 && hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

async function responsePayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function waitForPoll(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(true), STATUS_POLL_INTERVAL_MS);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(false); }, { once: true });
  });
}

function domainStatus(domain: CustomDomainRecord): string {
  return statusLabels[domain.status] || domain.status;
}

function statusVariant(status: string): 'outline' | 'secondary' | 'destructive' {
  return status === 'READY' ? 'outline' : status === 'FAILED' ? 'destructive' : 'secondary';
}

export function DomainsView({ data }: Readonly<{ data: ProjectHubData }>) {
  const initialDomains = useMemo(() => data.customDomains.flatMap((domain) => {
    const parsed = customDomain(domain);
    return parsed ? [parsed] : [];
  }), [data.customDomains]);
  const [domains, setDomains] = useState<readonly CustomDomainRecord[]>(initialDomains);
  const [hostname, setHostname] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<CustomDomainRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomDomainRecord | null>(null);
  const [rotateConfirmed, setRotateConfirmed] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [mutation, setMutation] = useState<Mutation>({ kind: 'idle' });
  const [copyStatus, setCopyStatus] = useState('');
  const [pollingDomainId, setPollingDomainId] = useState<string | null>(null);
  const pollRef = useRef<AbortController | null>(null);
  const challengeRef = useRef<HTMLDivElement | null>(null);
  const publicServices = useMemo(() => data.services.filter(isPublicWebService), [data.services]);
  const canManage = data.domainRole === null || data.domainRole === 'OWNER' || data.domainRole === 'ADMIN';
  const canVerify = canManage || data.domainRole === 'MAINTAINER';

  useEffect(() => { setDomains(initialDomains); }, [initialDomains]);
  useEffect(() => () => pollRef.current?.abort(), []);
  useEffect(() => { if (challenge) challengeRef.current?.focus(); }, [challenge]);

  function replaceDomain(next: CustomDomainRecord): void {
    setDomains((current) => current.some((domain) => domain.id === next.id) ? current.map((domain) => domain.id === next.id ? next : domain) : [...current, next]);
  }

  function stopPolling(): void {
    pollRef.current?.abort();
    pollRef.current = null;
    setPollingDomainId(null);
  }

  async function pollDomain(domainId: string): Promise<void> {
    stopPolling();
    const controller = new AbortController();
    pollRef.current = controller;
    setPollingDomainId(domainId);
    try {
      for (let attempt = 0; attempt < MAX_STATUS_POLLS; attempt += 1) {
        if (!(await waitForPoll(controller.signal)) || controller.signal.aborted) return;
        try {
          const response = await fetch(apiAction(`/domains/${encodeURIComponent(domainId)}`), { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal });
          const payload = await responsePayload(response);
          if (!response.ok) {
            setMutation({ kind: 'error', operation: 'domains-status', code: responseError(payload, response.status) });
            return;
          }
          const next = customDomain(payload);
          if (!next) {
            setMutation({ kind: 'error', operation: 'domains-status', code: 'invalid_domain_response' });
            return;
          }
          replaceDomain(next);
          if (['READY', 'FAILED', 'DELETING'].includes(next.status)) {
            setMutation({ kind: 'success', operation: 'domains-status' });
            return;
          }
        } catch {
          if (!controller.signal.aborted) setMutation({ kind: 'error', operation: 'domains-status', code: 'domain_status_unavailable' });
          return;
        }
      }
      if (!controller.signal.aborted) setMutation({ kind: 'success', operation: 'domains-status' });
    } finally {
      if (pollRef.current === controller) {
        pollRef.current = null;
        setPollingDomainId(null);
      }
    }
  }

  async function createDomain(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!canManage || !selectedService || !validHostname(normalizedHostname)) {
      setMutation({ kind: 'error', operation: 'domains-create', code: 'DOMAIN_HOSTNAME_INVALID' });
      return;
    }
    setMutation({ kind: 'pending', operation: 'domains-create' });
    try {
      const response = await fetch(apiAction(`/projects/${encodeURIComponent(data.projectId)}/domains`), { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: selectedService, hostname: normalizedHostname }) });
      const payload = await responsePayload(response);
      if (!response.ok) {
        setMutation({ kind: 'error', operation: 'domains-create', code: responseError(payload, response.status) });
        return;
      }
      const body = record(payload);
      const next = customDomain(body?.domain);
      const token = text(body?.challengeToken);
      if (!next || !token) {
        setMutation({ kind: 'error', operation: 'domains-create', code: 'invalid_domain_response' });
        return;
      }
      replaceDomain(next);
      setChallenge({ domainId: next.id, hostname: next.hostname, token, operation: 'domains-create' });
      setHostname('');
      setAddOpen(false);
      setMutation({ kind: 'success', operation: 'domains-create' });
    } catch {
      setMutation({ kind: 'error', operation: 'domains-create', code: 'domain_create_unavailable' });
    }
  }

  async function rotateDomain(): Promise<void> {
    if (!rotateTarget || !rotateConfirmed || !canManage) return;
    setMutation({ kind: 'pending', operation: 'domains-rotate' });
    try {
      const response = await fetch(apiAction(`/domains/${encodeURIComponent(rotateTarget.id)}/rotate`), { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: rotateTarget.verificationVersion, confirmed: true }) });
      const payload = await responsePayload(response);
      if (!response.ok) {
        setMutation({ kind: 'error', operation: 'domains-rotate', code: responseError(payload, response.status) });
        return;
      }
      const body = record(payload);
      const next = customDomain(body?.domain);
      const token = text(body?.challengeToken);
      if (!next || !token) {
        setMutation({ kind: 'error', operation: 'domains-rotate', code: 'invalid_domain_response' });
        return;
      }
      replaceDomain(next);
      setChallenge({ domainId: next.id, hostname: next.hostname, token, operation: 'domains-rotate' });
      setRotateTarget(null);
      setRotateConfirmed(false);
      setMutation({ kind: 'success', operation: 'domains-rotate' });
    } catch {
      setMutation({ kind: 'error', operation: 'domains-rotate', code: 'domain_rotate_unavailable' });
    }
  }

  async function verifyDomain(domain: CustomDomainRecord): Promise<void> {
    if (!canVerify) return;
    setMutation({ kind: 'pending', operation: 'domains-verify' });
    try {
      const response = await fetch(apiAction(`/domains/${encodeURIComponent(domain.id)}/verify`), { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: domain.verificationVersion }) });
      const payload = await responsePayload(response);
      if (!response.ok) {
        setMutation({ kind: 'error', operation: 'domains-verify', code: responseError(payload, response.status) });
        return;
      }
      const next = customDomain(payload);
      if (!next) {
        setMutation({ kind: 'error', operation: 'domains-verify', code: 'invalid_domain_response' });
        return;
      }
      replaceDomain(next);
      setMutation({ kind: 'success', operation: 'domains-verify' });
      await pollDomain(next.id);
    } catch {
      setMutation({ kind: 'error', operation: 'domains-verify', code: 'domain_verify_unavailable' });
    }
  }

  async function deleteDomain(): Promise<void> {
    if (!deleteTarget || !deleteConfirmed || !canManage) return;
    setMutation({ kind: 'pending', operation: 'domains-delete' });
    try {
      const response = await fetch(apiAction(`/domains/${encodeURIComponent(deleteTarget.id)}`), { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: deleteTarget.verificationVersion }) });
      const payload = await responsePayload(response);
      if (!response.ok) {
        setMutation({ kind: 'error', operation: 'domains-delete', code: responseError(payload, response.status) });
        return;
      }
      const next = customDomain(payload);
      if (!next) {
        setMutation({ kind: 'error', operation: 'domains-delete', code: 'invalid_domain_response' });
        return;
      }
      replaceDomain(next);
      setDeleteTarget(null);
      setDeleteConfirmed(false);
      setMutation({ kind: 'success', operation: 'domains-delete' });
    } catch {
      setMutation({ kind: 'error', operation: 'domains-delete', code: 'domain_delete_unavailable' });
    }
  }

  async function copyChallenge(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label}을(를) 복사했습니다.`);
    } catch {
      setCopyStatus(`${label}을(를) 자동으로 복사하지 못했습니다. 값을 직접 복사하세요.`);
    }
  }

  const selectedService = serviceId || publicServices[0]?.id || '';
  const mutationBusy = mutation.kind === 'pending';
  const hostnameError = hostname.length > 0 && !validHostname(hostname) ? '공개 DNS에 등록할 수 있는 호스트 이름을 입력하세요.' : null;

  return (
    <div className="flex flex-col gap-raibit-xl">
      <Card>
        <CardHeader><CardTitle><h2>생성된 서비스 URL</h2></CardTitle><CardDescription>사용자 도메인의 검증·경로·TLS 준비와 무관하게 이 생성 URL을 운영 대체 경로로 유지합니다.</CardDescription></CardHeader>
        <CardContent>{data.mainLink ? <div className="flex min-w-0 flex-wrap items-center gap-raibit-sm"><code className="min-w-0 break-all rounded-sm bg-muted px-raibit-sm py-raibit-xs font-mono text-caption [overflow-wrap:anywhere]">{data.mainLink.label}</code><ActionLink aria-label="생성된 서비스 URL 새 창에서 열기" href={data.mainLink.href} rel="noreferrer" target="_blank">열기 ↗</ActionLink></div> : <Alert><AlertTitle>생성된 공개 웹 서비스 URL이 없습니다.</AlertTitle><AlertDescription>공개 웹 서비스를 준비하면 평면 생성 URL이 이곳에 표시됩니다. 사용자 도메인은 공개 웹 서비스에만 연결할 수 있습니다.</AlertDescription></Alert>}</CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle><h2>사용자 도메인</h2></CardTitle><CardDescription>TXT 검증 후 조정기가 경로와 TLS 인증서를 비동기로 준비합니다. 검증 전 사용자 URL은 열지 않습니다.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-raibit-lg">
          {data.customDomainsIssue ? <Alert variant="destructive"><AlertTitle>{data.customDomainsIssue.status === 403 ? '도메인을 볼 권한이 없습니다.' : '사용자 도메인을 불러오지 못했습니다.'}</AlertTitle><AlertDescription>{data.customDomainsIssue.message}</AlertDescription></Alert> : null}
          {challenge ? <div ref={challengeRef} tabIndex={-1}><Alert aria-live="assertive" role="status" variant="notice"><AlertTitle>이번에만 표시하는 DNS TXT 값</AlertTitle><AlertDescription><p>DNS 공급자에 아래 레코드를 추가한 뒤 상태를 재확인하세요. 이 토큰은 화면을 나가거나 닫으면 다시 표시할 수 없습니다.</p><div className="mt-raibit-md grid gap-raibit-sm"><CopyValue label="이름" onCopy={copyChallenge} value={`_raibit-challenge.${challenge.hostname}`} /><CopyValue label="값" onCopy={copyChallenge} value={`raibit-verification=${challenge.token}`} /></div><p className="mt-raibit-sm">작업 ID: <code className="font-mono">{challenge.operation}</code> · 요청이 접수된 것과 정리·인증서 완료는 별개입니다.</p></AlertDescription></Alert><div className="mt-raibit-sm flex justify-end"><Button onClick={() => setChallenge(null)} size="sm" type="button" variant="outline">TXT 값을 확인했습니다</Button></div></div> : null}
          {copyStatus ? <p aria-live="polite" className="text-caption text-muted-foreground">{copyStatus}</p> : null}
          {mutation.kind === 'error' ? <Alert variant="destructive"><AlertTitle>도메인 작업을 완료하지 못했습니다.</AlertTitle><AlertDescription>{errorMessage(mutation.code)} <span className="block font-mono text-caption">작업 ID: {mutation.operation}</span></AlertDescription></Alert> : null}
          {mutation.kind === 'success' ? <p aria-live="polite" className="text-caption text-muted-foreground">작업 ID: {mutation.operation} · {mutation.operation === 'domains-status' ? '최대 횟수까지 상태를 확인했습니다. 조정 중이면 나중에 다시 확인하세요.' : '요청을 처리했습니다.'}</p> : null}
          {pollingDomainId ? <div className="flex flex-wrap items-center justify-between gap-raibit-sm rounded-sm border border-border bg-muted/50 p-raibit-sm" role="status"><span className="text-caption text-muted-foreground"><Spinner data-icon="inline-start" />조정기 상태를 제한된 횟수로 확인 중입니다. 작업 ID: domains-status</span><Button onClick={stopPolling} size="sm" type="button" variant="outline">상태 확인 중지</Button></div> : null}
          {domains.length === 0 ? <p className="text-sm text-muted-foreground">연결한 사용자 도메인이 없습니다. 생성 URL은 계속 사용할 수 있습니다.</p> : <div className="grid grid-cols-[repeat(auto-fit,minmax(min(22rem,100%),1fr))] gap-raibit-md">{domains.map((domain) => <DomainCard canManage={canManage} canVerify={canVerify} domain={domain} key={domain.id} onDelete={setDeleteTarget} onRotate={setRotateTarget} onVerify={verifyDomain} polling={pollingDomainId === domain.id} />)}</div>}
        </CardContent>
        <CardFooter className="justify-end"><Dialog onOpenChange={setAddOpen} open={addOpen}><DialogTrigger render={<Button disabled={!canManage || publicServices.length === 0} type="button" />}>사용자 도메인 추가</DialogTrigger><DialogContent><DialogHeader><DialogTitle>사용자 도메인 연결</DialogTitle><DialogDescription>공개 웹 서비스를 선택하고 DNS에서 관리하는 호스트 이름을 입력하세요. 추가 후 이번에만 TXT 검증 값을 표시합니다.</DialogDescription></DialogHeader><form onSubmit={createDomain}><FieldGroup><Field><FieldLabel htmlFor="domain-service">공개 웹 서비스</FieldLabel><Select id="domain-service" onChange={(event) => setServiceId(event.currentTarget.value)} required value={selectedService}><option value="">서비스 선택</option>{publicServices.map((service) => <option key={service.id} value={service.id}>{service.name || service.slug || service.id}</option>)}</Select></Field><Field><FieldLabel htmlFor="domain-hostname">호스트 이름</FieldLabel><Input aria-describedby="domain-hostname-help" autoCapitalize="none" autoComplete="off" id="domain-hostname" onChange={(event) => setHostname(event.currentTarget.value)} placeholder="app.example.com" required value={hostname} /><FieldDescription id="domain-hostname-help">예: app.example.com · RAIBIT 생성 URL 영역은 사용할 수 없습니다.</FieldDescription>{hostnameError ? <p className="text-caption text-destructive" role="alert">{hostnameError}</p> : null}</Field></FieldGroup><DialogFooter><Button disabled={mutationBusy || !canManage || !selectedService || !validHostname(hostname)} type="submit">{mutation.kind === 'pending' && mutation.operation === 'domains-create' ? <><Spinner data-icon="inline-start" />연결 요청 중</> : 'TXT 검증 값 만들기'}</Button></DialogFooter></form></DialogContent></Dialog></CardFooter>
      </Card>

      <Dialog onOpenChange={(open) => { if (!open) { setRotateTarget(null); setRotateConfirmed(false); } }} open={Boolean(rotateTarget)}><DialogContent><DialogHeader><DialogTitle>TXT 검증 값을 교체할까요?</DialogTitle><DialogDescription>{rotateTarget?.hostname}의 기존 사용자 URL은 새 증명과 인증서가 준비될 때까지 연결이 끊길 수 있습니다. 생성된 서비스 URL은 계속 유지됩니다. 202 응답은 요청 접수일 뿐 정리 완료가 아닙니다.</DialogDescription></DialogHeader><FieldSet><FieldLegend variant="label">교체 확인</FieldLegend><Field orientation="horizontal"><Checkbox checked={rotateConfirmed} id="domain-rotate-confirmed" onCheckedChange={setRotateConfirmed} /><FieldLabel htmlFor="domain-rotate-confirmed">기존 사용자 URL의 일시적인 연결 해제를 이해했습니다.</FieldLabel></Field></FieldSet><DialogFooter><Button disabled={!rotateConfirmed || mutationBusy} onClick={rotateDomain} type="button">{mutation.kind === 'pending' && mutation.operation === 'domains-rotate' ? <><Spinner data-icon="inline-start" />교체 요청 중</> : 'TXT 값 교체'}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirmed(false); } }} open={Boolean(deleteTarget)}><DialogContent><DialogHeader><DialogTitle>사용자 도메인을 삭제할까요?</DialogTitle><DialogDescription>{deleteTarget?.hostname} 한 개만 삭제 정리 대상으로 표시합니다. 생성된 서비스 URL과 다른 사용자 도메인은 삭제하지 않습니다.</DialogDescription></DialogHeader><FieldSet><FieldLegend variant="label">삭제 확인</FieldLegend><Field orientation="horizontal"><Checkbox checked={deleteConfirmed} id="domain-delete-confirmed" onCheckedChange={setDeleteConfirmed} /><FieldLabel htmlFor="domain-delete-confirmed">이 사용자 도메인 하나의 삭제 정리를 요청합니다.</FieldLabel></Field></FieldSet><DialogFooter><Button disabled={!deleteConfirmed || mutationBusy} onClick={deleteDomain} type="button" variant="destructive">{mutation.kind === 'pending' && mutation.operation === 'domains-delete' ? <><Spinner data-icon="inline-start" />삭제 요청 중</> : '도메인 삭제 요청'}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

function CopyValue({ label, onCopy, value }: Readonly<{ label: string; onCopy: (value: string, label: string) => Promise<void>; value: string }>) {
  return <div className="grid min-w-0 gap-raibit-xs sm:grid-cols-[4rem_minmax(0,1fr)_auto]"><span className="text-caption font-medium">{label}</span><code className="min-w-0 break-all rounded-sm bg-background px-raibit-sm py-raibit-xs font-mono text-caption [overflow-wrap:anywhere]">{value}</code><Button onClick={() => void onCopy(value, label)} size="sm" type="button" variant="outline">복사</Button></div>;
}

function DomainCard({ canManage, canVerify, domain, onDelete, onRotate, onVerify, polling }: Readonly<{ canManage: boolean; canVerify: boolean; domain: CustomDomainRecord; onDelete: (domain: CustomDomainRecord) => void; onRotate: (domain: CustomDomainRecord) => void; onVerify: (domain: CustomDomainRecord) => Promise<void>; polling: boolean }>) {
  const controllerError = safeControllerError(domain);
  const ready = domain.status === 'READY' && domain.tlsStatus === 'READY';
  const deleting = domain.status === 'DELETING';
  return <div className="flex min-w-0 flex-col gap-raibit-md rounded-lg border border-border p-raibit-lg"><div className="flex min-w-0 flex-wrap items-start justify-between gap-raibit-sm"><div className="min-w-0"><strong className="block break-all [overflow-wrap:anywhere]">{domain.hostname}</strong><span className="block break-all font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">서비스: {domain.serviceId}</span></div><Badge variant={statusVariant(domain.status)}>{domainStatus(domain)}</Badge></div><div className="grid gap-raibit-xs text-caption text-muted-foreground"><p>소유: 이 프로젝트 · TLS: {domain.tlsStatus} · 경로: {domain.routeObservedGeneration === domain.desiredGeneration ? '관측됨' : '준비 중'}</p><p>검증 버전: {domain.verificationVersion} · 마지막 확인: {domain.lastCheckedAt || '아직 확인하지 않음'}</p>{domain.nextCheckAt ? <p>다음 확인 예정: {domain.nextCheckAt}</p> : null}</div>{controllerError ? <Alert variant="destructive"><AlertTitle>{domain.lastErrorCode}</AlertTitle><AlertDescription>{controllerError}</AlertDescription></Alert> : null}{deleting ? <Alert><AlertTitle>삭제 정리 상태</AlertTitle><AlertDescription>{domain.cleanupBarrier?.complete ? '인증서와 경로 부재가 관측되었습니다.' : '인증서와 경로 정리가 완료될 때까지 기다립니다.'} 작업 ID: domains-delete</AlertDescription></Alert> : null}<div className="flex flex-wrap gap-raibit-sm">{ready ? <ActionLink aria-label={`${domain.hostname} 새 창에서 열기`} href={`https://${domain.hostname}`} rel="noreferrer" target="_blank">사용자 URL 열기 ↗</ActionLink> : <span className="text-caption text-muted-foreground">준비됨 상태와 TLS 준비 전에는 사용자 URL을 열지 않습니다.</span>}{canVerify && !deleting ? <Button disabled={polling} onClick={() => void onVerify(domain)} size="sm" type="button" variant="outline">{polling ? <><Spinner data-icon="inline-start" />확인 중</> : '상태 재확인'}</Button> : null}{canManage && !deleting ? <Button onClick={() => onRotate(domain)} size="sm" type="button" variant="outline">TXT 값 교체</Button> : null}{canManage && !deleting ? <Button onClick={() => onDelete(domain)} size="sm" type="button" variant="destructive">삭제 요청</Button> : null}</div></div>;
}

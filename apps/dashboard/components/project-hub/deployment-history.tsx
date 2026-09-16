import { randomUUID } from 'node:crypto';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DeploymentRecoveryAction } from './deployment-recovery-action';
import { HubEmpty, Panel, ProjectStatusBadge } from './shared';
import type { DeploymentHistoryFilters, DeploymentHistoryPage, DeploymentHistoryRow } from './deployment-history-model';
import type { ServiceRecord } from './types';

function historyHref(base: string, filters: DeploymentHistoryFilters, cursor: string | null): string {
  const query = new URLSearchParams({ view: 'deployments' });
  if (filters.serviceId) query.set('serviceId', filters.serviceId);
  if (filters.environment) query.set('environment', filters.environment);
  if (filters.status) query.set('status', filters.status);
  if (filters.trigger) query.set('trigger', filters.trigger);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (cursor) query.set('cursor', cursor);
  return `${base}?${query.toString()}`;
}

function display(value: string | number | null): string {
  return value === null || value === '' ? '없음' : String(value);
}

function Identifier({ children }: Readonly<{ children: string | null }>) {
  return <span className="block break-all font-mono text-xs [overflow-wrap:anywhere]">{display(children)}</span>;
}

function RowFacts({ deployment }: Readonly<{ deployment: DeploymentHistoryRow }>) {
  const lineage = [
    ['원본', deployment.lineage.sourceDeploymentId],
    ['재시도 원본', deployment.lineage.retryOfDeploymentId],
    ['롤백 원본', deployment.lineage.rollbackOfDeploymentId],
    ['이전 배포', deployment.lineage.previousDeploymentId],
    ['미리보기 계보', deployment.lineage.previewLineageId],
  ].filter(([, value]) => value !== null);
  return <dl className="grid min-w-0 gap-raibit-sm text-sm sm:grid-cols-2">
    <div><dt className="text-muted-foreground">커밋</dt><dd><Identifier>{deployment.source.commitSha}</Identifier></dd></div>
    <div><dt className="text-muted-foreground">이미지 다이제스트</dt><dd><Identifier>{deployment.source.imageDigest}</Identifier></dd></div>
    <div><dt className="text-muted-foreground">스냅샷 버전</dt><dd className="font-mono text-xs">{display(deployment.source.snapshotVersion)}</dd></div>
    <div><dt className="text-muted-foreground">작업 실행자</dt><dd><Identifier>{deployment.operation.requestedByUserId}</Identifier></dd></div>
    <div><dt className="text-muted-foreground">롤아웃</dt><dd>{display(deployment.health.rolloutStatus)}</dd></div>
    <div><dt className="text-muted-foreground">공개 헬스</dt><dd>{display(deployment.health.publicHealthStatus)}</dd></div>
    <div><dt className="text-muted-foreground">헬스 확인</dt><dd><Identifier>{deployment.health.healthCheckedAt}</Identifier></dd></div>
    <div><dt className="text-muted-foreground">헬스 실패 코드</dt><dd><Identifier>{deployment.health.healthFailureCode}</Identifier></dd></div>
    <div><dt className="text-muted-foreground">관측 세대</dt><dd className="font-mono text-xs">{display(deployment.health.observedGeneration)}</dd></div>
    <div><dt className="text-muted-foreground">미리보기 세대</dt><dd className="font-mono text-xs">{display(deployment.lineage.previewGeneration)}</dd></div>
    {lineage.map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd><Identifier>{value}</Identifier></dd></div>)}
  </dl>;
}

function RecoveryControl({ deployment, returnTo }: Readonly<{ deployment: DeploymentHistoryRow; returnTo: string }>) {
  if (!deployment.permissions.execute) return <p className="text-sm text-muted-foreground">이 배포에 대한 실행 권한이 없습니다.</p>;
  if (!deployment.eligibleAction) return <div className="flex flex-col gap-raibit-xs"><Badge variant={deployment.recovery.retryable ? 'outline' : 'secondary'}>{deployment.recovery.retryable ? '재시도 가능' : '재시도 불가'}</Badge><p className="text-sm text-muted-foreground">{deployment.recovery.reason || (deployment.recovery.retryable ? '서버가 아직 안전한 복구 작업을 제공하지 않았습니다.' : '현재 서버 상태에서는 복구 작업을 요청할 수 없습니다.')}</p></div>;
  return <div className="flex flex-col items-start gap-raibit-xs"><Badge variant={deployment.recovery.retryable ? 'outline' : 'secondary'}>{deployment.recovery.retryable ? '재시도 가능' : '재시도 불가'}</Badge><DeploymentRecoveryAction action={deployment.eligibleAction} idempotencyKey={deployment.eligibleAction.type === 'retry' || deployment.eligibleAction.type === 'redeploy' ? randomUUID() : null} returnTo={returnTo} /></div>;
}

function DeploymentHistoryCard({ base, deployment, returnTo }: Readonly<{ base: string; deployment: DeploymentHistoryRow; returnTo: string }>) {
  const detailHref = `${base}/deployments/${encodeURIComponent(deployment.id)}`;
  return <Card id={`deployment-${deployment.id}`} tabIndex={-1}>
    <CardHeader className="gap-raibit-sm border-b">
      <div className="min-w-0"><CardTitle><a className="break-all hover:underline" href={detailHref}>{deployment.service.name || deployment.service.slug || deployment.service.id}</a></CardTitle><CardDescription className="mt-raibit-xs">{deployment.environment} · {deployment.trigger} · <time dateTime={deployment.createdAt}>{deployment.createdAt}</time></CardDescription></div>
      <div className="flex flex-wrap items-center gap-raibit-sm"><ProjectStatusBadge status={deployment.status} /><RecoveryControl deployment={deployment} returnTo={returnTo} /></div>
    </CardHeader>
    <CardContent className="pt-raibit-lg"><RowFacts deployment={deployment} /></CardContent>
  </Card>;
}

function DeploymentFilters({ base, filters, services }: Readonly<{ base: string; filters: DeploymentHistoryFilters; services: readonly ServiceRecord[] }>) {
  return <form action={base} className="rounded-lg border border-border bg-card p-raibit-lg" method="get">
    <input name="view" type="hidden" value="deployments" />
    <FieldGroup className="grid gap-raibit-md md:grid-cols-3">
      <Field><FieldLabel htmlFor="deployment-service">서비스</FieldLabel><Select defaultValue={filters.serviceId || ''} id="deployment-service" name="serviceId"><option value="">모든 서비스</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name || service.slug || service.id}</option>)}</Select></Field>
      <Field><FieldLabel htmlFor="deployment-environment">환경</FieldLabel><Select defaultValue={filters.environment || ''} id="deployment-environment" name="environment"><option value="">모든 환경</option><option value="production">운영</option><option value="preview">미리보기</option><option value="manual">수동</option></Select></Field>
      <Field><FieldLabel htmlFor="deployment-status">상태</FieldLabel><Input defaultValue={filters.status || ''} id="deployment-status" name="status" placeholder="서버 상태" /></Field>
      <Field><FieldLabel htmlFor="deployment-trigger">트리거</FieldLabel><Input defaultValue={filters.trigger || ''} id="deployment-trigger" name="trigger" placeholder="예: push" /></Field>
      <Field><FieldLabel htmlFor="deployment-from">시작 시각 (ISO 8601)</FieldLabel><Input defaultValue={filters.from || ''} id="deployment-from" name="from" placeholder="2026-09-01T00:00:00Z" /></Field>
      <Field><FieldLabel htmlFor="deployment-to">종료 시각 (ISO 8601)</FieldLabel><Input defaultValue={filters.to || ''} id="deployment-to" name="to" placeholder="2026-09-06T23:59:59Z" /></Field>
    </FieldGroup>
    <div className="mt-raibit-lg flex flex-wrap justify-end gap-raibit-sm"><a className={buttonVariants({ variant: 'ghost' })} href={`${base}?view=deployments`}>초기화</a><button className={buttonVariants()} type="submit">필터 적용</button></div>
  </form>;
}

function DeploymentHistoryTable({ base, deployments, returnTo }: Readonly<{ base: string; deployments: readonly DeploymentHistoryRow[]; returnTo: string }>) {
  return <Table><TableHeader><TableRow><TableHead>서비스 · 환경</TableHead><TableHead>상태 · 트리거</TableHead><TableHead>불변 소스</TableHead><TableHead>계보 · 실행자</TableHead><TableHead>롤아웃 · 공개 헬스</TableHead><TableHead>전체 메타데이터</TableHead><TableHead>복구</TableHead></TableRow></TableHeader><TableBody>{deployments.map((deployment) => <TableRow id={`deployment-${deployment.id}`} key={deployment.id} tabIndex={-1}><TableCell className="min-w-48"><a className="block break-all font-medium hover:underline" href={`${base}/deployments/${encodeURIComponent(deployment.id)}`}>{deployment.service.name || deployment.service.slug || deployment.service.id}</a><span className="text-xs text-muted-foreground">{deployment.environment}</span></TableCell><TableCell><ProjectStatusBadge status={deployment.status} /><span className="mt-raibit-xs block text-xs text-muted-foreground">{deployment.trigger}</span></TableCell><TableCell className="min-w-64"><Identifier>{deployment.source.commitSha}</Identifier><Identifier>{deployment.source.imageDigest}</Identifier><span className="font-mono text-xs">스냅샷 {display(deployment.source.snapshotVersion)}</span></TableCell><TableCell className="min-w-64"><Identifier>{deployment.lineage.retryOfDeploymentId || deployment.lineage.rollbackOfDeploymentId || deployment.lineage.sourceDeploymentId || deployment.lineage.previousDeploymentId}</Identifier><Identifier>{deployment.operation.requestedByUserId}</Identifier></TableCell><TableCell className="min-w-48"><span className="block">{display(deployment.health.rolloutStatus)}</span><span className="block">{display(deployment.health.publicHealthStatus)}</span></TableCell><TableCell className="min-w-72"><details><summary className="cursor-pointer text-sm underline underline-offset-4">전체 메타데이터</summary><div className="mt-raibit-md"><RowFacts deployment={deployment} /></div></details></TableCell><TableCell className="min-w-44"><RecoveryControl deployment={deployment} returnTo={returnTo} /></TableCell></TableRow>)}</TableBody></Table>;
}

export function DeploymentHistory({ base, history, services }: Readonly<{ base: string; history: DeploymentHistoryPage; services: readonly ServiceRecord[] }>) {
  const returnTo = historyHref(base, history.filters, null);
  return <Panel title="배포 내역" description="불변 소스·계보·서버 확인 복구 상태를 필터로 좁혀 확인합니다.">
    <div className="flex flex-col gap-raibit-lg">
      <DeploymentFilters base={base} filters={history.filters} services={services} />
      {history.deployments.length > 0 ? <>
        <div className="hidden min-w-0 overflow-x-auto md:block"><DeploymentHistoryTable base={base} deployments={history.deployments} returnTo={returnTo} /></div>
        <div className="flex flex-col gap-raibit-md md:hidden">{history.deployments.map((deployment) => <DeploymentHistoryCard base={base} deployment={deployment} key={deployment.id} returnTo={returnTo} />)}</div>
        <div className="flex flex-wrap justify-between gap-raibit-sm border-t border-border pt-raibit-md"><span className="text-sm text-muted-foreground">한 번에 {history.page.limit}개 표시</span>{history.page.nextCursor ? <a className={buttonVariants({ variant: 'outline' })} href={historyHref(base, history.filters, history.page.nextCursor)}>다음 배포 보기</a> : <span className="text-sm text-muted-foreground">마지막 페이지입니다.</span>}</div>
      </> : <HubEmpty title="조건에 맞는 배포가 없습니다." description="필터를 조정하거나 서비스에서 새 배포를 시작하세요." action={<a className={buttonVariants()} href={`${base}?view=services`}>서비스로 이동</a>} />}
    </div>
  </Panel>;
}

import { apiAction } from '@/lib/api';
import { RESOURCE_CAPABILITIES } from '../../../../packages/core/src/resource-capabilities';
import { Badge } from '@/components/ui/badge';
import { buttonVariants, ActionLink } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HubEmpty, MetricGrid, Panel, ProjectStatusBadge, RuntimeLogViewer } from './shared';
import type { AgentPlan, ProjectHubData } from './types';

export function DeploymentsView({ data }: Readonly<{ data: ProjectHubData }>) {
  return (
    <Panel title="배포 내역" description="운영 및 미리보기 배포의 로그와 이벤트">
      {data.deployments.length > 0 ? <>
        <div className="hidden md:block"><Table><TableHeader><TableRow><TableHead>서비스</TableHead><TableHead>유형</TableHead><TableHead>상태</TableHead><TableHead>이미지</TableHead><TableHead>상세</TableHead></TableRow></TableHeader><TableBody>{data.deployments.map((deployment) => <TableRow key={deployment.id}><TableCell>{deployment.serviceName || '서비스'}</TableCell><TableCell>{deployment.deploymentType || 'production'}</TableCell><TableCell><ProjectStatusBadge status={deployment.status} /></TableCell><TableCell className="max-w-80 truncate font-mono">{deployment.imageDigest || deployment.imageUrl || '이미지 대기 중'}</TableCell><TableCell><ActionLink href={`${data.base}/deployments/${deployment.id}`}>배포 상세</ActionLink></TableCell></TableRow>)}</TableBody></Table></div>
        <div className="flex flex-col divide-y divide-border md:hidden">{data.deployments.map((deployment) => <a className="flex min-w-0 items-center justify-between gap-raibit-md py-raibit-md" href={`${data.base}/deployments/${deployment.id}`} key={deployment.id}><span className="min-w-0"><strong className="block truncate">{deployment.serviceName || '서비스'}</strong><small className="block truncate font-mono text-muted-foreground">{deployment.imageDigest || deployment.imageUrl || '이미지 대기 중'}</small></span><ProjectStatusBadge status={deployment.status} /></a>)}</div>
      </> : <HubEmpty title="아직 배포가 없습니다." description="서비스 화면에서 첫 운영 또는 미리보기 배포를 시작하세요." action={<a className={buttonVariants()} href={`${data.base}?view=services`}>서비스로 이동</a>} />}
    </Panel>
  );
}

export function AgentView({ data }: Readonly<{ data: ProjectHubData }>) {
  const plan = data.agentPlan;
  if (!plan) return <HubEmpty title="배포 계획을 준비하지 못했습니다." description="잠시 후 다시 시도해 주세요." />;
  return (
    <div className="flex flex-col gap-raibit-xl">
      <MetricGrid items={[
        { label: '배포 대상', value: plan.deploymentOrder?.length || 0, detail: plan.generatedBy === 'external-ai' ? '외부 AI 순서 제안' : '내장 규칙 순서' },
        { label: '치명적 위험', value: plan.security?.critical || 0, detail: '발견 즉시 차단' },
        { label: '높은 위험', value: plan.security?.high || 0, detail: '해결 전 배포 불가' },
      ]} />
      <Panel title="AI 배포 관리자" description="서비스를 다시 읽고 보안 정책을 통과한 배포만 순서대로 실행합니다." action={<Badge variant={plan.blocked ? 'destructive' : 'outline'}>{plan.blocked ? '보안 차단' : '실행 가능'}</Badge>}>
        <div className="flex flex-col gap-raibit-lg"><p>{plan.summary}</p><p className="max-w-3xl text-sm text-muted-foreground">외부 AI에는 서비스 이름·유형과 위협 코드만 전달합니다. 비밀값은 전송하지 않으며, AI 제안은 서버의 결정적 보안 검사를 우회할 수 없습니다.</p><AgentServiceList data={data} plan={plan} /></div>
      </Panel>
      <Card>
        <CardHeader><CardTitle><h2>검증된 계획 실행</h2></CardTitle><CardDescription>현재 설정을 다시 검사하고 통과한 경우에만 운영 배포를 대기열에 넣습니다.</CardDescription></CardHeader>
        <form action={apiAction(`/projects/${data.projectId}/deployment-agent/apply`)} method="post"><input name="_returnTo" type="hidden" value={`${data.base}?view=deployments`} /><input name="deploymentType" type="hidden" value="production" /><CardFooter className="justify-end"><button className={buttonVariants()} disabled={!plan.canApply} type="submit">{plan.canApply ? `${plan.deploymentOrder?.length || 0}개 서비스 자동 배포` : '보안 문제를 먼저 해결하세요'}</button></CardFooter></form>
      </Card>
    </div>
  );
}

function AgentServiceList({ data, plan }: Readonly<{ data: ProjectHubData; plan: AgentPlan }>) {
  if (!plan.services?.length) return <HubEmpty title="점검할 서비스가 없습니다." action={<a className={buttonVariants()} href={`${data.base}?view=new-service`}>서비스 만들기</a>} />;
  return <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>서비스</TableHead><TableHead>판정</TableHead><TableHead>보안 점검 결과</TableHead></TableRow></TableHeader><TableBody>{plan.services.map((service) => <TableRow key={service.serviceId}><TableCell><strong>{service.name || service.serviceId}</strong><span className="block font-mono text-caption text-muted-foreground">{service.type}</span></TableCell><TableCell><Badge variant={service.eligible ? 'outline' : 'destructive'}>{service.eligible ? '배포 가능' : '수정 필요'}</Badge></TableCell><TableCell>{service.findings?.length ? <div className="flex flex-col gap-raibit-sm">{service.findings.map((finding) => <div className="break-words [overflow-wrap:anywhere]" key={`${finding.code}:${finding.field || ''}`}><Badge variant={finding.severity === 'critical' || finding.severity === 'high' ? 'destructive' : 'secondary'}>{finding.severity}</Badge> <strong className="font-mono">{finding.code}</strong><p className="text-muted-foreground">{finding.message}</p></div>)}</div> : <span className="text-muted-foreground">발견된 위협 없음</span>}</TableCell></TableRow>)}</TableBody></Table></div>;
}

export function ResourcesView({ data }: Readonly<{ data: ProjectHubData }>) {
  if (data.view === 'new-resource') return <NewResourceView data={data} />;
  return (
    <Panel title="관리형 리소스" description={`${data.resources.length}개의 데이터 계층`} action={<a className={buttonVariants()} href={`${data.base}?view=new-resource`}>리소스 추가</a>}>
      {data.resources.length > 0 ? <div className="grid grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),1fr))] gap-raibit-md">{data.resources.map((resource) => <a className="flex min-w-0 items-center justify-between gap-raibit-md rounded-md border border-border p-raibit-lg transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25" href={`${data.base}/resources/${resource.id}/console`} key={resource.id}><span className="min-w-0"><strong className="block truncate">{resource.name}</strong><small className="text-muted-foreground">{resource.engine}</small></span><ProjectStatusBadge status={resource.status || 'provisioning'} /></a>)}</div> : <HubEmpty title="리소스가 없습니다." description="프로젝트에 데이터베이스, 캐시 또는 스토리지를 연결하세요." action={<a className={buttonVariants()} href={`${data.base}?view=new-resource`}>첫 리소스 추가</a>} />}
    </Panel>
  );
}

function NewResourceView({ data }: Readonly<{ data: ProjectHubData }>) {
  const liveEngines = new Set((data.resourceOptions || []).filter((entry) => entry.live && entry.permitted).map((entry) => entry.engine));
  return (
    <Card className="mx-auto w-full max-w-3xl">
      <CardHeader><CardTitle><h2>리소스 추가</h2></CardTitle><CardDescription>실제 실행 요청 생성 · 로컬 전용 · 운영 릴리스 검증 전</CardDescription></CardHeader>
      <form action={apiAction(`/projects/${data.projectId}/resources`)} method="post">
        <input name="_returnTo" type="hidden" value={`${data.base}?view=resources`} />
        <CardContent><FieldGroup>
          <Field><FieldLabel htmlFor="resource-name">리소스 이름</FieldLabel><Input id="resource-name" name="name" placeholder="예: postgres" required /></Field>
          <Field>
            <FieldLabel htmlFor="resource-engine">엔진</FieldLabel>
            <Select defaultValue={[...liveEngines][0] || ''} id="resource-engine" name="engine" required disabled={liveEngines.size === 0} aria-describedby="resource-capability-help">
              {liveEngines.size === 0 ? <option value="">실행 가능한 엔진 없음</option> : null}
              {RESOURCE_CAPABILITIES.map((entry) => <option key={entry.engine} value={entry.engine} disabled={!liveEngines.has(entry.engine)}>
                {entry.displayName} · {liveEngines.has(entry.engine) ? '로컬 전용' : entry.local.provision ? '사용 불가' : '준비 중'}
              </option>)}
            </Select>
            <FieldDescription className="break-keep" id="resource-capability-help">추가하면 실제 실행 희망 상태가 저장됩니다. 준비 완료는 공급자 검증 후 표시됩니다. SQLite는 로컬 파일 전용이며 관리형 백업·복구는 아직 제공하지 않습니다.</FieldDescription>
            {liveEngines.size === 0 ? <FieldDescription className="break-keep">서버 설정 또는 권한상 생성할 수 있는 엔진이 없습니다. 운영 릴리스 지원은 아직 검증되지 않았습니다.</FieldDescription> : null}
          </Field>
          <Field>
            <FieldLabel>준비 중인 엔진</FieldLabel>
            {RESOURCE_CAPABILITIES.filter((entry) => !entry.local.provision).map((entry) => <FieldDescription className="break-keep" key={entry.engine} data-resource-engine={entry.engine} data-reason-code={entry.reasonCode}>
              {entry.displayName}: {entry.reasonKo}
            </FieldDescription>)}
          </Field>
        </FieldGroup></CardContent>
        <CardFooter className="mt-raibit-xl justify-end gap-raibit-sm"><a className={buttonVariants({ variant: 'ghost' })} href={`${data.base}?view=resources`}>취소</a><button className={buttonVariants()} type="submit" disabled={liveEngines.size === 0}>리소스 추가 · 실제 실행 요청</button></CardFooter>
      </form>
    </Card>
  );
}

export function LogsView({ data }: Readonly<{ data: ProjectHubData }>) {
  return <Panel title="런타임 로그" description={data.logService?.name || '서비스'}>{data.logService ? <RuntimeLogViewer rows={data.runtimeLogs} /> : <HubEmpty title="서비스 없음" description="로그를 확인할 서비스를 먼저 만드세요." action={<a className={buttonVariants()} href={`${data.base}?view=new-service`}>서비스 만들기</a>} />}</Panel>;
}

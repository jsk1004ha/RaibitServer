import { apiAction } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { OperationSubmit } from '@/components/operation-submit';
import { CreationSourceFields } from '@/components/creation-source-fields';
import { ServiceSettingsForm } from './service-settings';
import { HubEmpty, ProjectStatusBadge } from './shared';
import type { ProjectHubData, ServiceRecord } from './types';

const serviceTypes = [
  ['web', '웹'], ['private', '비공개 서비스'], ['worker', '워커'], ['cron', '예약 작업'], ['job', '일회성 작업'],
] as const;
function ServiceFields() {
  return <FieldGroup>
    <Field><FieldLabel htmlFor="service-name">서비스 이름</FieldLabel><Input id="service-name" name="name" placeholder="예: web" required /></Field>
    <CreationSourceFields imageField="imageUrl" />
    <details>
      <summary className="cursor-pointer rounded-sm py-raibit-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">서비스 유형 변경 (선택)</summary>
      <Field className="mt-raibit-md"><FieldLabel htmlFor="service-type">서비스 유형</FieldLabel><Select defaultValue="web" id="service-type" name="type">{serviceTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
    </details>
  </FieldGroup>;
}

function ServiceForm({ data, service }: Readonly<{ data: ProjectHubData; service?: ServiceRecord | null }>) {
  if (service) return <ServiceSettingsForm actionBase={apiAction(`/services/${service.id}/settings`)} service={service} />;
  return (
    <Card className="mx-auto w-full max-w-5xl">
      <CardHeader><CardTitle><h2>서비스 만들기</h2></CardTitle><CardDescription>이름과 배포할 코드 또는 이미지를 연결하세요.</CardDescription></CardHeader>
      <form action={apiAction(`/projects/${data.projectId}/services`)} method="post">
        <input name="_returnTo" type="hidden" value={`${data.base}?view=services`} />
        <CardContent><ServiceFields /></CardContent>
        <CardFooter className="mt-raibit-xl justify-end gap-raibit-sm bg-muted/40"><a className={buttonVariants({ variant: 'ghost' })} href={`${data.base}?view=services`}>취소</a><button className={buttonVariants()} type="submit">서비스 만들기</button></CardFooter>
      </form>
    </Card>
  );
}

export function ServicesView({ data }: Readonly<{ data: ProjectHubData }>) {
  if (data.view === 'new-service') return <ServiceForm data={data} />;
  if (data.view === 'edit-service') return data.serviceSettings ? <ServiceForm data={data} service={data.serviceSettings} /> : <HubEmpty title="서비스를 찾을 수 없습니다." action={<a className={buttonVariants({ variant: 'outline' })} href={`${data.base}?view=services`}>서비스로 이동</a>} />;
  return (
    <Card>
      <CardHeader><CardTitle><h2>서비스</h2></CardTitle><CardDescription>{data.services.length}개의 실행 단위</CardDescription><CardAction><a className={cn(buttonVariants(), 'w-fit')} href={`${data.base}?view=new-service`}>새 서비스</a></CardAction></CardHeader>
      <CardContent>
        {data.services.length > 0 ? <div className="min-w-0 overflow-hidden rounded-md border border-border"><div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.25fr)_4.5rem_6rem_minmax(0,1fr)_auto_auto] gap-raibit-md border-b border-border bg-muted/40 px-raibit-md py-raibit-sm text-caption font-medium text-muted-foreground lg:grid"><span>이름</span><span>유형</span><span>상태</span><span>소스</span><span>배포</span><span>관리</span></div><div className="flex min-w-0 flex-col divide-y divide-border">{data.services.map((service) => <ServiceItem data={data} key={service.id} service={service} />)}</div></div> : <HubEmpty title="서비스가 없습니다." description="첫 실행 단위를 만들고 운영 또는 미리보기로 배포하세요." action={<a className={buttonVariants()} href={`${data.base}?view=new-service`}>첫 서비스 만들기</a>} />}
      </CardContent>
    </Card>
  );
}

function DeployActions({ data, service }: Readonly<{ data: ProjectHubData; service: ServiceRecord }>) {
  const action = apiAction(`/projects/${data.projectId}/services/${service.id}/deployments`);
  const returnTo = `${data.base}?view=deployments`;
  return <div className="flex flex-wrap items-start gap-raibit-sm"><OperationSubmit action={action} className="contents" pendingLabel="운영 배포 요청을 확인하고 있습니다." returnTo={returnTo} submitClassName={buttonVariants({ size: 'sm' })} submitLabel="운영 배포"><input name="deploymentType" type="hidden" value="production" /></OperationSubmit><OperationSubmit action={action} className="contents" pendingLabel="미리보기 배포 요청을 확인하고 있습니다." returnTo={returnTo} submitClassName={buttonVariants({ variant: 'outline', size: 'sm' })} submitLabel="미리보기"><input name="deploymentType" type="hidden" value="preview" /></OperationSubmit></div>;
}

function ServiceItem({ data, service }: Readonly<{ data: ProjectHubData; service: ServiceRecord }>) {
  return <article className="grid min-w-0 grid-cols-1 gap-raibit-md p-raibit-md lg:grid-cols-[minmax(0,1.25fr)_4.5rem_6rem_minmax(0,1fr)_auto_auto] lg:items-center" data-service-id={service.id}><span className="min-w-0"><strong className="block truncate">{service.name || service.slug}</strong><small className="block truncate font-mono text-muted-foreground">{service.id}</small></span><span className="font-mono text-caption"><span className="mr-raibit-sm text-muted-foreground lg:hidden">유형</span>{service.type || 'web'}</span><span><ProjectStatusBadge status={service.status || 'created'} /></span><p className="min-w-0 break-words font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">{service.repoUrl || service.imageUrl || '소스 없음'}</p><DeployActions data={data} service={service} /><a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={`${data.base}?view=edit-service&serviceId=${encodeURIComponent(service.id)}`}>설정</a></article>;
}

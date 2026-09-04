import { apiAction } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { OperationSubmit } from '@/components/operation-submit';
import { HubEmpty, ProjectStatusBadge } from './shared';
import type { ProjectHubData, ServiceRecord } from './types';

const serviceTypes = [
  ['web', '웹'], ['private', '비공개 서비스'], ['worker', '워커'], ['cron', '예약 작업'], ['job', '일회성 작업'],
] as const;
const createSourceTypes = [
  ['github', 'GitHub'], ['image', '빌드된 이미지'], ['local', '로컬 Dockerfile'],
] as const;
const editSourceTypes = [
  ['github', 'GitHub'], ['gitlab', 'GitLab'], ['zip', 'ZIP'], ['image', '빌드된 이미지'], ['local', '로컬 Dockerfile'],
] as const;
const buildModes = [
  ['auto', '자동'], ['dockerfile', 'Dockerfile'], ['buildpack', 'Buildpack'], ['framework', '프레임워크'], ['custom', '직접 설정'], ['prebuilt-image', '빌드된 이미지'], ['generated', '자동 생성'],
] as const;

function TextField({ defaultValue, label, max, min, name, placeholder, required, type = 'text' }: Readonly<{ defaultValue?: string | number; label: string; max?: number; min?: number; name: string; placeholder?: string; required?: boolean; type?: 'text' | 'url' | 'number' }>) {
  return <Field><FieldLabel htmlFor={`service-${name}`}>{label}</FieldLabel><Input defaultValue={defaultValue} id={`service-${name}`} max={max} min={min} name={name} placeholder={placeholder} required={required} type={type} /></Field>;
}

function ServiceFields({ service }: Readonly<{ service?: ServiceRecord | null }>) {
  return (
    <FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))] gap-raibit-lg">
      <TextField defaultValue={service?.name} label="서비스 이름" name="name" placeholder="예: web" required />
      <Field><FieldLabel htmlFor="service-type">서비스 유형</FieldLabel><Select defaultValue={String(service?.type || 'web').toLowerCase()} id="service-type" name="type">{serviceTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <Field><FieldLabel htmlFor="service-sourceType">소스 유형</FieldLabel><Select defaultValue={String(service?.sourceType || 'github').toLowerCase()} id="service-sourceType" name="sourceType">{(service ? editSourceTypes : createSourceTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      {service ? <Field><FieldLabel htmlFor="service-buildMode">빌드 방식</FieldLabel><Select defaultValue={String(service.buildMode || 'auto').toLowerCase().replaceAll('_', '-')} id="service-buildMode" name="buildMode">{buildModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field> : null}
      <TextField defaultValue={service?.repoUrl} label="저장소 URL" name="repoUrl" placeholder="https://github.com/org/repo.git" type="url" />
      <TextField defaultValue={service?.branch} label="브랜치" name="branch" placeholder="main" />
      {service ? <TextField defaultValue={service.rootDirectory} label="루트 경로" name="rootDirectory" placeholder="." /> : null}
      <TextField defaultValue={service?.buildContext} label="빌드 컨텍스트" name="buildContext" placeholder="." />
      <TextField defaultValue={service?.dockerfilePath} label="Dockerfile 경로" name="dockerfilePath" placeholder="Dockerfile" />
      <TextField defaultValue={service?.imageUrl || service?.image} label="이미지" name="imageUrl" placeholder="registry.example.com/team/web:tag" />
      {service ? <><TextField defaultValue={service.installCommand} label="설치 명령" name="installCommand" placeholder="npm ci" /><TextField defaultValue={service.buildCommand} label="빌드 명령" name="buildCommand" placeholder="npm run build" /><TextField defaultValue={service.startCommand} label="시작 명령" name="startCommand" placeholder="npm start" /><TextField defaultValue={service.outputDirectory} label="출력 경로" name="outputDirectory" placeholder="dist" /><TextField defaultValue={service.port} label="포트" max={65535} min={1} name="port" placeholder="3000" type="number" /></> : null}
    </FieldGroup>
  );
}

function ServiceForm({ data, service }: Readonly<{ data: ProjectHubData; service?: ServiceRecord | null }>) {
  const editing = Boolean(service);
  return (
    <Card className="mx-auto w-full max-w-5xl">
      <CardHeader><CardTitle><h2>{editing ? `${service?.name || '서비스'} 설정` : '서비스 만들기'}</h2></CardTitle><CardDescription>{editing ? '빌드와 실행 설정' : '컨테이너 실행 단위'}</CardDescription></CardHeader>
      <form action={apiAction(editing ? `/services/${service?.id}` : `/projects/${data.projectId}/services`)} method="post">
        {editing ? <input name="_method" type="hidden" value="PATCH" /> : null}
        <input name="_returnTo" type="hidden" value={`${data.base}?view=services`} />
        <CardContent><ServiceFields service={service} /></CardContent>
        <CardFooter className="mt-raibit-xl justify-end gap-raibit-sm bg-muted/40"><a className={buttonVariants({ variant: 'ghost' })} href={`${data.base}?view=services`}>취소</a><button className={buttonVariants()} type="submit">{editing ? '설정 저장' : '서비스 만들기'}</button></CardFooter>
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

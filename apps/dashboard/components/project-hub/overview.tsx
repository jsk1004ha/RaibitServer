import { ActionNavigation } from '@/components/action-navigation';
import { ActionLink } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HubEmpty, MetricGrid, ProjectStatusBadge } from './shared';
import type { ProjectHubData } from './types';

export function OverviewView({ data }: Readonly<{ data: ProjectHubData }>) {
  return (
    <div className="flex flex-col gap-raibit-xl">
      <MetricGrid items={[
        { label: '서비스', value: data.services.length, detail: '실행 컨테이너' },
        { label: '리소스', value: data.resources.length, detail: '관리형 데이터' },
        { label: '배포', value: data.deployments.length, detail: `미리보기 ${data.previewDeployments.length}개` },
      ]} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-raibit-lg">
        <Card>
          <CardHeader><CardTitle><h2>운영 구성</h2></CardTitle><CardDescription>프로젝트의 실행 구성과 데이터 계층</CardDescription><CardAction><ProjectStatusBadge status={data.project.status} /></CardAction></CardHeader>
          <CardContent className="flex flex-col divide-y divide-border">
            {[
              { label: '서비스', detail: '웹·워커·예약 작업', value: data.services.length, href: `${data.base}?view=services` },
              { label: '리소스', detail: 'DB·캐시·스토리지', value: data.resources.length, href: `${data.base}?view=resources` },
              { label: '배포', detail: '운영·미리보기 기록', value: data.deployments.length, href: `${data.base}?view=deployments` },
            ].map((item) => <a className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-raibit-md py-raibit-md text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25" href={item.href} key={item.label}><span className="min-w-0"><strong className="block font-medium">{item.label}</strong><small className="block truncate text-caption text-muted-foreground">{item.detail}</small></span><span className="tabular-nums">{item.value} →</span></a>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle><h2>최근 배포</h2></CardTitle><CardDescription>가장 최근 운영 및 미리보기 배포</CardDescription><CardAction><ActionLink href={`${data.base}?view=deployments`}>전체 보기</ActionLink></CardAction></CardHeader>
          <CardContent>
            {data.deployments.length > 0 ? <div className="flex flex-col divide-y divide-border">{data.deployments.slice(0, 4).map((deployment) => <a className="flex min-h-14 min-w-0 items-center justify-between gap-raibit-md py-raibit-sm" href={`${data.base}/deployments/${deployment.id}`} key={deployment.id}><span className="min-w-0"><strong className="block truncate font-medium">{deployment.serviceName || '서비스'}</strong><small className="text-caption text-muted-foreground">{deployment.deploymentType || 'production'}</small></span><ProjectStatusBadge status={deployment.status} /></a>)}</div> : <HubEmpty title="아직 배포가 없습니다." description="서비스에서 첫 배포를 시작하세요." action={<ActionLink href={`${data.base}?view=services`}>서비스로 이동</ActionLink>} />}
          </CardContent>
        </Card>
      </div>
      <ActionNavigation label="프로젝트 빠른 작업" items={[
        { label: '서비스 만들기', href: `${data.base}?view=new-service` },
        { label: '리소스 추가', href: `${data.base}?view=new-resource` },
        { label: '저장소 연결', href: '/github?step=attach' },
      ]} />
    </div>
  );
}

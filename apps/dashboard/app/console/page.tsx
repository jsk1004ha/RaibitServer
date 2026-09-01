import { ActivityIcon, BoxIcon, DatabaseIcon, PlusIcon } from 'lucide-react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { loadDashboardOverview } from '../../lib/api';
import { ConsoleShell } from '../../components/console-ui';
import { ProjectCard, type ProjectSummary } from '../../components/project-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

export default async function ConsoleOverviewPage() {
  const state = await loadDashboardOverview();
  if (!state.me.ok) redirect('/login?error=session_expired&next=/console');
  const subject = state.me.body?.subject;
  const projects = (state.projects || []) as ProjectSummary[];
  const createOrgSlug = projects[0]?.organizationSlug || projects[0]?.organizationId || subject?.organizationSlug || subject?.organizationId || 'default';
  const health = state.health.body?.status === 'ok';
  const serviceCount = projects.reduce((sum, project) => sum + Number(project.serviceCount ?? project.services ?? 0), 0);
  const resourceCount = projects.reduce((sum, project) => sum + Number(project.resourceCount ?? project.resources ?? 0), 0);
  const metrics = [
    { label: '프로젝트', value: projects.length, detail: '운영 범위', icon: ActivityIcon },
    { label: '서비스', value: serviceCount, detail: '실행 단위', icon: BoxIcon },
    { label: '리소스', value: resourceCount, detail: '관리형 데이터', icon: DatabaseIcon },
  ];

  return (
    <ConsoleShell active="overview" orgValue={createOrgSlug} orgRouteValue={createOrgSlug}>
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8" data-od-id="org-dashboard">
        <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5"><p className="text-xs font-medium text-muted-foreground">CONSOLE OVERVIEW</p><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-[1.75rem]">내 프로젝트</h1><p className="max-w-2xl text-sm text-muted-foreground">서비스와 관리형 리소스를 한곳에서 확인하고 다음 작업으로 이동합니다.</p></div>
          <div className="flex flex-wrap items-center gap-2"><Badge variant={health ? 'outline' : 'destructive'}>{health ? '제어 영역 정상' : '제어 영역 확인 필요'}</Badge><Link className={buttonVariants()} href={`/org/${createOrgSlug}/projects/new`}><PlusIcon data-icon="inline-start" />새 프로젝트</Link></div>
        </header>
        {state.loadErrors?.length ? <Alert variant="destructive"><AlertTitle>일부 정보를 불러오지 못했습니다.</AlertTitle><AlertDescription>{state.loadErrors.map((issue) => issue.label).join(', ')} 정보를 잠시 후 다시 확인해 주세요.</AlertDescription></Alert> : null}
        <section className="grid gap-3 sm:grid-cols-3" aria-label="프로젝트 집계">
          {metrics.map(({ label, value, detail, icon: MetricIcon }) => <Card size="sm" key={label}><CardHeader><CardDescription className="flex items-center gap-2"><MetricIcon />{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{detail}</CardContent></Card>)}
        </section>
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="console-projects-title">
          <div className="flex items-center justify-between gap-3"><div><h2 id="console-projects-title" className="text-lg font-medium text-foreground">최근 프로젝트</h2><p className="text-sm text-muted-foreground">프로젝트를 선택해 운영 화면을 엽니다.</p></div><Badge variant="secondary">{projects.length}개</Badge></div>
          {projects.length ? <div className="flex min-w-0 flex-col gap-2">{projects.map((project) => <ProjectCard key={project.id} project={{ ...project, services: project.serviceCount, resources: project.resourceCount }} href={`/org/${project.organizationSlug || project.organizationId || 'org'}/projects/${project.id}`} />)}</div> : <Empty className="min-h-64 border border-dashed border-border bg-card"><EmptyHeader><EmptyMedia variant="icon"><PlusIcon /></EmptyMedia><EmptyTitle>아직 프로젝트가 없습니다.</EmptyTitle><EmptyDescription>첫 프로젝트를 만들고 Dockerfile부터 안전하게 배포해 보세요.</EmptyDescription></EmptyHeader><EmptyContent><Link className={buttonVariants()} href={`/org/${createOrgSlug}/projects/new`}>첫 프로젝트 만들기</Link></EmptyContent></Empty>}
        </section>
      </section>
    </ConsoleShell>
  );
}

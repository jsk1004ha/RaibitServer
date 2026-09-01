import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { loadDashboardOverview } from '../../../../lib/api';
import { ConsoleShell } from '../../../../components/console-ui';
import { ProjectCard, type ProjectSummary } from '../../../../components/project-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

export default async function ProjectsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const [{ orgSlug }, state] = await Promise.all([params, loadDashboardOverview()]);
  const projects = ((state.projects || []) as ProjectSummary[]).filter((project) => orgSlug === 'all'
    || String(project.organizationSlug || '') === orgSlug
    || String(project.organizationId || '') === orgSlug);
  return (
    <ConsoleShell active="projects" orgValue={orgSlug} orgRouteValue={orgSlug}>
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
        <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0"><p className="mb-1.5 break-all text-xs font-medium text-muted-foreground">{orgSlug}</p><h1 className="break-words text-2xl font-medium tracking-tight text-foreground md:text-[1.75rem]">프로젝트</h1><p className="mt-1.5 text-sm text-muted-foreground">이 조직에서 운영하는 서비스와 리소스를 확인합니다.</p></div><Link className={buttonVariants()} href={`/org/${orgSlug}/projects/new`}><PlusIcon data-icon="inline-start" />프로젝트 만들기</Link></header>
        {state.loadErrors?.length ? <Alert variant="destructive"><AlertTitle>프로젝트 정보를 모두 불러오지 못했습니다.</AlertTitle><AlertDescription>{state.loadErrors.map((issue) => issue.label).join(', ')} 상태를 잠시 후 다시 확인해 주세요.</AlertDescription></Alert> : null}
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="project-list-title">
          <div className="flex items-center justify-between gap-3"><div><h2 id="project-list-title" className="text-lg font-medium text-foreground">프로젝트 목록</h2><p className="text-sm text-muted-foreground">최근 상태와 구성 수를 함께 표시합니다.</p></div><Badge variant="secondary">{projects.length}개</Badge></div>
          {projects.length ? <div className="flex min-w-0 flex-col gap-2">{projects.map((project) => <ProjectCard key={project.id} project={project} href={`/org/${orgSlug}/projects/${project.id}`} />)}</div> : <Empty className="min-h-64 border border-dashed border-border bg-card"><EmptyHeader><EmptyMedia variant="icon"><PlusIcon /></EmptyMedia><EmptyTitle>이 조직에는 아직 프로젝트가 없습니다.</EmptyTitle><EmptyDescription>이름과 저장소, 첫 서비스를 차례로 설정해 시작하세요.</EmptyDescription></EmptyHeader><EmptyContent><Link className={buttonVariants()} href={`/org/${orgSlug}/projects/new`}>첫 프로젝트 만들기</Link></EmptyContent></Empty>}
        </section>
      </section>
    </ConsoleShell>
  );
}

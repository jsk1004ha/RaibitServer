import { apiAction } from '../../../../../lib/api';
import { ConsoleShell } from '../../../../../components/console-ui';
import { ProjectCreateWizard } from '../../../../../components/project-create-wizard';
import { Badge } from '@/components/ui/badge';

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return (
    <ConsoleShell active="create-project" orgValue={orgSlug} orgRouteValue={orgSlug}>
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8" data-od-id="create-project">
        <header className="flex items-end justify-between gap-4 border-b border-border pb-6">
          <div className="min-w-0"><p className="mb-1.5 break-all text-xs font-medium text-muted-foreground">{orgSlug}</p><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-[1.75rem]">프로젝트 만들기</h1><p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">프로젝트 · 저장소 · 서비스 · 리소스를 네 단계로 설정합니다.</p></div>
          <Badge variant="secondary">4단계</Badge>
        </header>
        <ProjectCreateWizard action={apiAction('/projects')} orgSlug={orgSlug} />
      </section>
    </ConsoleShell>
  );
}

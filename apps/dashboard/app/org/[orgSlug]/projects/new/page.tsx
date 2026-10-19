import { apiAction } from '../../../../../lib/api';
import { ConsoleShell } from '../../../../../components/console-ui';
import { ProjectCreateWizard } from '../../../../../components/project-create-wizard';

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return (
    <ConsoleShell active="create-project" orgValue={orgSlug} orgRouteValue={orgSlug}>
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8" data-od-id="create-project">
        <header className="flex items-end justify-between gap-4 border-b border-border pb-6">
          <div className="min-w-0"><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-[1.75rem]">프로젝트 만들기</h1><p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">프로젝트 이름과 배포할 코드 또는 이미지를 연결하세요.</p></div>
        </header>
        <ProjectCreateWizard action={apiAction('/projects')} orgSlug={orgSlug} />
      </section>
    </ConsoleShell>
  );
}

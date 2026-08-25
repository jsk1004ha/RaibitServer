import { apiAction } from '../../../../../lib/api';
import { ConsoleShell } from '../../../../../components/console-ui';
import { ProjectCreateWizard } from '../../../../../components/project-create-wizard';

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return (
    <ConsoleShell active="create-project" orgValue={orgSlug} orgRouteValue={orgSlug}>
      <section className="page create-project-page" data-od-id="create-project">
        <header className="page-header"><div><h1 className="page-title">프로젝트 만들기</h1><p className="page-subtitle">프로젝트 · 저장소 · 서비스</p></div><span className="badge info">4단계</span></header>
        <ProjectCreateWizard action={apiAction('/projects')} orgSlug={orgSlug} />
      </section>
    </ConsoleShell>
  );
}

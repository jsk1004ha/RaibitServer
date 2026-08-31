import { Badge } from '@/components/ui/badge';
import { ActionLink, Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { apiAction, loadGitHubConsole } from '../../lib/api';
import { ConsoleShell, LoadErrorSummary, SectionNav } from '../../components/console-ui';

const steps = ['connect', 'import', 'attach', 'sync'] as const;
type GitHubStep = typeof steps[number];

type GitHubInstallation = {
  readonly installationId?: string;
  readonly integrationId?: string;
  readonly accountLogin?: string;
  readonly repositoryCount?: number;
};

type GitHubRepository = {
  readonly id?: string;
  readonly githubRepoId?: string;
  readonly fullName?: string;
  readonly name?: string;
  readonly private?: boolean;
  readonly defaultBranch?: string;
};

type GitHubProject = { readonly id?: string; readonly name?: string; readonly slug?: string };

const selectClassName = 'h-9 w-full rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25';

export default async function GitHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedStep = String(query.step || 'connect');
  const step = steps.find((candidate) => candidate === requestedStep) || 'connect';
  const state = await loadGitHubConsole();
  const requestedInstallationId = String(query.installation || '');
  const selectedInstallation = state.installations.find((row: GitHubInstallation) => String(row.installationId) === requestedInstallationId)
    || state.installations[0];
  const selectedRepositories = state.repositoriesByInstallation
    .find((row) => String(row.installationId) === String(selectedInstallation?.installationId))
    ?.repositories || [];
  const selectedRepository = selectedRepositories[0];
  const firstService = state.services[0];
  const serviceProject = state.projects.find((project: GitHubProject) => String(project.id) === String(firstService?.projectId));
  const integrationId = selectedInstallation?.integrationId || '';
  const repositoryId = selectedRepository?.githubRepoId || selectedRepository?.id || '';
  const canImportRepository = Boolean(state.projects[0]?.id && integrationId && repositoryId);
  const canAttachRepository = Boolean(firstService?.projectId && firstService?.id && integrationId && repositoryId);
  const canSyncRepository = Boolean(selectedRepository?.fullName);
  const navItems = [
    { id: 'connect', label: 'GitHub 연결', description: 'App 설치', href: '/github?step=connect' },
    { id: 'import', label: '저장소 선택', description: '프로젝트 추가', href: '/github?step=import' },
    { id: 'attach', label: '서비스 연결', description: '실행 단위', href: '/github?step=attach' },
    { id: 'sync', label: '동기화', description: '연동 상태', href: '/github?step=sync' },
  ];

  return (
    <ConsoleShell active="github" eyebrow="저장소" orgValue="GitHub 연동" projectValue={`단계 ${steps.indexOf(step) + 1} / ${steps.length}`}>
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-8 md:py-10" data-t14-github>
        <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium text-primary">저장소 연결</p>
            <h1 className="text-3xl font-medium tracking-tight text-foreground text-balance">GitHub 연결</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground text-pretty">GitHub App을 설치한 뒤 저장소를 프로젝트 또는 기존 서비스에 연결합니다.</p>
          </div>
          <Badge variant={state.installations.length ? 'default' : 'outline'}>{state.installations.length ? '연결됨' : '연결 필요'}</Badge>
        </header>
        <LoadErrorSummary issues={state.loadErrors} />
        <div className="[&_.section-nav-item.active_small]:!text-foreground">
          <SectionNav items={navItems} current={step} label="저장소 연결 단계" variant="steps" />
        </div>

        {step === 'connect' ? (
          <Card>
            <CardHeader><CardTitle><h2>GitHub App 연결</h2></CardTitle><CardDescription>계정과 저장소를 GitHub에서 선택합니다. OAuth 로그인과 App 설치는 별도 흐름으로 유지됩니다.</CardDescription></CardHeader>
            <CardContent>
              {state.installations.length ? (
                <dl className="divide-y divide-border rounded-md border border-border">{state.installations.map((installation: GitHubInstallation) => <div className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:items-center" key={installation.installationId}><dt className="text-sm text-muted-foreground">연결 계정</dt><dd className="min-w-0 truncate text-sm font-medium text-foreground">{installation.accountLogin} · 저장소 {installation.repositoryCount || 0}개</dd></div>)}</dl>
              ) : <Empty className="border border-dashed border-border" role="status"><EmptyHeader><EmptyTitle>연결된 계정이 없습니다.</EmptyTitle><EmptyDescription>GitHub에서 설치할 계정과 접근 가능한 저장소를 선택하세요.</EmptyDescription></EmptyHeader></Empty>}
            </CardContent>
            <CardFooter className="flex flex-col-reverse gap-2 border-t border-border sm:flex-row sm:justify-end">
              {state.installations.length ? <ActionLink className="justify-center sm:mr-auto" href="/github?step=import">저장소 선택</ActionLink> : null}
              <a className={cn(buttonVariants(), 'w-full sm:w-auto')} href="/github/install">{state.installations.length ? '다른 계정 연결' : 'GitHub 연결'}</a>
            </CardFooter>
          </Card>
        ) : null}

        {step === 'import' ? (
          <Card>
            <CardHeader><CardTitle><h2>저장소 선택</h2></CardTitle><CardDescription>선택한 저장소에서 프로젝트에 새 서비스를 만듭니다.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-6">
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="import" />
              {canImportRepository ? (
                <form id="import-repository" method="post" action={apiAction('/github/repositories/import', state.context)}>
                  <input type="hidden" name="_returnTo" value="/github?step=attach" /><input type="hidden" name="integrationId" value={integrationId} />
                  <FieldSet><FieldGroup>
                    <Field><FieldLabel htmlFor="github-import-repository">저장소</FieldLabel><select className={selectClassName} id="github-import-repository" name="repositoryId" defaultValue={repositoryId}>{selectedRepositories.map((repository: GitHubRepository) => <option key={repository.githubRepoId || repository.id} value={repository.githubRepoId || repository.id}>{repository.fullName} · {repository.private ? '비공개' : '공개'}</option>)}</select></Field>
                    <Field><FieldLabel htmlFor="github-import-project">프로젝트</FieldLabel><select className={selectClassName} id="github-import-project" name="projectId" defaultValue={state.projects[0]?.id}>{state.projects.map((project: GitHubProject) => <option key={project.id} value={project.id}>{project.name || project.slug}</option>)}</select></Field>
                    <Field><FieldLabel htmlFor="github-service-name">서비스 이름</FieldLabel><Input id="github-service-name" name="serviceName" placeholder={selectedRepository?.name || 'web'} /><FieldDescription>비우면 저장소 이름을 기준으로 생성됩니다.</FieldDescription></Field>
                    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end"><ActionLink className="justify-center sm:mr-auto" href="/github?step=connect">이전</ActionLink><Button type="submit">가져오기</Button></div>
                  </FieldGroup></FieldSet>
                </form>
              ) : <EmptyGitHubStep hasInstallation={Boolean(selectedInstallation)} hasRepositories={selectedRepositories.length > 0} hasProjects={state.projects.length > 0} />}
            </CardContent>
          </Card>
        ) : null}

        {step === 'attach' ? (
          <Card>
            <CardHeader><CardTitle><h2>서비스 연결</h2></CardTitle><CardDescription>기존 서비스가 사용할 저장소와 기본 브랜치를 지정합니다.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-6">
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="attach" />
              {canAttachRepository ? (
                <form method="post" action={apiAction(`/projects/${firstService.projectId}/services/${firstService.id}/github`, state.context)}>
                  <input type="hidden" name="_returnTo" value="/github?step=sync" /><input type="hidden" name="integrationId" value={integrationId} />
                  <FieldSet><FieldGroup>
                    <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"><span className="text-muted-foreground">연결 대상</span><p className="mt-1 font-medium text-foreground"><strong>{serviceProject?.name || firstService.projectId}</strong> / {firstService.name || firstService.id}</p></div>
                    <Field><FieldLabel htmlFor="github-attach-repository">저장소</FieldLabel><select className={selectClassName} id="github-attach-repository" name="repositoryId" defaultValue={repositoryId}>{selectedRepositories.map((repository: GitHubRepository) => <option key={repository.githubRepoId || repository.id} value={repository.githubRepoId || repository.id}>{repository.fullName} · {repository.private ? '비공개' : '공개'}</option>)}</select></Field>
                    <Field><FieldLabel htmlFor="github-branch">브랜치</FieldLabel><Input id="github-branch" name="branch" defaultValue={selectedRepository?.defaultBranch || 'main'} /></Field>
                    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end"><ActionLink className="justify-center sm:mr-auto" href="/github?step=import">이전</ActionLink><button className={buttonVariants()} type="submit">연결</button></div>
                  </FieldGroup></FieldSet>
                </form>
              ) : <EmptyGitHubStep message="연결할 서비스와 저장소가 필요합니다." />}
            </CardContent>
          </Card>
        ) : null}

        {step === 'sync' ? (
          <Card>
            <CardHeader><CardTitle><h2>저장소 동기화</h2></CardTitle><CardDescription>저장소 권한과 기본 브랜치 정보를 다시 확인합니다.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-6">
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="sync" />
              {canSyncRepository ? (
                <form method="post" action={apiAction(`/github/repositories/${encodeURIComponent(selectedRepository.fullName)}/sync`, state.context)} className="flex flex-col gap-5">
                  <input type="hidden" name="_returnTo" value={`/github?step=sync&installation=${encodeURIComponent(selectedInstallation.installationId)}`} />
                  <div className="rounded-md border border-border bg-muted/40 px-4 py-3"><p className="text-xs text-muted-foreground">동기화 대상</p><p className="mt-1 break-all text-sm font-medium text-foreground"><strong>{selectedRepository.fullName}</strong></p></div>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><ActionLink className="justify-center sm:mr-auto" href="/github?step=attach">이전</ActionLink><button className={buttonVariants()} type="submit">동기화</button></div>
                </form>
              ) : <EmptyGitHubStep message="동기화할 저장소가 없습니다." />}
            </CardContent>
          </Card>
        ) : null}
      </section>
    </ConsoleShell>
  );
}

function InstallationChooser({ installations, selectedId, step }: { installations: readonly Record<string, unknown>[]; selectedId?: string; step: GitHubStep }) {
  if (installations.length < 2) return null;
  return <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="GitHub 계정">{installations.map((installation) => {
    const installationId = String(installation.installationId || '');
    const active = installationId === String(selectedId);
    return <a key={installationId} className={cn(buttonVariants({ variant: active ? 'secondary' : 'outline' }), 'h-auto min-w-36 flex-col items-start py-2')} aria-current={active ? 'page' : undefined} href={`/github?step=${step}&installation=${encodeURIComponent(installationId)}`}><strong className="max-w-full truncate">{String(installation.accountLogin || 'GitHub 계정')}</strong><span className="text-xs font-normal text-muted-foreground">저장소 {Number(installation.repositoryCount || 0)}개</span></a>;
  })}</nav>;
}

function EmptyGitHubStep({ hasInstallation, hasRepositories, hasProjects, message }: { hasInstallation?: boolean; hasRepositories?: boolean; hasProjects?: boolean; message?: string }) {
  const description = message || (!hasInstallation ? '먼저 GitHub를 연결하세요.' : !hasRepositories ? '선택된 저장소가 없습니다. GitHub에서 권한을 추가하세요.' : !hasProjects ? '먼저 프로젝트를 만드세요.' : '선택할 항목이 없습니다.');
  return <Empty className="border border-dashed border-border" role="status"><EmptyHeader><EmptyTitle>현재 단계를 진행할 수 없습니다.</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader><EmptyContent>{!hasInstallation && !message ? <a className={buttonVariants()} href="/github/install">GitHub 연결</a> : null}</EmptyContent></Empty>;
}

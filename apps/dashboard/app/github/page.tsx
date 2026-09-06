import { Badge } from '@/components/ui/badge';
import { ActionLink, Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { redirect } from 'next/navigation';
import { apiAction, loadGitHubConsole } from '../../lib/api';
import { scopedProjectHrefs } from '../../lib/github-project-link-contract.mjs';
import { ConsoleShell, LoadErrorSummary, SectionNav } from '../../components/console-ui';
import { GitHubCatalogRefresh } from '../../components/github-catalog-refresh';
import { GitHubLifecycleControls, type GitHubLifecycleIntegration, type GitHubLifecycleStatus } from '../../components/github-lifecycle-controls';
import { GitHubSourceMutation } from '../../components/github-source-mutation';

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
  readonly owner?: string;
  readonly fullName?: string;
  readonly normalizedIdentity?: string;
  readonly name?: string;
  readonly private?: boolean;
  readonly defaultBranch?: string;
  readonly accessState?: 'ACCESSIBLE' | 'REVOKED';
  readonly generation?: number;
  readonly installationId?: string;
};

type GitHubProject = { readonly id?: string; readonly name?: string; readonly slug?: string; readonly organizationSlug?: string };

type GitHubRepositoryCatalog = {
  readonly installationId: string;
  readonly generation: number;
  readonly refreshStatus: 'IDLE' | 'REFRESHING' | 'STALE';
  readonly lastSuccessfulSyncAt: string | null;
  readonly staleAt: string | null;
  readonly repositories: readonly GitHubRepository[];
  readonly nextCursor: string | null;
};

const selectClassName = 'h-9 w-full rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25';

export default async function GitHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedStep = String(query.step || 'connect');
  const step = steps.find((candidate) => candidate === requestedStep) || 'connect';
  const requestedInstallationId = queryValue(query.installation);
  const catalogCursor = queryValue(query.cursor);
  const requestedCatalogQuery = queryValue(query.q);
  const catalogQuery = normalizeCatalogFilter(requestedCatalogQuery);
  if (step === 'import' && requestedCatalogQuery && requestedCatalogQuery !== catalogQuery) redirect(githubHref({ installationId: requestedInstallationId, q: catalogQuery, cursor: catalogCursor || undefined }));
  const state = await loadGitHubConsole(undefined, { installationId: requestedInstallationId || undefined, cursor: catalogCursor || undefined, q: catalogQuery || undefined });
  const selectedInstallation = state.installations.find((row: GitHubInstallation) => String(row.installationId) === requestedInstallationId)
    || state.installations[0];
  const catalog = githubRepositoryCatalog(state.repositoryCatalog, selectedInstallation?.installationId || '');
  const selectedRepositories = catalog?.repositories || state.repositoriesByInstallation
    .find((row) => String(row.installationId) === String(selectedInstallation?.installationId))
    ?.repositories || [];
  const selectedRepository = selectedRepositories.find((repository: GitHubRepository) => repository.accessState !== 'REVOKED');
  const firstService = state.services[0];
  const serviceProject = state.projects.find((project: GitHubProject) => String(project.id) === String(firstService?.projectId));
  const integrationId = selectedInstallation?.integrationId || '';
  const repositoryId = selectedRepository?.githubRepoId || selectedRepository?.id || '';
  const lifecycleIntegrations: readonly GitHubLifecycleIntegration[] = state.integrations.flatMap((integration: unknown) => {
    const parsed = lifecycleIntegration(integration);
    return parsed ? [parsed] : [];
  });
  const selectedIntegration = lifecycleIntegrations.find((integration) => integration.id === integrationId);
  const sourceAvailable = Boolean(selectedIntegration?.connected && selectedIntegration.credentialIssuance === 'allowed' && selectedIntegration.status === 'ACTIVE');
  const canImportRepository = Boolean(state.projects[0]?.id && integrationId && repositoryId && sourceAvailable);
  const canAttachRepository = Boolean(firstService?.projectId && firstService?.id && integrationId && repositoryId && sourceAvailable);
  const canSyncRepository = Boolean(selectedRepository?.fullName && sourceAvailable);
  const canRefreshCatalog = Boolean(catalog && selectedIntegration && sourceAvailable && canDisconnectIntegration(selectedIntegration, state.memberships, state.subject));
  const projectHrefs = scopedProjectHrefs({ memberships: state.memberships, projects: state.projects, subject: state.subject });
  const repositoryDefaultBranches = repositoryDefaultBranchesFor(selectedRepositories);
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
          <div className="flex flex-col gap-6">
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
            {lifecycleIntegrations.map((integration) => <GitHubLifecycleControls canDisconnect={canDisconnectIntegration(integration, state.memberships, state.subject)} integration={integration} key={integration.id} />)}
          </div>
        ) : null}

        {step === 'import' ? (
          <Card>
            <CardHeader><CardTitle><h2>저장소 선택</h2></CardTitle><CardDescription>선택한 저장소에서 프로젝트에 새 서비스를 만듭니다.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-6">
              <InstallationChooser installations={state.installations} selectedId={selectedInstallation?.installationId} step="import" />
              {catalog && selectedInstallation ? <GitHubRepositoryCatalogView catalog={catalog} canRefresh={canRefreshCatalog} installation={selectedInstallation} integration={selectedIntegration} q={catalogQuery} /> : null}
              {canImportRepository ? (
                <GitHubSourceMutation action={apiAction('/github/repositories/import', state.context)} branchInputId="github-import-branch" formId="import-repository" pendingLabel="저장소를 가져오는 중" projectHrefs={projectHrefs} repositoryDefaultBranches={repositoryDefaultBranches} returnTo="/github?step=attach" submitLabel="가져오기">
                  <input type="hidden" name="integrationId" value={integrationId} />{catalog ? <input type="hidden" name="expectedCatalogGeneration" value={catalog.generation} /> : null}
                  <FieldSet><FieldGroup>
                    <Field><FieldLabel htmlFor="github-import-repository">저장소</FieldLabel><select className={selectClassName} id="github-import-repository" name="repositoryId" defaultValue={repositoryId}>{selectedRepositories.filter((repository: GitHubRepository) => repository.accessState !== 'REVOKED').map((repository: GitHubRepository) => <option key={repository.githubRepoId || repository.id} value={repository.githubRepoId || repository.id}>{repository.fullName} · {repository.private ? '비공개' : '공개'}</option>)}</select></Field>
                    <Field><FieldLabel htmlFor="github-import-project">프로젝트</FieldLabel><select className={selectClassName} id="github-import-project" name="projectId" defaultValue={state.projects[0]?.id}>{state.projects.map((project: GitHubProject) => <option key={project.id} value={project.id}>{project.name || project.slug}</option>)}</select></Field>
                    <Field><FieldLabel htmlFor="github-service-name">서비스 이름</FieldLabel><Input id="github-service-name" name="serviceName" placeholder={selectedRepository?.name || 'web'} /><FieldDescription>비우면 저장소 이름을 기준으로 생성됩니다.</FieldDescription></Field>
                    <Field><FieldLabel htmlFor="github-import-service-slug">서비스 슬러그</FieldLabel><Input id="github-import-service-slug" name="serviceSlug" placeholder="선택 사항" /><FieldDescription>자동 이름 변경 없이, 충돌이 발생하면 직접 새 슬러그를 선택합니다.</FieldDescription></Field>
                    <Field><FieldLabel htmlFor="github-import-branch">브랜치</FieldLabel><Input id="github-import-branch" name="branch" defaultValue={selectedRepository?.defaultBranch || 'main'} /></Field>
                    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end"><ActionLink className="justify-center sm:mr-auto" href="/github?step=connect">이전</ActionLink></div>
                  </FieldGroup></FieldSet>
                </GitHubSourceMutation>
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
                <GitHubSourceMutation action={apiAction(`/projects/${firstService.projectId}/services/${firstService.id}/github`, state.context)} branchInputId="github-attach-branch" pendingLabel="서비스 연결 중" projectHrefs={projectHrefs} repositoryDefaultBranches={repositoryDefaultBranches} returnTo="/github?step=sync" submitLabel="연결">
                  <input type="hidden" name="integrationId" value={integrationId} />{catalog ? <input type="hidden" name="expectedCatalogGeneration" value={catalog.generation} /> : null}{selectedRepository?.defaultBranch ? <input type="hidden" name="expectedDefaultBranch" value={selectedRepository.defaultBranch} /> : null}
                  <FieldSet><FieldGroup>
                    <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"><span className="text-muted-foreground">연결 대상</span><p className="mt-1 font-medium text-foreground"><strong>{serviceProject?.name || firstService.projectId}</strong> / {firstService.name || firstService.id}</p></div>
                    <Field><FieldLabel htmlFor="github-attach-repository">저장소</FieldLabel><select className={selectClassName} id="github-attach-repository" name="repositoryId" defaultValue={repositoryId}>{selectedRepositories.filter((repository: GitHubRepository) => repository.accessState !== 'REVOKED').map((repository: GitHubRepository) => <option key={repository.githubRepoId || repository.id} value={repository.githubRepoId || repository.id}>{repository.fullName} · {repository.private ? '비공개' : '공개'}</option>)}</select></Field>
                    <Field><FieldLabel htmlFor="github-attach-branch">브랜치</FieldLabel><Input id="github-attach-branch" name="branch" defaultValue={selectedRepository?.defaultBranch || 'main'} /></Field>
                    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end"><ActionLink className="justify-center sm:mr-auto" href="/github?step=import">이전</ActionLink></div>
                  </FieldGroup></FieldSet>
                </GitHubSourceMutation>
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
                <GitHubSourceMutation action={apiAction(`/github/repositories/${encodeURIComponent(selectedRepository.fullName)}/sync`, state.context)} branchInputId="github-sync-branch" pendingLabel="저장소 동기화 중" projectHrefs={projectHrefs} repositoryDefaultBranches={repositoryDefaultBranches} returnTo={`/github?step=sync&installation=${encodeURIComponent(selectedInstallation.installationId)}`} submitLabel="동기화">
                  <input type="hidden" name="integrationId" value={integrationId} />{catalog ? <input type="hidden" name="expectedCatalogGeneration" value={catalog.generation} /> : null}{selectedRepository?.defaultBranch ? <input type="hidden" name="expectedDefaultBranch" value={selectedRepository.defaultBranch} /> : null}<input type="hidden" name="repositoryId" value={repositoryId} />
                  <div className="rounded-md border border-border bg-muted/40 px-4 py-3"><p className="text-xs text-muted-foreground">동기화 대상</p><p className="mt-1 break-all text-sm font-medium text-foreground"><strong>{selectedRepository.fullName}</strong></p></div>
                  <Field><FieldLabel htmlFor="github-sync-branch">브랜치</FieldLabel><Input id="github-sync-branch" name="branch" defaultValue={selectedRepository?.defaultBranch || 'main'} /></Field>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><ActionLink className="justify-center sm:mr-auto" href="/github?step=attach">이전</ActionLink></div>
                </GitHubSourceMutation>
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

function GitHubRepositoryCatalogView({ catalog, canRefresh, installation, integration, q }: { catalog: GitHubRepositoryCatalog; canRefresh: boolean; installation: GitHubInstallation; integration: GitHubLifecycleIntegration | undefined; q: string }) {
  const installationId = installation.installationId || catalog.installationId;
  const metadata = repositoryCatalogStatus(catalog.refreshStatus);
  const nextHref = catalog.nextCursor ? githubHref({ installationId, q, cursor: catalog.nextCursor }) : null;
  return (
    <section className="flex flex-col gap-4 rounded-md border border-border p-4" aria-labelledby="github-repository-catalog-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div><h3 className="text-base font-medium text-foreground" id="github-repository-catalog-title">저장소 카탈로그</h3><p className="mt-1 text-sm text-muted-foreground">{metadata.description}</p></div>
        <Badge variant={metadata.variant}>{metadata.label}</Badge>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">마지막 성공 동기화</dt><dd className="font-medium text-foreground">{formatCatalogTimestamp(catalog.lastSuccessfulSyncAt)}</dd></div>{catalog.refreshStatus === 'STALE' ? <div><dt className="text-muted-foreground">오래된 상태 감지</dt><dd className="font-medium text-foreground">{formatCatalogTimestamp(catalog.staleAt)}</dd></div> : null}</dl>
      <form action="/github" className="flex flex-col gap-2 sm:flex-row" method="get">
        <input name="step" type="hidden" value="import" /><input name="installation" type="hidden" value={installationId} />
        <Field className="flex-1"><FieldLabel className="sr-only" htmlFor="github-repository-filter">저장소 필터</FieldLabel><Input defaultValue={q} id="github-repository-filter" name="q" placeholder="저장소 이름으로 필터" type="search" /></Field>
        <Button type="submit" variant="outline">필터 적용</Button>
      </form>
      {integration ? <GitHubCatalogRefresh canRefresh={canRefresh} expectedGeneration={catalog.generation} expectedIntegrationVersion={integration.version} installationId={installationId} refreshing={catalog.refreshStatus === 'REFRESHING'} /> : null}
      {catalog.refreshStatus === 'STALE' ? <p className="rounded-sm border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="status">표시 중인 목록은 마지막 성공 동기화 결과입니다. 새로고침에 실패해도 기존 목록은 유지됩니다.</p> : null}
      {catalog.repositories.length ? <Table><TableHeader><TableRow><TableHead>저장소</TableHead><TableHead>기본 브랜치</TableHead><TableHead>공개 범위</TableHead><TableHead>접근</TableHead></TableRow></TableHeader><TableBody>{catalog.repositories.map((repository) => <TableRow key={repository.id || repository.githubRepoId || repository.fullName}><TableCell className="max-w-72 truncate font-medium text-foreground">{repository.fullName || repository.name || '저장소'}</TableCell><TableCell>{repository.defaultBranch || '기본 브랜치 없음'}</TableCell><TableCell>{repository.private ? '비공개' : '공개'}</TableCell><TableCell><Badge variant={repository.accessState === 'REVOKED' ? 'destructive' : 'default'}>{repository.accessState === 'REVOKED' ? '접근 철회됨' : '접근 가능'}</Badge></TableCell></TableRow>)}</TableBody></Table> : <Empty className="border border-dashed border-border" role="status"><EmptyHeader><EmptyTitle>일치하는 저장소가 없습니다.</EmptyTitle><EmptyDescription>필터를 지우거나 GitHub 접근 권한을 확인하세요.</EmptyDescription></EmptyHeader></Empty>}
      {nextHref ? <div className="flex justify-end"><a className={buttonVariants({ variant: 'outline' })} href={nextHref}>다음 50개</a></div> : null}
    </section>
  );
}

function repositoryCatalogStatus(status: GitHubRepositoryCatalog['refreshStatus']): { readonly label: string; readonly description: string; readonly variant: 'default' | 'outline' | 'destructive' } {
  if (status === 'REFRESHING') return { label: '새로고침 진행 중', description: '새 목록을 준비하고 있습니다. 현재 표시된 목록은 마지막으로 확인된 결과입니다.', variant: 'outline' };
  if (status === 'STALE') return { label: '오래된 목록', description: '새로고침이 완료되지 않아 마지막 성공 결과를 표시합니다.', variant: 'destructive' };
  return { label: '동기화됨', description: 'GitHub에서 마지막으로 성공적으로 확인한 목록입니다.', variant: 'default' };
}

function githubHref({ installationId, q, cursor }: { installationId: string; q?: string; cursor?: string }): string {
  const params = new URLSearchParams({ step: 'import', installation: installationId });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  return `/github?${params.toString()}`;
}

function repositoryDefaultBranchesFor(repositories: readonly GitHubRepository[]): Readonly<Record<string, string>> {
  const branches: Record<string, string> = {};
  for (const repository of repositories) {
    if (!repository.defaultBranch) continue;
    if (repository.id) branches[repository.id] = repository.defaultBranch;
    if (repository.githubRepoId) branches[repository.githubRepoId] = repository.defaultBranch;
  }
  return branches;
}

function formatCatalogTimestamp(value: string | null): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '기록 없음';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
}

function githubRepositoryCatalog(value: unknown, expectedInstallationId: string): GitHubRepositoryCatalog | null {
  if (!isRecord(value) || typeof value.installationId !== 'string' || value.installationId !== expectedInstallationId
    || !isNonnegativeSafeInteger(value.generation) || !isRepositoryRefreshStatus(value.refreshStatus)
    || !Array.isArray(value.repositories) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')) return null;
  const repositories = value.repositories.flatMap((repository: unknown) => githubRepository(repository));
  if (repositories.length !== value.repositories.length) return null;
  return {
    installationId: value.installationId,
    generation: value.generation,
    refreshStatus: value.refreshStatus,
    lastSuccessfulSyncAt: typeof value.lastSuccessfulSyncAt === 'string' ? value.lastSuccessfulSyncAt : null,
    staleAt: typeof value.staleAt === 'string' ? value.staleAt : null,
    repositories,
    nextCursor: value.nextCursor,
  };
}

function githubRepository(value: unknown): GitHubRepository[] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.installationId !== 'string' || typeof value.githubRepoId !== 'string' || typeof value.owner !== 'string'
    || typeof value.name !== 'string' || typeof value.fullName !== 'string' || typeof value.normalizedIdentity !== 'string' || typeof value.defaultBranch !== 'string'
    || typeof value.private !== 'boolean' || !isRepositoryAccessState(value.accessState) || !isNonnegativeSafeInteger(value.generation)) return [];
  return [{ id: value.id, installationId: value.installationId, githubRepoId: value.githubRepoId, owner: value.owner, name: value.name, fullName: value.fullName, normalizedIdentity: value.normalizedIdentity, defaultBranch: value.defaultBranch, private: value.private, accessState: value.accessState, generation: value.generation }];
}

function isRepositoryRefreshStatus(value: unknown): value is GitHubRepositoryCatalog['refreshStatus'] {
  return value === 'IDLE' || value === 'REFRESHING' || value === 'STALE';
}

function isRepositoryAccessState(value: unknown): value is 'ACCESSIBLE' | 'REVOKED' {
  return value === 'ACCESSIBLE' || value === 'REVOKED';
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeCatalogFilter(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 200);
}

function queryValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function EmptyGitHubStep({ hasInstallation, hasRepositories, hasProjects, message }: { hasInstallation?: boolean; hasRepositories?: boolean; hasProjects?: boolean; message?: string }) {
  const description = message || (!hasInstallation ? '먼저 GitHub를 연결하세요.' : !hasRepositories ? '선택된 저장소가 없습니다. GitHub에서 권한을 추가하세요.' : !hasProjects ? '먼저 프로젝트를 만드세요.' : '선택할 항목이 없습니다.');
  return <Empty className="border border-dashed border-border" role="status"><EmptyHeader><EmptyTitle>현재 단계를 진행할 수 없습니다.</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader><EmptyContent>{!hasInstallation && !message ? <a className={buttonVariants()} href="/github/install">GitHub 연결</a> : null}</EmptyContent></Empty>;
}

function lifecycleIntegration(value: unknown): GitHubLifecycleIntegration | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (typeof value.id !== 'string' || typeof value.organizationId !== 'string' || typeof value.version !== 'number'
    || !Number.isSafeInteger(value.version) || value.version < 1 || !isGitHubLifecycleStatus(status)
    || typeof value.connected !== 'boolean' || (value.credentialIssuance !== 'allowed' && value.credentialIssuance !== 'denied')
    || typeof value.externalGitHubSettingsUrl !== 'string' || typeof value.reattachUrl !== 'string') return null;
  return {
    id: value.id,
    organizationId: value.organizationId,
    accountLogin: typeof value.accountLogin === 'string' ? value.accountLogin : null,
    installationId: typeof value.installationId === 'string' ? value.installationId : null,
    status,
    version: value.version,
    connected: value.connected,
    credentialIssuance: value.credentialIssuance,
    externalGitHubSettingsUrl: value.externalGitHubSettingsUrl,
    reattachUrl: value.reattachUrl,
  };
}

function canDisconnectIntegration(integration: GitHubLifecycleIntegration, memberships: unknown, subject: unknown): boolean {
  const membershipRole = Array.isArray(memberships)
    ? memberships.find((membership) => isRecord(membership) && membership.organizationId === integration.organizationId)?.role
    : null;
  const subjectRole = isRecord(subject) && subject.organizationId === integration.organizationId ? subject.role : null;
  const mappedRole = isRecord(subject) && isRecord(subject.rolesByOrganization) ? subject.rolesByOrganization[integration.organizationId] : null;
  return [membershipRole, subjectRole, mappedRole].some((role) => role === 'OWNER' || role === 'ADMIN');
}

function isGitHubLifecycleStatus(value: unknown): value is GitHubLifecycleStatus {
  return value === 'ACTIVE' || value === 'SUSPENDED' || value === 'DISCONNECTED' || value === 'DELETED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

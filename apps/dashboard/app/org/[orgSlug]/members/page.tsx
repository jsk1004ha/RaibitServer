import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConsoleShell } from '@/components/console-ui';
import { OrganizationMembers, type OrganizationInvite, type OrganizationMember } from '@/components/organization-members';
import { dashboardApiContext, getJson } from '@/lib/api';

export default async function OrganizationMembersPage({ params }: Readonly<{ params: Promise<{ orgSlug: string }> }>) {
  const [{ orgSlug }, context] = await Promise.all([params, dashboardApiContext()]);
  const organizationId = orgSlug;
  const [membersResult, invitesResult, meResult] = await Promise.all([
    getJson(`/organizations/${encodeURIComponent(organizationId)}/members`, { members: [] }, context),
    getJson(`/organizations/${encodeURIComponent(organizationId)}/invites`, { invites: [] }, context),
    getJson('/auth/me', { user: null }, context),
  ]);
  const members = Array.isArray(membersResult.body?.members) ? membersResult.body.members as OrganizationMember[] : [];
  const invites = Array.isArray(invitesResult.body?.invites) ? invitesResult.body.invites as OrganizationInvite[] : [];
  const unavailable = !membersResult.ok || !invitesResult.ok;

  return (
    <ConsoleShell active="projects" orgRouteValue={organizationId} orgValue={organizationId} projectLabel="작업 공간" projectValue="구성원 관리">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
        <header className="border-b border-border pb-6"><p className="mb-1.5 text-xs font-medium text-muted-foreground">작업 공간</p><h1 className="text-2xl font-medium tracking-tight text-foreground md:text-[1.75rem]">팀원 관리</h1><p className="mt-1.5 text-sm text-muted-foreground">같은 공간의 프로젝트에 접근할 팀원을 초대하고 역할을 관리합니다.</p></header>
        {unavailable ? <Alert variant="destructive"><AlertTitle>팀원 정보를 모두 불러오지 못했습니다.</AlertTitle><AlertDescription>권한 또는 연결 상태를 확인한 뒤 다시 시도하세요.</AlertDescription></Alert> : <OrganizationMembers initialInvites={invites} initialMembers={members} organizationId={organizationId} userId={typeof meResult.body?.user?.id === 'string' ? meResult.body.user.id : null} />}
      </section>
    </ConsoleShell>
  );
}

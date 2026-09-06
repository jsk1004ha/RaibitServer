import { ConsoleShell } from '../../../components/console-ui';
import { AccountSecurity } from '../../../components/account-security';
import { dashboardApiContext, getJson } from '../../../lib/api';

export default async function AccountSecurityPage() {
  const context = await dashboardApiContext();
  const [me, github] = await Promise.all([
    getJson('/auth/me', { user: null, subject: null }, context),
    getJson('/integrations/github', { integrations: [] }, context),
  ]);
  const user = me.ok ? me.body?.user : null;
  const subject = me.ok ? me.body?.subject : null;
  const organization = String(subject?.organizationSlug || subject?.organizationId || '현재 조직');
  const role = String(subject?.organizationRole || subject?.role || user?.role || '권한 확인 중');
  return <ConsoleShell active="overview" orgValue={organization} projectValue="계정"><AccountSecurity email={user?.email} githubConnected={github.ok && Array.isArray(github.body?.integrations) && github.body.integrations.length > 0} role={role} /></ConsoleShell>;
}

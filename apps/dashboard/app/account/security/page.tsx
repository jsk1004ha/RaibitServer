import { ConsoleShell } from '../../../components/console-ui';
import { AccountSecurity } from '../../../components/account-security';
import { dashboardApiContext, getJson } from '../../../lib/api';

export default async function AccountSecurityPage() {
  const context = await dashboardApiContext();
  const me = await getJson('/auth/me', { user: null, subject: null }, context);
  const user = me.ok ? me.body?.user : null;
  const subject = me.ok ? me.body?.subject : null;
  const role = String(subject?.organizationRole || subject?.role || user?.role || '권한 확인 중');
  return <ConsoleShell active="account" eyebrow="계정" projectValue="계정 보안"><AccountSecurity email={user?.email} role={role} /></ConsoleShell>;
}

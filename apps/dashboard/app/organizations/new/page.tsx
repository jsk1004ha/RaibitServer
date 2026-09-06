import { ConsoleShell } from '@/components/console-ui';
import { OrganizationCreateForm } from '@/components/organization-create-form';

export default function NewOrganizationPage() {
  return (
    <ConsoleShell active="projects" projectLabel="조직" projectValue="새 조직 만들기">
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
        <header className="border-b border-border pb-6"><p className="mb-1.5 text-xs font-medium text-muted-foreground">ORGANIZATION</p><p className="text-sm text-muted-foreground">조직을 만들면 현재 인증된 사용자가 첫 소유자가 됩니다.</p></header>
        <OrganizationCreateForm />
      </section>
    </ConsoleShell>
  );
}

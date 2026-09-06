import type { Metadata } from 'next';
import { OrganizationInviteAcceptance } from '@/components/organization-invite-acceptance';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Brand } from '@/components/brand';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

function inviteToken(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export default async function OrganizationInviteAcceptPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const token = inviteToken((await searchParams).token);
  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <section className="w-full max-w-md"><a className="mb-8 flex w-fit items-center gap-3 text-sm font-medium" href="/"><Brand height={40} width={40} /><span>RAIBIT SERVER</span></a>{token ? <OrganizationInviteAcceptance token={token} /> : <Alert variant="destructive"><AlertTitle>초대 링크를 확인해 주세요.</AlertTitle><AlertDescription>초대 이메일에서 받은 최신 링크를 다시 열어 주세요.</AlertDescription></Alert>}</section>
    </main>
  );
}

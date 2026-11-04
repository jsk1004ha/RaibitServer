import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ActionLink } from '@/components/ui/button';
import { roleLabel } from '@/lib/console-navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type AccountSecurityProps = Readonly<{ email?: string | null; role: string }>;

export function AccountSecurity({ email, role }: AccountSecurityProps) {
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-raibit-xl px-raibit-lg py-raibit-xl md:px-raibit-xl md:py-raibit-xxl">
    <header><p className="text-caption text-muted-foreground">ACCOUNT SECURITY</p><h1>계정 보안</h1><p className="mt-raibit-sm text-muted-foreground">비밀번호를 재설정하고 로그인 방법을 확인하세요.</p></header>
    <Card><CardHeader><CardTitle><h2>현재 계정</h2></CardTitle><CardDescription>로그인한 계정의 이메일과 역할입니다.</CardDescription></CardHeader><CardContent className="grid gap-raibit-sm text-sm"><p><span className="text-muted-foreground">이메일 </span>{email || '이메일 정보 없음'}</p><p><span className="text-muted-foreground">역할 </span>{roleLabel(role)}</p></CardContent></Card>
    <Card><CardHeader><CardTitle><h2>비밀번호</h2></CardTitle><CardDescription>비밀번호를 변경하면 기존 세션은 종료되며 새 비밀번호로 다시 로그인해야 합니다.</CardDescription></CardHeader><CardContent><ActionLink href="/login?mode=forgot">비밀번호 재설정 시작</ActionLink></CardContent></Card>
    <Alert variant="notice"><AlertTitle>GitHub로 로그인하려면</AlertTitle><AlertDescription>GitHub의 인증 이메일이 가입 승인된 라이빗 계정의 이메일과 같아야 합니다. 저장소 연결과 GitHub 로그인은 별개입니다. 로그인이 되지 않으면 이메일과 비밀번호로 로그인하거나 <a className="underline" href="/support">지원 페이지</a>에서 문의하세요.</AlertDescription></Alert>
  </div>;
}

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ActionLink } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type AccountSecurityProps = Readonly<{ email?: string | null; githubConnected: boolean; role: string }>;

export function AccountSecurity({ email, githubConnected, role }: AccountSecurityProps) {
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-raibit-xl px-raibit-lg py-raibit-xl md:px-raibit-xl md:py-raibit-xxl">
    <header><p className="text-caption text-muted-foreground">ACCOUNT SECURITY</p><h1>계정 보안</h1><p className="mt-raibit-sm text-muted-foreground">로그인 수단과 현재 세션을 안전하게 관리합니다.</p></header>
    <Card><CardHeader><CardTitle><h2>현재 계정</h2></CardTitle><CardDescription>이메일과 역할 정보는 서버에서 인증된 현재 세션을 기준으로 표시합니다.</CardDescription></CardHeader><CardContent className="grid gap-raibit-sm text-sm"><p><span className="text-muted-foreground">이메일 </span>{email || '이메일 정보 없음'}</p><p><span className="text-muted-foreground">역할 </span>{role}</p></CardContent></Card>
    <Card><CardHeader><CardTitle><h2>비밀번호</h2></CardTitle><CardDescription>비밀번호를 변경하면 기존 세션은 종료되며 새 비밀번호로 다시 로그인해야 합니다.</CardDescription></CardHeader><CardContent><ActionLink href="/login?mode=forgot">비밀번호 재설정 시작</ActionLink></CardContent></Card>
    <Card><CardHeader><CardTitle><h2>GitHub 로그인</h2></CardTitle><CardDescription>{githubConnected ? 'GitHub 연결 상태와 연결 해제 절차는 GitHub 화면에서 관리합니다.' : 'GitHub 연결 여부를 확인하려면 GitHub 화면에서 현재 연결 상태를 확인하세요.'}</CardDescription></CardHeader><CardContent><ActionLink href="/github">GitHub 연결 관리</ActionLink></CardContent></Card>
    <Alert variant="notice"><AlertTitle>OAuth 전용 계정 안내</AlertTitle><AlertDescription>이 화면은 로그인 수단을 추측하지 않습니다. 비밀번호 재설정은 서버가 허용한 계정에서만 진행되며, GitHub 로그인은 인증 이메일 정책을 계속 따릅니다.</AlertDescription></Alert>
  </div>;
}

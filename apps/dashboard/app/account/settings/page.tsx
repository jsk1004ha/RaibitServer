import { ConsoleShell } from '../../../components/console-ui';
import { ThemeMenu } from '../../../components/theme-menu';
import { UserAvatar } from '../../../components/user-avatar';
import { ActionLink } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { dashboardApiContext, getJson } from '../../../lib/api';

export default async function AccountSettingsPage() {
  const context = await dashboardApiContext();
  const me = await getJson('/auth/me', { user: null, subject: null }, context);
  const user = me.ok ? me.body?.user : null;

  return <ConsoleShell active="account" eyebrow="계정" projectValue="계정 설정">
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-raibit-xl px-raibit-lg py-raibit-xl md:px-raibit-xl md:py-raibit-xxl">
      <header><p className="text-caption text-muted-foreground">ACCOUNT</p><h1 className="mt-raibit-sm text-2xl font-medium">계정 설정</h1><p className="mt-raibit-sm text-sm text-muted-foreground break-keep">내 프로필을 확인하고 화면 테마와 로그인 설정을 관리하세요.</p></header>
      <Card>
        <CardHeader><CardTitle><h2>프로필</h2></CardTitle><CardDescription>가입할 때 등록한 계정 정보입니다. 정보 수정은 <a className="underline" href="/support">지원 페이지</a>에서 문의하세요.</CardDescription></CardHeader>
        <CardContent className="flex min-w-0 items-center gap-raibit-lg">
          <UserAvatar avatarUrl={user?.avatarUrl} email={user?.email} name={user?.name} />
          <dl className="grid min-w-0 gap-raibit-sm text-sm"><div><dt className="text-muted-foreground">이름</dt><dd className="break-words">{user?.name || '이름 정보 없음'}</dd></div><div><dt className="text-muted-foreground">이메일</dt><dd className="break-all">{user?.email || '이메일 정보 없음'}</dd></div></dl>
        </CardContent>
      </Card>
      <Card><CardHeader><CardTitle><h2>화면 테마</h2></CardTitle><CardDescription>라이트, 다크 또는 기기 설정을 선택하세요. 이 브라우저에 저장됩니다.</CardDescription></CardHeader><CardContent className="flex items-center justify-between gap-raibit-lg"><span className="text-sm">화면 모드</span><ThemeMenu /></CardContent></Card>
      <Card><CardHeader><CardTitle><h2>로그인과 비밀번호</h2></CardTitle><CardDescription>비밀번호 재설정과 로그인 관련 안내를 확인하세요.</CardDescription></CardHeader><CardContent><ActionLink href="/account/security">계정 보안 열기</ActionLink></CardContent></Card>
      <Card><CardHeader><CardTitle><h2>작업 공간</h2></CardTitle><CardDescription>프로젝트와 팀원을 함께 관리하는 공간입니다.</CardDescription></CardHeader><CardContent><ActionLink href="/guide?topic=organizations">작업 공간 알아보기</ActionLink></CardContent></Card>
    </section>
  </ConsoleShell>;
}

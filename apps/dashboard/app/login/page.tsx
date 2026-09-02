import { GitBranch } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button, buttonVariants } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '../../components/ui/card';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { Brand } from '../../components/brand';
import { ThemeMenu } from '../../components/theme-menu';
import { apiAction } from '../../lib/api';

const modes = ['login', 'signup', 'verify'] as const;

type AuthMode = typeof modes[number];
type SearchParams = Record<string, string | string[] | undefined>;
type LoginPageProps = Readonly<{ searchParams: Promise<SearchParams> }>;

const authCopy: Record<AuthMode, Readonly<{ eyebrow: string; title: string; description: string }>> = {
  login: { eyebrow: 'RAIBIT ACCOUNT', title: '콘솔에 로그인', description: '프로젝트와 배포 현황을 계속 관리하세요.' },
  signup: { eyebrow: 'JOIN RAIBIT', title: '가입 신청', description: '관리자 확인을 위해 정확한 정보를 입력해 주세요.' },
  verify: { eyebrow: 'VERIFY EMAIL', title: '이메일 인증', description: '이메일로 받은 6자리 코드를 입력해 주세요.' },
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const requestedMode = queryValue(query.mode, 'login');
  const mode = isAuthMode(requestedMode) ? requestedMode : 'login';
  const email = queryValue(query.email, '');
  const next = queryValue(query.next, '/console');
  const error = errorMessage(queryValue(query.error, ''));
  const notice = noticeMessage(queryValue(query.notice, ''));
  const messageId = error || notice ? 'auth-message' : undefined;
  const publicHomeHref = process.env.NODE_ENV === 'production' ? 'https://raibit.kr/' : '/';
  const copy = authCopy[mode];

  return (
    <main id="main-content" className="grid min-h-dvh bg-background lg:grid-cols-2">
      <section className="hidden min-h-dvh flex-col justify-between bg-brand-surface px-10 py-10 text-brand-surface-foreground lg:flex">
        <a className="flex w-fit items-center gap-3 text-sm font-medium" href={publicHomeHref}>
          <Brand height={44} width={44} priority />
          <span>RAIBIT SERVER</span>
        </a>
        <div className="max-w-md">
          <p className="text-xs font-medium text-brand-surface-foreground/70">DEPLOYMENT PLATFORM</p>
          <p className="mt-4 text-3xl leading-tight font-medium text-balance break-keep [overflow-wrap:anywhere]">동아리의 프로젝트를 한곳에서 배포하고 운영하세요.</p>
        </div>
        <p className="text-sm text-brand-surface-foreground/70 break-keep [overflow-wrap:anywhere]">인천과학고 라이빗 호스팅 서비스</p>
      </section>

      <section className="flex min-h-dvh items-center justify-center px-4 py-8 sm:px-6 lg:px-12">
        <div className="w-full max-w-md">
          <a className="mb-8 flex w-fit items-center gap-3 text-sm font-medium lg:hidden" href={publicHomeHref}>
            <Brand height={40} width={40} priority />
            <span>RAIBIT SERVER</span>
          </a>
          <Card>
            <div data-slot="theme-utility" className="flex justify-end px-(--card-spacing)">
              <ThemeMenu />
            </div>
            <CardHeader>
              <p className="text-xs font-medium text-muted-foreground">{copy.eyebrow}</p>
              <h1 className="text-2xl tracking-tight">{copy.title}</h1>
              <CardDescription>{copy.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <nav aria-label="인증 메뉴" className="flex flex-wrap gap-4 border-b border-border pb-3 text-sm">
                {modes.map((item) => (
                  <a
                    aria-current={mode === item ? 'page' : undefined}
                    className={mode === item ? 'font-medium text-foreground underline decoration-primary decoration-2 underline-offset-12' : 'text-muted-foreground hover:text-foreground'}
                    href={authHref(item, next, email)}
                    key={item}
                  >
                    {authCopy[item].title}
                  </a>
                ))}
              </nav>

              {error ? <Alert className="auth-message border-destructive/40 bg-destructive/10 text-foreground [&_[data-slot=alert-description]]:text-foreground" id="auth-message" variant="destructive"><AlertTitle>확인해 주세요</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
              {notice ? <Alert className="auth-message" id="auth-message" role="status" variant="notice"><AlertTitle>안내</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}

              {mode === 'login' ? <form method="post" action={apiAction('/auth/login')} className="auth-form">
                <input name="_returnTo" type="hidden" value={next} />
                <FieldGroup>
                  <Field><FieldLabel htmlFor="login-email">이메일</FieldLabel><Input aria-describedby={messageId} autoComplete="email" defaultValue={email} id="login-email" name="email" required type="email" /></Field>
                  <Field><FieldLabel htmlFor="login-password">비밀번호</FieldLabel><Input aria-describedby={messageId} id="login-password" name="password" type="password" autoComplete="current-password" required /></Field>
                  <Button type="submit">콘솔에 로그인</Button>
                </FieldGroup>
                <div aria-hidden="true" className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>또는</span><span className="h-px flex-1 bg-border" /></div>
                <div className="flex flex-col gap-2">
                  <a className={buttonVariants({ variant: 'outline', className: 'w-full' })} href={apiAction('/auth/github/login')}><GitBranch aria-hidden="true" />GitHub로 로그인</a>
                  <p className="text-xs leading-relaxed text-muted-foreground break-keep">가입 승인된 계정과 GitHub의 인증 이메일이 같으면 프로필 사진도 함께 연결됩니다.</p>
                </div>
              </form> : null}

              {mode === 'signup' ? <form method="post" action={apiAction('/auth/signup')} className="auth-form">
                <input name="_returnTo" type="hidden" value="/login?mode=verify" />
                <FieldGroup>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field><FieldLabel htmlFor="signup-name">이름</FieldLabel><Input aria-describedby={messageId} autoComplete="name" id="signup-name" name="name" placeholder="홍길동" required /></Field>
                    <Field><FieldLabel htmlFor="signup-student-id">학번</FieldLabel><Input aria-describedby={messageId} id="signup-student-id" inputMode="numeric" name="studentId" placeholder="예: 2512" required /></Field>
                  </div>
                  <Field><FieldLabel htmlFor="signup-email">이메일</FieldLabel><Input aria-describedby={messageId} autoComplete="email" defaultValue={email} id="signup-email" name="email" required type="email" /></Field>
                  <Field><FieldLabel htmlFor="signup-password">비밀번호</FieldLabel><Input aria-describedby={messageId} id="signup-password" name="password" type="password" autoComplete="new-password" minLength={8} required /><FieldDescription>8자 이상으로 입력해 주세요.</FieldDescription></Field>
                  <FieldSet>
                    <FieldLegend variant="label">라이빗 동아리원인가요?</FieldLegend>
                    <FieldDescription id="club-member-description">신청 내용은 관리자 확인 후 계정 유형에 반영됩니다.</FieldDescription>
                    <FieldGroup className="gap-3">
                      <Field><FieldLabel className="min-h-11 w-full items-start" htmlFor="club-member-yes"><input aria-describedby="club-member-description" id="club-member-yes" name="clubMemberClaim" required type="radio" value="1" /><FieldContent><span>네, 동아리원입니다</span><FieldDescription>관리자가 확인 후 동아리원 계정으로 승인합니다.</FieldDescription></FieldContent></FieldLabel></Field>
                      <Field><FieldLabel className="min-h-11 w-full items-start" htmlFor="club-member-no"><input aria-describedby="club-member-description" id="club-member-no" name="clubMemberClaim" required type="radio" value="0" /><FieldContent><span>아니요</span><FieldDescription>일반 사용자로 가입을 신청합니다.</FieldDescription></FieldContent></FieldLabel></Field>
                    </FieldGroup>
                  </FieldSet>
                  <Button type="submit">인증 코드 받기</Button>
                </FieldGroup>
              </form> : null}

              {mode === 'verify' ? <>
                <form method="post" action={apiAction('/auth/email/verify')} className="auth-form">
                  <input name="_returnTo" type="hidden" value={next} />
                  <FieldGroup>
                    <Field><FieldLabel htmlFor="verify-email">이메일</FieldLabel><Input aria-describedby={messageId} autoComplete="email" defaultValue={email} id="verify-email" name="email" required type="email" /></Field>
                    <Field><FieldLabel htmlFor="verify-code">6자리 인증 코드</FieldLabel><Input aria-describedby={messageId} id="verify-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></Field>
                    <Button type="submit">인증하고 계속하기</Button>
                  </FieldGroup>
                </form>
                <form method="post" action={apiAction('/auth/email/resend')} className="auth-resend">
                  <input name="_returnTo" type="hidden" value={`/login?mode=verify&email=${encodeURIComponent(email)}`} />
                  <input name="email" type="hidden" value={email} />
                  <Button type="submit" variant="outline">인증 코드 다시 보내기</Button>
                </form>
              </> : null}

              <footer className="flex flex-col gap-3 border-t border-border pt-5 text-sm text-muted-foreground">
                {mode === 'login' ? <p>계정이 없으신가요? <a className="font-medium text-foreground underline underline-offset-4" href={authHref('signup', next, email)}>가입 신청</a></p> : <p>이미 계정이 있으신가요? <a className="font-medium text-foreground underline underline-offset-4" href={authHref('login', next, email)}>로그인</a></p>}
                <a className="w-fit hover:text-foreground" href={publicHomeHref}>메인으로 돌아가기</a>
              </footer>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}

function isAuthMode(value: string): value is AuthMode {
  return value === 'login' || value === 'signup' || value === 'verify';
}

function queryValue(value: string | string[] | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function authHref(mode: AuthMode, next: string, email: string): string {
  const params = new URLSearchParams({ mode, next });
  if (email) params.set('email', email);
  return `/login?${params.toString()}`;
}

function errorMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    invalid_credentials: '이메일 또는 비밀번호를 확인해 주세요.',
    email_not_verified: '먼저 이메일 인증을 완료해 주세요.',
    session_expired: '세션이 만료되었습니다. 다시 로그인해 주세요.',
    github_account_not_registered: 'GitHub 인증 이메일과 일치하는 승인 계정을 찾지 못했습니다.',
    github_oauth_denied: 'GitHub 로그인이 취소되었습니다.',
    github_oauth_not_configured: 'GitHub 로그인이 아직 설정되지 않았습니다.',
    github_oauth_state_invalid: 'GitHub 로그인 요청이 만료되었습니다. 다시 시도해 주세요.',
    github_verified_email_required: 'GitHub에서 인증된 이메일을 확인할 수 없습니다.',
    invalid_or_expired_email_verification_code: '인증 코드가 올바르지 않거나 만료되었습니다.',
    request_failed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  };
  return messages[code] || (code ? '요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.' : '');
}

function noticeMessage(code: string): string {
  return code === 'saved' ? '요청이 처리되었습니다.' : code ? '요청 결과를 확인해 주세요.' : '';
}

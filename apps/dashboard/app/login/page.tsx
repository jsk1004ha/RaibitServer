import { Brand } from '../../components/brand';
import { apiAction } from '../../lib/api';

const modes = ['login', 'signup', 'verify'] as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedMode = String(query.mode || 'login');
  const mode = modes.includes(requestedMode as any) ? requestedMode : 'login';
  const email = String(query.email || '');
  const next = String(query.next || '/console');
  const error = errorMessage(String(query.error || ''));
  const notice = String(query.notice || '');
  const publicHomeHref = process.env.NODE_ENV === 'production' ? 'https://raibit.kr/' : '/';
  return (
    <main id="main-content" className="auth-page" data-od-id="landing-auth">
      <a className="auth-brand" href={publicHomeHref}><Brand height={42} width={42} priority /><span>RAIBIT SERVER</span></a>
      <section className="auth-panel">
        <header>
          <p className="eyebrow">RAIBIT ACCOUNT</p>
          <h1>{mode === 'signup' ? '가입 신청' : mode === 'verify' ? '이메일 인증' : '로그인'}</h1>
          <p>{mode === 'signup' ? '라이빗 서버 사용을 신청합니다. 관리자 확인을 위해 정확한 정보를 입력해 주세요.' : mode === 'verify' ? '이메일로 받은 6자리 코드를 입력해 주세요.' : '콘솔에 계속하려면 계정으로 로그인하세요.'}</p>
        </header>
        {error ? <p className="auth-message error" role="alert">{error}</p> : null}
        {notice ? <p className="auth-message" role="status">{notice}</p> : null}

        {mode === 'login' ? <form method="post" action={apiAction('/auth/login')} className="auth-form">
          <input name="_returnTo" type="hidden" value={next} />
          <label>이메일<input name="email" type="email" autoComplete="email" defaultValue={email} required /></label>
          <label>비밀번호<input name="password" type="password" autoComplete="current-password" required /></label>
          <button type="submit">콘솔에 로그인</button>
        </form> : null}

        {mode === 'signup' ? <form method="post" action={apiAction('/auth/signup')} className="auth-form">
          <input name="_returnTo" type="hidden" value="/login?mode=verify" />
          <div className="form-grid">
            <label>이름<input name="name" autoComplete="name" placeholder="홍길동" required /></label>
            <label>학번<input name="studentId" inputMode="numeric" placeholder="예: 2512" required /></label>
          </div>
          <label>이메일<input name="email" type="email" autoComplete="email" defaultValue={email} required /></label>
          <label>비밀번호<input name="password" type="password" autoComplete="new-password" minLength={8} required /></label>
          <fieldset className="auth-choice-group">
            <legend>라이빗 동아리원인가요?</legend>
            <div>
              <label><input name="clubMemberClaim" type="radio" value="1" required /><span><strong>네, 동아리원입니다</strong><small>관리자가 확인 후 동아리원 계정으로 승인합니다.</small></span></label>
              <label><input name="clubMemberClaim" type="radio" value="0" required /><span><strong>아니요</strong><small>일반 사용자로 가입을 신청합니다.</small></span></label>
            </div>
          </fieldset>
          <button type="submit">인증 코드 받기</button>
        </form> : null}

        {mode === 'verify' ? <>
          <form method="post" action={apiAction('/auth/email/verify')} className="auth-form">
            <input name="_returnTo" type="hidden" value={next} />
            <label>이메일<input name="email" type="email" autoComplete="email" defaultValue={email} required /></label>
            <label>6자리 인증 코드<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
            <button type="submit">인증하고 계속하기</button>
          </form>
          <form method="post" action={apiAction('/auth/email/resend')} className="auth-resend">
            <input name="_returnTo" type="hidden" value={`/login?mode=verify&email=${encodeURIComponent(email)}`} /><input name="email" type="hidden" value={email} />
            <button className="btn btn-ghost" type="submit">인증 코드 다시 보내기</button>
          </form>
        </> : null}

        <footer>
          {mode === 'login' ? <p>계정이 없나요? <a href={`/login?mode=signup&next=${encodeURIComponent(next)}`}>가입 신청</a></p> : <p>이미 계정이 있나요? <a href={`/login?next=${encodeURIComponent(next)}`}>로그인</a></p>}
          <a href={publicHomeHref}>메인으로 돌아가기</a>
        </footer>
      </section>
    </main>
  );
}

function errorMessage(code: string) {
  const messages: Record<string, string> = {
    invalid_credentials: '이메일 또는 비밀번호를 확인해 주세요.',
    email_not_verified: '먼저 이메일 인증을 완료해 주세요.',
    session_expired: '세션이 만료되었습니다. 다시 로그인해 주세요.',
    user_already_exists: '이미 가입된 이메일입니다.',
    organization_slug_already_exists: '이미 사용 중인 조직 이름입니다.',
    invalid_or_expired_email_verification_code: '인증 코드가 올바르지 않거나 만료되었습니다.',
    request_failed: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  };
  return messages[code] || (code ? '요청을 처리하지 못했습니다. 입력 내용을 확인해 주세요.' : '');
}

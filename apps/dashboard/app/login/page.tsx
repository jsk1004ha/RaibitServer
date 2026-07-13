import { apiAction } from '../../lib/api';
import { ConsoleShell } from '../../components/console-ui';

export default function LoginPage() {
  const githubLoginEndpoint = apiAction('/auth/github/login');
  const githubCallbackEndpoint = apiAction('/auth/github/callback');
  return (
    <ConsoleShell active="auth" eyebrow="계정" orgValue="RAIBITSERVER" projectValue="인증과 승인" crumbs="계정 / 로그인" actions={<><button className="btn btn-primary" type="button" disabled aria-describedby="github-oauth-status">GitHub로 계속하기</button><a className="btn" href="/">운영 현황</a></>}>
      <section className="page" data-od-id="landing-auth">
        <header className="page-header">
          <div><p className="eyebrow">RAIBITSERVER 계정</p><h1 className="page-title">로그인</h1><p className="page-subtitle">이메일 또는 GitHub 계정으로 로그인하고 가입 인증 상태를 관리합니다.</p></div>
          <span className="badge info">보안 인증</span>
        </header>
        <div className="callout"><strong>이메일 인증과 승인</strong><p className="muted">인증 코드를 확인한 뒤에만 계정이 만들어집니다. 이후 관리자 승인 결과가 계정의 사용 가능 기능을 결정합니다.</p></div>
        <p className="callout muted" id="github-oauth-status" style={{ marginTop: 12 }}>GitHub OAuth 연결은 준비 중입니다. 현재 API는 OAuth 계획과 연결 대기 상태만 제공합니다. <span className="mono">GET {githubLoginEndpoint}</span></p>
        <section className="grid grid-2 grid-start" aria-label="계정 인증" style={{ marginTop: 16 }}>
          <form method="post" action={apiAction('/auth/login')} className="card">
            <div className="card-title"><h2>로그인</h2><span className="badge info">인증</span></div>
            <label>이메일 <input name="email" type="email" autoComplete="email" required /></label>
            <label>비밀번호 <input name="password" type="password" autoComplete="current-password" required /></label>
            <button type="submit">로그인</button>
            <p className="muted mono">POST /auth/login</p>
          </form>
          <form method="post" action={apiAction('/auth/signup')} className="card">
            <div className="card-title"><h2>가입 신청</h2><span className="badge warn">승인 대기</span></div>
            <label>이메일 <input name="email" type="email" autoComplete="email" required /></label>
            <label>비밀번호 <input name="password" type="password" autoComplete="new-password" required /></label>
            <label>조직 슬러그 <input name="organizationSlug" placeholder="club-dev" /></label>
            <button type="submit">인증 코드 받기</button>
            <p className="muted mono">POST /auth/signup</p>
          </form>
          <form method="post" action={apiAction('/auth/email/verify')} className="card">
            <div className="card-title"><h2>이메일 인증</h2><span className="badge ok">확인</span></div>
            <label>이메일 <input name="email" type="email" autoComplete="email" required /></label>
            <label>6자리 인증 코드 <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
            <button type="submit">코드 확인</button>
            <p className="muted mono">POST /auth/email/verify</p>
          </form>
          <form method="post" action={apiAction('/auth/email/resend')} className="card">
            <div className="card-title"><h2>인증 코드 다시 보내기</h2><span className="badge info">이메일</span></div>
            <label>이메일 <input name="email" type="email" autoComplete="email" required /></label>
            <button type="submit">인증 코드 다시 보내기</button>
            <p className="muted mono">POST /auth/email/resend</p>
          </form>
          <section className="card">
            <div className="card-title"><h2>GitHub 연결</h2><span className="badge ok">OAuth</span></div>
            <p className="muted">현재 API는 OAuth 계획과 연결 대기 상태만 제공합니다.</p>
            <fieldset disabled>
              <input name="localDev" type="hidden" value="1" />
              <label>이메일 <input name="email" type="email" autoComplete="email" /></label>
              <label>GitHub ID <input name="githubId" placeholder="123456" /></label>
              <label>GitHub 로그인 <input name="login" placeholder="club-member" /></label>
              <label>조직 슬러그 <input name="organizationSlug" placeholder="github-user-org" /></label>
              <button type="button" disabled>GitHub 연결</button>
            </fieldset>
            <p className="muted mono">GET {githubCallbackEndpoint}</p>
          </section>
        </section>
      </section>
    </ConsoleShell>
  );
}

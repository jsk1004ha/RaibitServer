import { Brand } from '../../components/brand';
import { PublicFooter } from '../../components/public-footer';

const privacyEmail = 'ishsraibit@gmail.com';

export const metadata = {
  title: '개인정보처리방침 — RAIBIT SERVER',
  description: 'RAIBIT SERVER 개인정보처리방침',
};

export default function PrivacyPage() {
  return (
    <main id="main-content" className="privacy-page">
      <nav className="landing-nav" aria-label="개인정보처리방침 화면 탐색">
        <a className="landing-brand" href="/">
          <Brand height={36} width={36} priority />
          <span>RAIBIT SERVER</span>
        </a>
        <a className="btn" href="/">메인으로 돌아가기</a>
      </nav>

      <header className="privacy-hero">
        <p className="eyebrow">RAIBIT PRIVACY</p>
        <h1>개인정보처리방침</h1>
        <p>RAIBIT SERVER는 서비스 운영에 필요한 최소한의 개인정보를 처리하고 안전하게 보호합니다.</p>
        <span>시행일 2026. 08. 25.</span>
      </header>

      <section className="privacy-document" aria-label="개인정보처리방침 본문">
        <article className="privacy-section">
          <span>01</span><div><h2>개인정보의 처리 목적</h2><p>회원 식별과 이메일 인증, 가입 신청 확인 및 관리자 승인, 콘솔 로그인, 프로젝트·배포·리소스 운영, 보안 사고 예방과 서비스 문의 처리를 위해 개인정보를 처리합니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>02</span><div><h2>처리하는 개인정보 항목</h2>
            <div className="privacy-table" role="table" aria-label="처리하는 개인정보 항목">
              <div role="row"><strong role="columnheader">구분</strong><strong role="columnheader">처리 항목</strong></div>
              <div role="row"><span role="cell">가입·계정</span><p role="cell">이름, 학번, 라이빗 동아리원 여부, 이메일, 비밀번호 해시, 이메일 인증 시각, 역할 및 승인 상태</p></div>
              <div role="row"><span role="cell">GitHub 연동</span><p role="cell">GitHub 식별자, 로그인명, 프로필 이미지, 연결한 저장소 정보</p></div>
              <div role="row"><span role="cell">서비스 이용</span><p role="cell">조직·프로젝트·서비스 정보, 배포 및 리소스 작업 기록, 보안·감사 로그</p></div>
              <div role="row"><span role="cell">세션</span><p role="cell">로그인 상태 유지를 위한 HttpOnly 세션 쿠키</p></div>
            </div>
            <p>가입 신청, 콘솔 이용 및 사용자가 선택한 GitHub 연동 과정에서 위 정보가 수집됩니다. 비밀번호 원문은 저장하지 않습니다.</p>
          </div>
        </article>

        <article className="privacy-section">
          <span>03</span><div><h2>처리 및 보유 기간</h2><p>계정과 서비스 운영 정보는 회원 탈퇴 요청 처리 또는 서비스 종료 시까지 보유합니다. 이메일 인증 코드는 인증 완료 또는 유효기간 만료 시 더 이상 사용할 수 없으며, 세션 쿠키는 로그인 후 최대 12시간 유지됩니다. 보안·감사 기록은 서비스 보호와 사고 대응에 필요한 기간 동안 보유한 뒤 목적이 달성되면 파기합니다. 관계 법령에 따라 보존이 필요한 경우에는 해당 기간 동안 분리하여 보관합니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>04</span><div><h2>제3자 제공 및 처리위탁</h2><p>RAIBIT SERVER는 원칙적으로 개인정보를 제3자에게 제공하지 않습니다. 사용자가 GitHub 연동을 직접 선택한 경우 해당 기능 수행에 필요한 요청이 GitHub로 전송될 수 있으며, GitHub의 개인정보 처리 기준이 적용됩니다. 별도의 개인정보 처리위탁이 발생하면 수탁자와 업무 내용을 이 방침을 통해 공개합니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>05</span><div><h2>개인정보의 파기</h2><p>처리 목적이 달성되거나 보유기간이 끝난 개인정보는 지체 없이 파기합니다. 전자적 파일은 복구할 수 없도록 삭제하고, 출력물이 존재하는 경우 분쇄하거나 소각합니다. 법령에 따라 보존해야 하는 정보는 다른 정보와 분리하여 보관합니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>06</span><div><h2>정보주체의 권리와 행사 방법</h2><p>이용자는 자신의 개인정보에 대해 열람, 정정, 삭제, 처리정지 및 회원 탈퇴를 요청할 수 있습니다. 본인 확인이 필요한 요청은 아래 개인정보 문의처로 접수해 주세요. 법령에서 정한 사유가 있는 경우 일부 요청이 제한될 수 있으며 그 사유를 안내합니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>07</span><div><h2>쿠키의 이용</h2><p>로그인 상태 유지를 위해 <code>raibitserver_session</code> 쿠키를 사용합니다. 이 쿠키는 JavaScript에서 읽을 수 없는 HttpOnly 방식이며, HTTPS 환경에서는 Secure 속성을 사용하고 SameSite=Lax와 host-only 범위로 설정됩니다. 로그아웃하면 즉시 삭제되며 브라우저 설정에서도 쿠키를 삭제할 수 있습니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>08</span><div><h2>안전성 확보 조치</h2><p>비밀번호의 단방향 해시 저장, HttpOnly 세션, 관리자 권한 분리, 역할 기반 접근 통제, 중요 정보 마스킹, 감사 기록, 비밀정보 암호화 및 안전한 컨테이너 기본값을 적용합니다.</p></div>
        </article>

        <article className="privacy-section privacy-contact">
          <span>09</span><div><h2>개인정보 문의처</h2><p>개인정보 보호 및 관련 고충 처리는 RAIBIT SERVER 운영진이 담당합니다.</p><a href={`mailto:${privacyEmail}?subject=${encodeURIComponent('[RAIBIT SERVER 개인정보 문의]')}`}>{privacyEmail}로 문의하기</a><p>개인정보 침해에 관한 추가 도움은 <a href="https://www.privacy.go.kr" target="_blank" rel="noreferrer">개인정보 포털</a>에서 받을 수 있습니다.</p></div>
        </article>

        <article className="privacy-section">
          <span>10</span><div><h2>처리방침의 변경</h2><p>이 방침이 변경되는 경우 시행 전에 서비스 화면을 통해 안내합니다. 이전 방침과 변경 이력은 필요 시 이용자가 확인할 수 있도록 제공합니다.</p></div>
        </article>
      </section>

      <PublicFooter />
    </main>
  );
}

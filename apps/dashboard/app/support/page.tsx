import { Brand } from '../../components/brand';
import { PublicFooter } from '../../components/public-footer';

const supportEmail = 'ishsraibit@gmail.com';
const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent('[RAIBIT SERVER 문의]')}`;

export const metadata = {
  title: 'Support — RAIBIT SERVER',
  description: 'RAIBIT SERVER 문의 및 지원 안내',
};

export default function SupportPage() {
  return (
    <main className="support-page">
      <nav className="landing-nav" aria-label="지원 화면 탐색">
        <a className="landing-brand" href="/">
          <Brand height={36} width={36} priority />
          <span>RAIBIT SERVER</span>
        </a>
        <a className="btn" href="/">메인으로 돌아가기</a>
      </nav>

      <section className="support-content" aria-labelledby="support-title">
        <div className="support-copy">
          <p className="eyebrow">RAIBIT SUPPORT</p>
          <h1 id="support-title">도움이 필요하신가요?</h1>
          <p>계정 · 승인 · 배포 문의</p>
        </div>

        <article className="support-card">
          <div>
            <p className="eyebrow">EMAIL SUPPORT</p>
            <h2>{supportEmail}</h2>
            <p>프로젝트와 문제를 적어 주세요.</p>
          </div>
          <a className="btn btn-primary" href={mailto}>메일 보내기</a>
        </article>

        <p className="support-github">버그나 기능 제안은 <a href="https://github.com/jsk1004ha/RaibitServer/issues" target="_blank" rel="noreferrer">GitHub Issues ↗</a>에서도 남길 수 있습니다.</p>
      </section>

      <PublicFooter />
    </main>
  );
}

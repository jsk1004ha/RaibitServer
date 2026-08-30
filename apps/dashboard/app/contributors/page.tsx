import { Brand } from '../../components/brand';
import { PublicFooter } from '../../components/public-footer';

export const metadata = {
  title: '기여자 — RAIBIT SERVER',
  description: 'RAIBIT SERVER 개발 기여자',
};

export default function ContributorsPage() {
  return (
    <main className="contributors-page">
      <nav className="landing-nav" aria-label="기여자 화면 탐색">
        <a className="landing-brand" href="/">
          <Brand height={36} width={36} priority />
          <span>RAIBIT SERVER</span>
        </a>
        <a className="btn" href="/">메인으로 돌아가기</a>
      </nav>

      <section className="contributors-hero" aria-labelledby="contributors-title">
        <p className="eyebrow">BUILT BY RAIBIT</p>
        <h1 id="contributors-title">기여자</h1>
        <p>RAIBIT SERVER를 만들고 운영하는 사람들입니다.</p>
      </section>

      <section className="contributor-list" aria-label="RAIBIT SERVER 기여자 목록">
        <article className="contributor-card contributor-card-featured">
          <span className="contributor-sparkles" aria-hidden="true"><i>✦</i><i>✧</i><i>✦</i></span>
          <span className="contributor-number contributor-role">teacher</span>
          <div>
            <p className="eyebrow">INFRASTRUCTURE SUPPORT</p>
            <h2>최희진 <span className="contributor-crown" aria-hidden="true">👑</span></h2>
            <p>서버컴퓨터와 도메인 구매</p>
          </div>
          <Brand height={82} width={82} />
        </article>
        <article className="contributor-card">
          <div>
            <p className="eyebrow">DEVELOPMENT</p>
            <h2><span className="contributor-inline-id">2309</span> 김준서</h2>
            <p>RAIBIT SERVER 개발</p>
          </div>
          <Brand height={82} width={82} />
        </article>
      </section>

      <PublicFooter />
    </main>
  );
}

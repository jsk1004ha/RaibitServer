import Image from 'next/image';
import { PublicFooter } from '../components/public-footer';
import { loadPublicSites } from '../lib/api';

const landingVariants = ['center', 'spotlight', 'editorial'] as const;

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const requestedVariant = String(query.variant || 'editorial');
  const variant = landingVariants.includes(requestedVariant as any) ? requestedVariant : 'editorial';
  const consoleUrl = process.env.RAIBITSERVER_CONSOLE_URL || '/console';
  const sites = await loadPublicSites(5);

  return (
    <main className={`landing-page landing-variant-${variant}`}>
      <nav className="landing-nav" aria-label="메인 탐색">
        <a className="landing-brand" href="/"><Image src="/raibit-logo.jpg" alt="라이빗 로고" width={36} height={36} priority /><span>RAIBIT SERVER</span></a>
        <div className="landing-nav-actions"><a className="btn btn-ghost" href="/status">운영 현황</a><a className="btn btn-ghost" href="/login">로그인</a><a className="btn btn-primary" href={consoleUrl}>콘솔 들어가기</a></div>
      </nav>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <p className="eyebrow">RAIBIT HOSTING SERVICE</p>
          <h1 id="landing-title">만들고,<br />올리고,<br />운영하세요.</h1>
          <p>인천과학고등학교의 최고 정보 동아리 라이빗의 호스팅 서비스입니다.</p>
          <div className="landing-actions"><a className="btn btn-primary" href={consoleUrl}>콘솔 시작하기</a><a className="btn" href="/login?mode=signup">가입 신청</a></div>
        </div>
        <div className="landing-logo-wrap" aria-hidden="true"><Image src="/raibit-logo.jpg" alt="" width={340} height={340} priority /></div>
      </section>

      <section className="public-sites landing-public-sites" aria-labelledby="landing-sites-title">
        <header><div><p className="eyebrow">LIVE ON RAIBIT</p><h2 id="landing-sites-title">운영 중인 사이트</h2></div><a href="/status">전체 보기 →</a></header>
        <div className="public-site-list">
          {sites.length ? sites.map((site: any) => <a className="public-site" href={site.url} key={site.id || site.name} target="_blank" rel="noreferrer"><span><strong>{site.name}</strong><small>{site.owner}</small></span><span className="public-site-status"><i />LIVE</span><span aria-hidden="true">↗</span></a>) : <div className="public-sites-empty"><strong>운영 사이트 준비 중</strong><p>공개되면 표시됩니다.</p></div>}
        </div>
      </section>

      <PublicFooter />
    </main>
  );
}

import Image from 'next/image';
import { PublicFooter } from '../../components/public-footer';
import { loadPublicSites } from '../../lib/api';

export default async function StatusPage() {
  const sites = await loadPublicSites(5);
  return (
    <main className="landing-page status-page">
      <nav className="landing-nav" aria-label="메인 탐색">
        <a className="landing-brand" href="/"><Image src="/raibit-logo.jpg" alt="라이빗 로고" width={36} height={36} priority /><span>RAIBIT SERVER</span></a>
        <div className="landing-nav-actions"><a className="btn" href="/">메인으로</a><a className="btn btn-primary" href="/console">콘솔 들어가기</a></div>
      </nav>
      <section className="status-hero">
        <p className="eyebrow">LIVE ON RAIBIT</p>
        <h1>운영 중인 사이트</h1>
        <p>현재 RAIBIT SERVER에서 공개된 최신 사이트 5개를 확인합니다.</p>
      </section>
      <section className="public-sites status-sites" aria-labelledby="public-sites-title">
        <header><div><p className="eyebrow">CURRENT STATUS</p><h2 id="public-sites-title">라이브 서비스</h2></div><span>최대 5개</span></header>
        <div className="public-site-list">
          {sites.length ? sites.map((site: any, index: number) => (
            <a className="public-site" href={site.url} key={site.id || site.name} target="_blank" rel="noreferrer">
              <span className="public-site-index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{site.name}</strong><small>{site.owner}</small></span>
              <span className="public-site-status"><i />LIVE</span>
              <span aria-hidden="true">↗</span>
            </a>
          )) : <div className="public-sites-empty"><strong>운영 사이트를 준비하고 있습니다.</strong><p>공개된 프로젝트가 생기면 이곳에 최신 5개가 표시됩니다.</p></div>}
        </div>
      </section>
      <PublicFooter />
    </main>
  );
}

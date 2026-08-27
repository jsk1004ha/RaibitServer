import Image from 'next/image';
import { PublicFooter } from '../../components/public-footer';
import { SystemStatusPanel } from '../../components/system-status-panel';
import { loadSystemStatus } from '../../lib/system-status';

export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  const status = await loadSystemStatus();
  return (
    <main className="landing-page status-page">
      <nav className="landing-nav" aria-label="메인 탐색">
        <a className="landing-brand" href="/"><Image src="/raibit-logo.jpg" alt="라이빗 로고" width={36} height={36} priority /><span>RAIBIT SERVER</span></a>
        <div className="landing-nav-actions"><a className="btn btn-ghost" href="/">메인</a><a className="btn btn-primary" href="/console">콘솔</a></div>
      </nav>
      <section className="status-hero">
        <p className="eyebrow">SYSTEM STATUS</p>
        <h1>RAIBIT SERVER 상태</h1>
        <p>실시간 운영 현황</p>
      </section>
      <SystemStatusPanel initialStatus={status} />
      <PublicFooter />
    </main>
  );
}

import { PublicFooter } from "../../components/public-footer";
import { PublicHeader } from "../../components/public-header";
import { SystemStatusPanel } from "../../components/system-status-panel";
import { buttonVariants } from "../../components/ui/button";
import { loadSystemStatus } from "../../lib/system-status";

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const status = await loadSystemStatus();
  return (
    <>
      <PublicHeader
        currentPath="/status"
        actions={
          <a className={buttonVariants({ size: "lg" })} href="/console">
            콘솔
          </a>
        }
      />
      <main id="main-content">
        <section className="mx-auto w-full max-w-7xl px-raibit-lg pb-raibit-xxl pt-raibit-huge sm:px-raibit-xl sm:pt-24">
          <p className="text-micro font-medium tracking-[0.16em] text-primary">
            SYSTEM STATUS
          </p>
          <div className="mt-raibit-lg grid gap-raibit-lg border-b border-border pb-raibit-xxl lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
            <h1 className="break-keep [overflow-wrap:anywhere] max-w-[13ch] text-display-xl font-medium text-balance text-foreground sm:text-display-xxl">
              RAIBIT SERVER 상태
            </h1>
            <p className="break-keep [overflow-wrap:anywhere] text-body-lg text-pretty text-muted-foreground">
              서비스와 데이터 계층의 실시간 운영 현황을 확인합니다.
            </p>
          </div>
        </section>
        <SystemStatusPanel initialStatus={status} />
      </main>
      <PublicFooter />
    </>
  );
}

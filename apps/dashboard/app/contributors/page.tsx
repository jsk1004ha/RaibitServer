import { PublicFooter } from "../../components/public-footer";
import { PublicHeader } from "../../components/public-header";
import { Brand } from "../../components/brand";

const contributors = [
  {
    id: "teacher",
    name: "최희진",
    area: "INFRASTRUCTURE SUPPORT",
    contribution: "서버컴퓨터와 도메인 구매",
  },
  {
    id: "2309",
    name: "김준서",
    area: "DEVELOPMENT",
    contribution: "RAIBIT SERVER 개발",
  },
  {
    id: "2414",
    name: "엄지오",
    area: "DEVELOPMENT",
    contribution: "RAIBIT SERVER 프론트엔드 개발",
  },
] as const;

export const metadata = {
  title: "기여자 — RAIBIT SERVER",
  description: "RAIBIT SERVER 개발 기여자",
};

export default function ContributorsPage() {
  return (
    <>
      <PublicHeader />
      <main id="main-content">
        <section className="mx-auto w-full max-w-7xl px-raibit-lg py-raibit-huge sm:px-raibit-xl sm:py-24">
          <header className="grid gap-raibit-lg border-b border-border pb-raibit-xxl lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-end">
            <div>
              <p className="text-micro font-medium tracking-[0.16em] text-primary">
                BUILT BY RAIBIT
              </p>
              <h1 className="mt-raibit-lg text-display-xl font-medium text-foreground sm:text-display-xxl">
                기여자
              </h1>
            </div>
            <p className="text-body-lg text-pretty text-muted-foreground">
              RAIBIT SERVER를 만들고 운영하는 사람들입니다.
            </p>
          </header>
          <div aria-label="RAIBIT SERVER 기여자 목록">
            {contributors.map((contributor, index) => (
              <article
                className="grid min-h-44 grid-cols-[3rem_minmax(0,1fr)] gap-raibit-lg border-b border-border py-raibit-xxl sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center"
                key={contributor.id}
              >
                <span className="font-mono text-caption text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <p className="text-micro font-medium tracking-[0.12em] text-primary">
                    {contributor.area}
                  </p>
                  <h2 className="mt-raibit-sm text-display-md font-medium text-foreground">
                    <span className="mr-raibit-md font-mono text-caption text-muted-foreground">
                      {contributor.id}
                    </span>
                    {contributor.name}
                  </h2>
                  <p className="mt-raibit-md text-body-md text-muted-foreground">
                    {contributor.contribution}
                  </p>
                </div>
                <Brand height={64} width={64} />
              </article>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}

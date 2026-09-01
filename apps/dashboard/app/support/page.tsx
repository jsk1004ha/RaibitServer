import { ArrowUpRightIcon, BugIcon, MailIcon } from "lucide-react";
import { PublicFooter } from "../../components/public-footer";
import { PublicHeader } from "../../components/public-header";
import { buttonVariants } from "../../components/ui/button";

const supportEmail = "ishsraibit@gmail.com";
const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent("[RAIBIT SERVER 문의]")}`;

export const metadata = {
  title: "Support — RAIBIT SERVER",
  description: "RAIBIT SERVER 문의 및 지원 안내",
};

export default function SupportPage() {
  return (
    <>
      <PublicHeader currentPath="/support" />
      <main id="main-content">
        <section className="mx-auto w-full max-w-7xl px-raibit-lg py-raibit-huge sm:px-raibit-xl sm:py-24">
          <div className="grid gap-raibit-huge lg:grid-cols-[minmax(0,.8fr)_minmax(28rem,1.2fr)]">
            <header className="flex flex-col items-start gap-raibit-lg">
              <p className="text-micro font-medium tracking-[0.16em] text-primary">
                RAIBIT SUPPORT
              </p>
              <h1 className="max-w-[10ch] text-display-xl font-medium text-balance text-foreground sm:text-display-xxl">
                도움이 필요하신가요?
              </h1>
              <p className="max-w-md text-body-lg text-pretty text-muted-foreground">
                계정 · 승인 · 배포 문의를 운영진에게 보내 주세요.
              </p>
            </header>
            <div className="border-t border-border">
              <article className="grid gap-raibit-xl border-b border-border py-raibit-xxl sm:grid-cols-[auto_minmax(0,1fr)]">
                <MailIcon className="size-6 text-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-micro font-medium tracking-[0.12em] text-muted-foreground">
                    EMAIL SUPPORT
                  </p>
                  <h2 className="mt-raibit-sm break-all text-heading-lg font-medium text-foreground">
                    {supportEmail}
                  </h2>
                  <p className="mt-raibit-md text-body-md text-muted-foreground">
                    프로젝트 이름과 문제가 발생한 화면, 재현 방법을 함께 적어
                    주세요.
                  </p>
                  <a
                    className={buttonVariants({
                      className: "mt-raibit-xl",
                      size: "lg",
                    })}
                    href={mailto}
                  >
                    메일 보내기
                  </a>
                </div>
              </article>
              <article className="grid gap-raibit-xl border-b border-border py-raibit-xxl sm:grid-cols-[auto_minmax(0,1fr)]">
                <BugIcon className="size-6 text-primary" aria-hidden="true" />
                <div>
                  <p className="text-micro font-medium tracking-[0.12em] text-muted-foreground">
                    ISSUE TRACKER
                  </p>
                  <h2 className="mt-raibit-sm text-heading-lg font-medium text-foreground">
                    버그와 기능 제안
                  </h2>
                  <p className="mt-raibit-md text-body-md text-muted-foreground">
                    공개적으로 공유해도 되는 문제는 GitHub Issues에 남길 수
                    있습니다.
                  </p>
                  <a
                    className="mt-raibit-lg inline-flex min-h-11 items-center gap-raibit-xs text-button-md font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                    href="https://github.com/jsk1004ha/RaibitServer/issues"
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub Issues{" "}
                    <ArrowUpRightIcon className="size-4" aria-hidden="true" />
                  </a>
                </div>
              </article>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}

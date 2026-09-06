import {
  ArrowUpRightIcon,
  BoxIcon,
  DatabaseIcon,
  GitBranchIcon,
} from "lucide-react";
import { PublicFooter } from "../components/public-footer";
import { PublicHeader } from "../components/public-header";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { loadPublicSites } from "../lib/api";
import {
  configuredConsoleHref,
  consoleOriginHref,
} from "../lib/request-security.js";

type PublicSite = Readonly<{
  id?: string;
  name: string;
  owner?: string;
  url: string;
}>;

export default async function HomePage() {
  const consoleUrl = configuredConsoleHref(
    process.env.RAIBITSERVER_CONSOLE_URL,
  );
  const loginUrl = consoleOriginHref(
    process.env.RAIBITSERVER_CONSOLE_URL,
    "/login",
  );
  const signupUrl = consoleOriginHref(
    process.env.RAIBITSERVER_CONSOLE_URL,
    "/login?mode=signup",
  );
  const result: unknown = await loadPublicSites(5);
  const sites = Array.isArray(result) ? result.filter(isPublicSite) : [];

  return (
    <>
      <PublicHeader
        actions={
          <div className="flex items-center gap-raibit-sm">
            <a
              className={buttonVariants({ variant: "ghost", size: "lg" })}
              href={loginUrl}
            >
              로그인
            </a>
            <a className={buttonVariants({ size: "lg" })} href={consoleUrl}>
              콘솔 들어가기
            </a>
          </div>
        }
      />
      <main id="main-content">
        <section className="mx-auto grid w-full max-w-7xl gap-raibit-huge px-raibit-lg py-raibit-huge sm:px-raibit-xl lg:grid-cols-[minmax(0,1.05fr)_minmax(24rem,.95fr)] lg:items-center lg:py-24">
          <div className="flex min-w-0 flex-col items-start gap-raibit-xl">
            <p className="text-micro font-medium tracking-[0.16em] text-primary">
              RAIBIT HOSTING SERVICE
            </p>
            <h1 className="max-w-[15ch] break-keep text-display-xl font-medium text-balance text-foreground sm:text-display-xxl">
              만들고, 올리고, 운영하세요.
            </h1>
            <p className="max-w-2xl text-body-lg text-pretty break-keep [overflow-wrap:anywhere] text-muted-foreground">
              인천과학고등학교의 최고 정보 동아리 라이빗의 호스팅 서비스입니다.
            </p>
            <div className="flex flex-wrap gap-raibit-sm">
              <a className={buttonVariants({ size: "lg" })} href={consoleUrl}>
                콘솔 시작하기
              </a>
              <a
                className={buttonVariants({ variant: "outline", size: "lg" })}
                href={signupUrl}
              >
                가입 신청
              </a>
            </div>
          </div>
          <div
            className="relative min-w-0 rounded-xl border border-border bg-muted p-raibit-md shadow-[0_16px_48px_rgb(0_0_0/0.12)]"
            aria-label="RAIBIT SERVER 프로젝트 운영 화면 예시"
          >
            <div className="rounded-lg border border-border bg-background">
              <div className="flex items-center justify-between border-b border-border px-raibit-lg py-raibit-md">
                <div>
                  <p className="text-micro text-muted-foreground">
                    raibit / club-home
                  </p>
                  <p className="mt-raibit-xs text-heading-md font-medium">
                    Production
                  </p>
                </div>
                <span className="inline-flex items-center gap-raibit-xs text-caption font-medium text-primary">
                  <span
                    className="size-2 rounded-full bg-primary"
                    aria-hidden="true"
                  />{" "}
                  Running
                </span>
              </div>
              <div className="grid gap-raibit-md p-raibit-lg sm:grid-cols-3">
                {[
                  {
                    icon: GitBranchIcon,
                    label: "Deploy",
                    value: "main · a9f21c8",
                  },
                  { icon: BoxIcon, label: "Services", value: "3 running" },
                  {
                    icon: DatabaseIcon,
                    label: "Resources",
                    value: "2 healthy",
                  },
                ].map(({ icon: Icon, label, value }) => (
                  <div
                    className="border-l border-border pl-raibit-md"
                    key={label}
                  >
                    <Icon
                      className="mb-raibit-lg size-5 text-primary"
                      aria-hidden="true"
                    />
                    <p className="text-micro text-muted-foreground">{label}</p>
                    <p className="mt-raibit-xs text-caption font-medium text-foreground">
                      {value}
                    </p>
                  </div>
                ))}
              </div>
              <div className="rounded-b-lg bg-inverse px-raibit-lg py-raibit-xl font-mono text-caption text-inverse-foreground">
                <p className="text-ink-faint">$ raibit deploy --production</p>
                <p className="mt-raibit-sm">Image ready · rollout completed</p>
                <p className="mt-raibit-xs text-integration-yellow">
                  apps--raibit--club-home.raibitserver.app
                </p>
              </div>
            </div>
          </div>
        </section>
        <section
          className="border-y border-border bg-muted/50"
          aria-labelledby="landing-sites-title"
        >
          <div className="mx-auto w-full max-w-7xl px-raibit-lg py-raibit-huge sm:px-raibit-xl">
            <header className="mb-raibit-xxl flex flex-col gap-raibit-lg sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-micro font-medium tracking-[0.16em] text-primary">
                  LIVE ON RAIBIT
                </p>
                <h2
                  className="mt-raibit-sm text-display-md font-medium text-foreground"
                  id="landing-sites-title"
                >
                  운영 중인 사이트
                </h2>
              </div>
              <a
                className="inline-flex min-h-11 items-center gap-raibit-xs text-button-md font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
                href="/status"
              >
                전체 시스템 상태{" "}
                <ArrowUpRightIcon className="size-4" aria-hidden="true" />
              </a>
            </header>
            {sites.length > 0 ? (
              <div className="border-t border-border">
                {sites.map((site, index) => (
                  <a
                    className="group grid min-h-20 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-raibit-md border-b border-border py-raibit-md text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 sm:grid-cols-[4rem_minmax(0,1fr)_auto_auto]"
                    href={site.url}
                    key={site.id ?? `${site.name}-${index}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="font-mono text-caption text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-heading-md font-medium">
                        {site.name}
                      </strong>
                      {site.owner ? (
                        <small className="mt-raibit-xs block truncate text-caption text-muted-foreground">
                          {site.owner}
                        </small>
                      ) : null}
                    </span>
                    <span className="hidden items-center gap-raibit-xs text-caption font-medium text-primary sm:inline-flex">
                      <span
                        className="size-2 rounded-full bg-primary"
                        aria-hidden="true"
                      />{" "}
                      LIVE
                    </span>
                    <ArrowUpRightIcon
                      className="size-5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </a>
                ))}
              </div>
            ) : (
              <Empty className="min-h-48 border border-border bg-background">
                <EmptyHeader>
                  <EmptyTitle>운영 사이트 준비 중</EmptyTitle>
                  <EmptyDescription>
                    공개 프로젝트가 준비되면 이곳에 표시됩니다.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}

function isPublicSite(value: unknown): value is PublicSite {
  if (!value || typeof value !== "object") return false;
  if (
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name.trim()
  )
    return false;
  if (!("url" in value) || typeof value.url !== "string") return false;
  if ("id" in value && value.id !== undefined && typeof value.id !== "string")
    return false;
  if (
    "owner" in value &&
    value.owner !== undefined &&
    typeof value.owner !== "string"
  )
    return false;
  try {
    const protocol = new URL(value.url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

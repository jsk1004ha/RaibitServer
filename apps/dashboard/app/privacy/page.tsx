import { PublicFooter } from "../../components/public-footer";
import { PublicHeader } from "../../components/public-header";

const privacyEmail = "ishsraibit@gmail.com";
const sections = [
  {
    number: "01",
    title: "개인정보의 처리 목적",
    body: "회원 식별과 이메일 인증, 가입 신청 확인 및 관리자 승인, 콘솔 로그인, 프로젝트·배포·리소스 운영, 보안 사고 예방과 서비스 문의 처리를 위해 개인정보를 처리합니다.",
  },
  {
    number: "03",
    title: "처리 및 보유 기간",
    body: "계정과 서비스 운영 정보는 회원 탈퇴 요청 처리 또는 서비스 종료 시까지 보유합니다. 이메일 인증 코드는 인증 완료 또는 유효기간 만료 시 더 이상 사용할 수 없으며, 세션 쿠키는 로그인 후 최대 12시간 유지됩니다. 보안·감사 기록은 서비스 보호와 사고 대응에 필요한 기간 동안 보유한 뒤 목적이 달성되면 파기합니다. 관계 법령에 따라 보존이 필요한 경우에는 해당 기간 동안 분리하여 보관합니다.",
  },
  {
    number: "04",
    title: "제3자 제공 및 처리위탁",
    body: "RAIBIT SERVER는 원칙적으로 개인정보를 제3자에게 제공하지 않습니다. 사용자가 GitHub 연동을 직접 선택한 경우 해당 기능 수행에 필요한 요청이 GitHub로 전송될 수 있으며, GitHub의 개인정보 처리 기준이 적용됩니다. 별도의 개인정보 처리위탁이 발생하면 수탁자와 업무 내용을 이 방침을 통해 공개합니다.",
  },
  {
    number: "05",
    title: "개인정보의 파기",
    body: "처리 목적이 달성되거나 보유기간이 끝난 개인정보는 지체 없이 파기합니다. 전자적 파일은 복구할 수 없도록 삭제하고, 출력물이 존재하는 경우 분쇄하거나 소각합니다. 법령에 따라 보존해야 하는 정보는 다른 정보와 분리하여 보관합니다.",
  },
  {
    number: "06",
    title: "정보주체의 권리와 행사 방법",
    body: "이용자는 자신의 개인정보에 대해 열람, 정정, 삭제, 처리정지 및 회원 탈퇴를 요청할 수 있습니다. 본인 확인이 필요한 요청은 아래 개인정보 문의처로 접수해 주세요. 법령에서 정한 사유가 있는 경우 일부 요청이 제한될 수 있으며 그 사유를 안내합니다.",
  },
] as const;
const trailingSections = [
  {
    number: "08",
    title: "안전성 확보 조치",
    body: "비밀번호의 단방향 해시 저장, HttpOnly 세션, 관리자 권한 분리, 역할 기반 접근 통제, 중요 정보 마스킹, 감사 기록, 비밀정보 암호화 및 안전한 컨테이너 기본값을 적용합니다.",
  },
  {
    number: "10",
    title: "처리방침의 변경",
    body: "이 방침이 변경되는 경우 시행 전에 서비스 화면을 통해 안내합니다. 이전 방침과 변경 이력은 필요 시 이용자가 확인할 수 있도록 제공합니다.",
  },
] as const;

export const metadata = {
  title: "개인정보처리방침 — RAIBIT SERVER",
  description: "RAIBIT SERVER 개인정보처리방침",
};

export default function PrivacyPage() {
  return (
    <>
      <PublicHeader />
      <main id="main-content">
        <article className="mx-auto w-full max-w-7xl px-raibit-lg py-raibit-huge sm:px-raibit-xl sm:py-24">
          <header className="grid gap-raibit-xl border-b border-border pb-raibit-xxl lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-end">
            <div>
              <p className="text-micro font-medium tracking-[0.16em] text-primary">
                RAIBIT PRIVACY
              </p>
              <h1 className="mt-raibit-lg text-display-xl font-medium text-foreground sm:text-display-xxl">
                개인정보처리방침
              </h1>
            </div>
            <div>
              <p className="break-keep [overflow-wrap:anywhere] text-body-md text-pretty text-secondary-foreground">
                RAIBIT SERVER는 서비스 운영에 필요한 최소한의 개인정보를
                처리하고 안전하게 보호합니다.
              </p>
              <p className="mt-raibit-md font-mono text-caption text-secondary-foreground">
                시행일 2026. 08. 25.
              </p>
            </div>
          </header>
          <div aria-label="개인정보처리방침 본문">
            {sections.slice(0, 1).map(PolicySection)}
            <section className="grid gap-raibit-lg border-b border-border py-raibit-xxl lg:grid-cols-[4rem_minmax(0,1fr)]">
              <span className="font-mono text-caption text-primary">02</span>
              <div className="min-w-0">
                <h2 className="text-heading-lg font-medium text-foreground">
                  처리하는 개인정보 항목
                </h2>
                <div className="mt-raibit-xl">
                  <table className="w-full table-fixed border-collapse text-left text-caption">
                    <thead>
                      <tr className="border-y border-border bg-muted">
                        <th
                          className="px-raibit-md py-raibit-sm font-medium text-foreground"
                          scope="col"
                        >
                          구분
                        </th>
                        <th
                          className="px-raibit-md py-raibit-sm font-medium text-foreground"
                          scope="col"
                        >
                          처리 항목
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        [
                          "가입·계정",
                          "이름, 학번, 라이빗 동아리원 여부, 이메일, 비밀번호 해시, 이메일 인증 시각, 역할 및 승인 상태",
                        ],
                        [
                          "GitHub 연동",
                          "GitHub 식별자, 로그인명, 프로필 이미지, 연결한 저장소 정보",
                        ],
                        [
                          "서비스 이용",
                          "조직·프로젝트·서비스 정보, 배포 및 리소스 작업 기록, 보안·감사 로그",
                        ],
                        ["세션", "로그인 상태 유지를 위한 HttpOnly 세션 쿠키"],
                      ].map(([label, value]) => (
                        <tr className="border-b border-border" key={label}>
                          <th
                            className="w-1/3 px-raibit-md py-raibit-md align-top font-medium text-foreground sm:w-1/4"
                            scope="row"
                          >
                            {label}
                          </th>
                          <td className="break-words px-raibit-md py-raibit-md align-top text-secondary-foreground">
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-raibit-lg max-w-4xl text-body-md text-pretty text-secondary-foreground">
                  가입 신청, 콘솔 이용 및 사용자가 선택한 GitHub 연동 과정에서
                  위 정보가 수집됩니다. 비밀번호 원문은 저장하지 않습니다.
                </p>
              </div>
            </section>
            {sections.slice(1).map(PolicySection)}
            <section className="grid gap-raibit-lg border-b border-border py-raibit-xxl lg:grid-cols-[4rem_minmax(0,1fr)]">
              <span className="font-mono text-caption text-primary">07</span>
              <div>
                <h2 className="text-heading-lg font-medium text-foreground">
                  쿠키의 이용
                </h2>
                <p className="mt-raibit-md max-w-4xl text-body-md text-pretty text-secondary-foreground">
                  로그인 상태 유지를 위해{" "}
                  <code className="rounded-xs bg-muted px-raibit-xs py-raibit-xxs font-mono text-caption text-foreground">
                    raibitserver_session
                  </code>{" "}
                  쿠키를 사용합니다. 이 쿠키는 JavaScript에서 읽을 수 없는
                  HttpOnly 방식이며, HTTPS 환경에서는 Secure 속성을 사용하고
                  SameSite=Lax와 host-only 범위로 설정됩니다. 로그아웃하면 즉시
                  삭제되며 브라우저 설정에서도 쿠키를 삭제할 수 있습니다.
                </p>
              </div>
            </section>
            {trailingSections.slice(0, 1).map(PolicySection)}
            <section className="my-raibit-xl grid gap-raibit-lg rounded-lg bg-primary p-raibit-xxl text-primary-foreground lg:grid-cols-[4rem_minmax(0,1fr)]">
              <span className="font-mono text-caption text-primary-foreground">
                09
              </span>
              <div>
                <h2 className="text-heading-lg font-medium">개인정보 문의처</h2>
                <p className="mt-raibit-md max-w-4xl text-body-md text-pretty text-primary-foreground">
                  개인정보 보호 및 관련 고충 처리는 RAIBIT SERVER 운영진이
                  담당합니다.
                </p>
                <a
                  className="mt-raibit-lg inline-flex min-h-11 items-center text-button-md font-medium underline underline-offset-4"
                  href={`mailto:${privacyEmail}?subject=${encodeURIComponent("[RAIBIT SERVER 개인정보 문의]")}`}
                >
                  {privacyEmail}로 문의하기
                </a>
                <p className="mt-raibit-md text-caption text-primary-foreground">
                  개인정보 침해에 관한 추가 도움은{" "}
                  <a
                    className="inline-flex min-h-11 items-center rounded-xs font-medium text-primary-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary-foreground/50"
                    href="https://www.privacy.go.kr"
                    target="_blank"
                    rel="noreferrer"
                  >
                    개인정보 포털
                  </a>
                  에서 받을 수 있습니다.
                </p>
              </div>
            </section>
            {trailingSections.slice(1).map(PolicySection)}
          </div>
        </article>
      </main>
      <PublicFooter />
    </>
  );
}

function PolicySection(
  section: Readonly<{ number: string; title: string; body: string }>,
) {
  return (
    <section
      className="grid gap-raibit-lg border-b border-border py-raibit-xxl lg:grid-cols-[4rem_minmax(0,1fr)]"
      key={section.number}
    >
      <span className="font-mono text-caption text-primary">
        {section.number}
      </span>
      <div>
        <h2 className="text-heading-lg font-medium text-foreground">
          {section.title}
        </h2>
        <p className="mt-raibit-md max-w-4xl text-body-md text-pretty text-secondary-foreground">
          {section.body}
        </p>
      </div>
    </section>
  );
}

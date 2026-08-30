import {
  CLIENT_ERROR_STATUS_CODES,
  errorPageModel,
  type ErrorStatusCode,
  SERVER_ERROR_STATUS_CODES,
} from '../../lib/error-page-model';

export const metadata = { title: '오류 화면 미리보기 · RAIBIT SERVER' };

export default function ErrorPreviewIndex() {
  const total = CLIENT_ERROR_STATUS_CODES.length + SERVER_ERROR_STATUS_CODES.length;
  return (
    <main id="main-content" className="min-h-[100dvh] bg-background px-raibit-lg py-raibit-xxl text-foreground lg:px-raibit-huge">
      <section className="mx-auto w-full max-w-6xl" aria-labelledby="error-catalog-title">
        <header className="border-b border-border pb-raibit-xl">
          <p className="font-mono text-micro uppercase tracking-widest text-muted-foreground">RAIBIT SERVER · 오류 화면 미리보기</p>
          <p className="mt-raibit-xl flex items-baseline gap-raibit-sm"><strong className="font-mono text-display-lg font-medium text-primary">{total}</strong><span className="font-mono text-micro tracking-widest text-muted-foreground">ACTIVE HTTP ERRORS</span></p>
          <h1 className="mt-raibit-sm text-display-lg font-medium tracking-tight" id="error-catalog-title">오류 화면 전체 목록</h1>
          <p className="mt-raibit-sm max-w-3xl text-body-md text-muted-foreground">표준으로 등록된 활성 4xx·5xx 상태를 같은 디자인과 한국어 안내로 검증할 수 있습니다.</p>
        </header>
        <div className="mt-raibit-xxl grid gap-raibit-xl lg:grid-cols-2">
          <ErrorCodeGroup
            family="4xx"
            title="클라이언트 오류"
            description="요청, 인증, 권한 또는 입력 조건을 확인해야 하는 상태"
            codes={CLIENT_ERROR_STATUS_CODES}
            columns={2}
          />
          <ErrorCodeGroup
            family="5xx"
            title="서버 오류"
            description="서비스, 게이트웨이 또는 저장 공간에서 발생한 상태"
            codes={SERVER_ERROR_STATUS_CODES}
            columns={1}
          />
        </div>
      </section>
    </main>
  );
}

function ErrorCodeGroup({
  family,
  title,
  description,
  codes,
  columns,
}: {
  family: '4xx' | '5xx';
  title: string;
  description: string;
  codes: readonly ErrorStatusCode[];
  columns: 1 | 2;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-raibit-xl" aria-labelledby={`error-group-${family}`}>
      <header>
        <p className="font-mono text-micro text-muted-foreground">{family}</p>
        <div className="mt-raibit-xs flex items-baseline justify-between gap-raibit-sm">
          <h2 className="text-heading-lg font-medium" id={`error-group-${family}`}>{title}</h2>
          <span className="text-caption text-muted-foreground">{codes.length}개</span>
        </div>
        <small className="mt-raibit-xs block text-caption text-muted-foreground">{description}</small>
      </header>
      <nav
        className="mt-raibit-lg grid gap-raibit-sm"
        data-columns={columns}
        aria-label={`${title} 화면 선택`}
      >
        {codes.map((code) => {
          const model = errorPageModel(code);
          return (
            <a className="flex min-h-11 items-center justify-between gap-raibit-sm rounded-sm border border-border px-raibit-md py-raibit-sm text-button-md transition-colors hover:bg-muted" href={`/errors/${code}`} key={code}>
              <strong className="font-mono text-primary">{code}</strong>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{model.eyebrow}</span>
              <span aria-hidden="true">↗</span>
            </a>
          );
        })}
      </nav>
    </section>
  );
}

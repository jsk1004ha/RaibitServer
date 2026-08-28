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
    <main className="error-page error-catalog-page">
      <section className="error-catalog" aria-labelledby="error-catalog-title">
        <header className="error-catalog-intro">
          <p className="error-eyebrow">RAIBIT SERVER · 오류 화면 미리보기</p>
          <p className="error-catalog-count"><strong>{total}</strong><span>ACTIVE HTTP ERRORS</span></p>
          <h1 id="error-catalog-title">오류 화면 전체 목록</h1>
          <p>표준으로 등록된 활성 4xx·5xx 상태를 같은 디자인과 한국어 안내로 검증할 수 있습니다.</p>
        </header>
        <div className="error-catalog-groups">
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
    <section className="error-code-group" aria-labelledby={`error-group-${family}`}>
      <header>
        <p>{family}</p>
        <div>
          <h2 id={`error-group-${family}`}>{title}</h2>
          <span>{codes.length}개</span>
        </div>
        <small>{description}</small>
      </header>
      <nav
        className="error-code-list"
        data-columns={columns}
        aria-label={`${title} 화면 선택`}
      >
        {codes.map((code) => {
          const model = errorPageModel(code);
          return (
            <a href={`/errors/${code}`} key={code}>
              <strong>{code}</strong>
              <span>{model.eyebrow}</span>
              <i aria-hidden="true">↗</i>
            </a>
          );
        })}
      </nav>
    </section>
  );
}

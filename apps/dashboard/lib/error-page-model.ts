export const CLIENT_ERROR_STATUS_CODES = [
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413,
  414, 415, 416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
] as const;

export const SERVER_ERROR_STATUS_CODES = [
  500, 501, 502, 503, 504, 505, 506, 507, 508, 511,
] as const;

export const ERROR_STATUS_CODES = [
  ...CLIENT_ERROR_STATUS_CODES,
  ...SERVER_ERROR_STATUS_CODES,
] as const;

export type ErrorStatusCode = (typeof ERROR_STATUS_CODES)[number];

export type ErrorPageModel = {
  code: ErrorStatusCode;
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
};

const ERROR_PAGE_MODELS: Record<ErrorStatusCode, ErrorPageModel> = {
  400: { code: 400, eyebrow: '잘못된 요청', title: '요청을 처리할 수 없습니다', description: '요청 형식이 올바르지 않습니다. 주소와 입력 내용을 확인해 주세요.', actionLabel: '이전 화면으로 돌아가기' },
  401: { code: 401, eyebrow: '인증 필요', title: '로그인이 필요합니다', description: '이 화면을 보려면 먼저 안전하게 로그인해 주세요.', actionLabel: '로그인하기' },
  402: { code: 402, eyebrow: '이용 조건 확인', title: '결제 또는 이용 조건을 확인해 주세요', description: '요청한 기능을 사용하기 위한 결제나 이용 조건이 충족되지 않았습니다.', actionLabel: '메인으로 돌아가기' },
  403: { code: 403, eyebrow: '접근 제한', title: '접근 권한이 없습니다', description: '현재 계정에는 이 화면을 열 수 있는 권한이 없습니다.', actionLabel: '메인으로 돌아가기' },
  404: { code: 404, eyebrow: '찾을 수 없음', title: '요청한 화면을 찾을 수 없습니다', description: '주소가 변경되었거나 배포된 사이트에 이 경로가 없을 수 있습니다.', actionLabel: '메인으로 돌아가기' },
  405: { code: 405, eyebrow: '요청 방식 제한', title: '이 요청 방식은 사용할 수 없습니다', description: '현재 주소는 사용한 HTTP 요청 방식을 지원하지 않습니다.', actionLabel: '메인으로 돌아가기' },
  406: { code: 406, eyebrow: '응답 형식 불일치', title: '요청한 형식으로 응답할 수 없습니다', description: '서비스가 제공하는 응답 형식과 요청한 형식이 일치하지 않습니다.', actionLabel: '메인으로 돌아가기' },
  407: { code: 407, eyebrow: '프록시 인증 필요', title: '네트워크 프록시 인증이 필요합니다', description: '현재 네트워크의 프록시 인증 설정을 확인한 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  408: { code: 408, eyebrow: '요청 시간 초과', title: '요청 시간이 초과되었습니다', description: '네트워크 상태를 확인한 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  409: { code: 409, eyebrow: '상태 충돌', title: '현재 상태와 요청이 충돌합니다', description: '최신 상태를 확인한 뒤 변경 내용을 다시 적용해 주세요.', actionLabel: '다시 시도하기' },
  410: { code: 410, eyebrow: '더 이상 제공되지 않음', title: '요청한 항목이 제거되었습니다', description: '이 주소의 화면이나 리소스는 더 이상 제공되지 않습니다.', actionLabel: '메인으로 돌아가기' },
  411: { code: 411, eyebrow: '길이 정보 필요', title: '요청 크기 정보가 필요합니다', description: '서버가 요청 본문의 길이를 확인할 수 없어 처리를 중단했습니다.', actionLabel: '메인으로 돌아가기' },
  412: { code: 412, eyebrow: '사전 조건 실패', title: '요청 조건을 충족하지 못했습니다', description: '대상의 현재 상태가 요청에 포함된 사전 조건과 일치하지 않습니다.', actionLabel: '다시 시도하기' },
  413: { code: 413, eyebrow: '요청 용량 초과', title: '요청 내용이 너무 큽니다', description: '업로드 또는 요청 데이터의 크기를 줄인 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  414: { code: 414, eyebrow: '주소 길이 초과', title: '요청 주소가 너무 깁니다', description: '주소나 검색 조건을 줄인 뒤 다시 요청해 주세요.', actionLabel: '메인으로 돌아가기' },
  415: { code: 415, eyebrow: '지원하지 않는 형식', title: '이 데이터 형식은 지원되지 않습니다', description: '파일 또는 요청 본문의 형식을 지원되는 유형으로 변경해 주세요.', actionLabel: '메인으로 돌아가기' },
  416: { code: 416, eyebrow: '요청 범위 오류', title: '요청한 데이터 범위를 제공할 수 없습니다', description: '대상의 실제 크기에 맞는 범위를 지정한 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  417: { code: 417, eyebrow: '기대 조건 실패', title: '요청의 기대 조건을 처리할 수 없습니다', description: '서버가 요청 헤더에 포함된 처리 조건을 충족하지 못했습니다.', actionLabel: '메인으로 돌아가기' },
  421: { code: 421, eyebrow: '잘못 연결된 요청', title: '이 서버에서 요청을 처리할 수 없습니다', description: '주소와 보안 연결을 확인한 뒤 새 연결로 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  422: { code: 422, eyebrow: '처리할 수 없는 내용', title: '요청 내용을 처리할 수 없습니다', description: '요청 형식은 올바르지만 일부 입력값이나 내용이 유효하지 않습니다.', actionLabel: '메인으로 돌아가기' },
  423: { code: 423, eyebrow: '리소스 잠김', title: '현재 항목이 잠겨 있습니다', description: '다른 작업이 끝나 잠금이 해제된 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  424: { code: 424, eyebrow: '의존 작업 실패', title: '앞선 작업이 완료되지 않았습니다', description: '이 요청에 필요한 다른 작업이 실패하여 처리를 계속할 수 없습니다.', actionLabel: '다시 시도하기' },
  425: { code: 425, eyebrow: '너무 이른 요청', title: '아직 안전하게 요청을 처리할 수 없습니다', description: '연결 준비가 완료될 때까지 잠시 기다린 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  426: { code: 426, eyebrow: '연결 방식 업그레이드', title: '연결 방식을 업그레이드해야 합니다', description: '지원되는 프로토콜 또는 최신 브라우저로 다시 접속해 주세요.', actionLabel: '메인으로 돌아가기' },
  428: { code: 428, eyebrow: '사전 조건 필요', title: '요청에 필요한 조건이 빠져 있습니다', description: '대상의 최신 상태를 확인할 수 있는 조건을 포함해 다시 요청해 주세요.', actionLabel: '다시 시도하기' },
  429: { code: 429, eyebrow: '요청 한도 초과', title: '요청이 너무 많습니다', description: '잠시 기다린 뒤 다시 시도해 주세요.', actionLabel: '잠시 후 다시 시도하기' },
  431: { code: 431, eyebrow: '요청 정보 용량 초과', title: '요청 정보가 너무 큽니다', description: '쿠키나 요청 헤더를 줄인 뒤 다시 접속해 주세요.', actionLabel: '메인으로 돌아가기' },
  451: { code: 451, eyebrow: '법적 제한', title: '법적 사유로 제공할 수 없습니다', description: '현재 지역 또는 요청 조건에서는 이 콘텐츠에 접근할 수 없습니다.', actionLabel: '메인으로 돌아가기' },
  500: { code: 500, eyebrow: '서버 오류', title: '서비스에서 오류가 발생했습니다', description: '요청은 안전하게 중단되었습니다. 잠시 후 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
  501: { code: 501, eyebrow: '지원하지 않는 기능', title: '아직 지원하지 않는 기능입니다', description: '서버가 이 요청을 수행하는 데 필요한 기능을 제공하지 않습니다.', actionLabel: '메인으로 돌아가기' },
  502: { code: 502, eyebrow: '연결 오류', title: '서비스에 연결할 수 없습니다', description: '상위 서비스가 올바른 응답을 보내지 못했습니다.', actionLabel: '다시 시도하기' },
  503: { code: 503, eyebrow: '서비스 일시 중단', title: '서비스를 잠시 사용할 수 없습니다', description: '배포 또는 점검이 진행 중일 수 있습니다. 잠시 후 다시 확인해 주세요.', actionLabel: '상태 확인하기' },
  504: { code: 504, eyebrow: '연결 시간 초과', title: '서비스 응답이 지연되고 있습니다', description: '상위 서비스의 응답을 기다리는 시간이 초과되었습니다.', actionLabel: '다시 시도하기' },
  505: { code: 505, eyebrow: 'HTTP 버전 미지원', title: '사용 중인 HTTP 버전을 지원하지 않습니다', description: '최신 브라우저 또는 지원되는 연결 방식으로 다시 접속해 주세요.', actionLabel: '메인으로 돌아가기' },
  506: { code: 506, eyebrow: '응답 협상 오류', title: '응답 형식을 결정하는 중 오류가 발생했습니다', description: '서버 설정 문제로 올바른 응답 형식을 선택하지 못했습니다.', actionLabel: '다시 시도하기' },
  507: { code: 507, eyebrow: '저장 공간 부족', title: '요청을 완료할 저장 공간이 부족합니다', description: '서비스 저장 공간이 확보될 때까지 잠시 기다려 주세요.', actionLabel: '다시 시도하기' },
  508: { code: 508, eyebrow: '반복 처리 감지', title: '요청 처리 과정에서 반복 경로가 감지되었습니다', description: '서비스 내부 연결이 반복되어 요청을 안전하게 중단했습니다.', actionLabel: '다시 시도하기' },
  511: { code: 511, eyebrow: '네트워크 인증 필요', title: '네트워크에 먼저 로그인해야 합니다', description: 'Wi-Fi 또는 접속 네트워크의 인증 화면을 완료한 뒤 다시 시도해 주세요.', actionLabel: '다시 시도하기' },
};

const RETRYABLE_ERROR_STATUS_CODES: readonly ErrorStatusCode[] = [
  407, 408, 409, 412, 413, 416, 421, 423, 424, 425, 428, 429,
  500, 502, 503, 504, 506, 507, 508, 511,
];

export function isRetryableErrorStatusCode(code: ErrorStatusCode): boolean {
  return RETRYABLE_ERROR_STATUS_CODES.includes(code);
}

export function errorPageModel(value: unknown, fallback: ErrorStatusCode = 500): ErrorPageModel {
  return ERROR_PAGE_MODELS[errorStatusCode(value, fallback)];
}

export function errorStatusCode(value: unknown, fallback: ErrorStatusCode = 404): ErrorStatusCode {
  const normalized = typeof value === 'number'
    ? value
    : /^\d{3}$/.test(String(value || '')) ? Number(value) : Number.NaN;
  return ERROR_STATUS_CODES.includes(normalized as ErrorStatusCode) ? normalized as ErrorStatusCode : fallback;
}

export function normalizePublicPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  const withoutFragment = value.split('#', 1)[0] || '';
  const withoutQuery = withoutFragment.split('?', 1)[0] || '';
  let pathname = withoutQuery;
  try {
    if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) return null;
  const cleaned = pathname.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
  return cleaned || '/';
}

export function normalizePublicIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(normalized) ? normalized : null;
}

export function renderHostedErrorHtml(codeValue: unknown, options: { path?: unknown; identifier?: unknown } = {}): string {
  const model = errorPageModel(codeValue, 404);
  const path = normalizePublicPath(options.path);
  const identifier = normalizePublicIdentifier(options.identifier);
  const actionHref = model.code === 401
    ? '/login'
    : isRetryableErrorStatusCode(model.code) ? path || '/' : '/';
  const actionLabel = model.code === 503 ? '다시 시도하기' : model.actionLabel;
  const details = [
    path ? `<div><dt>요청 경로</dt><dd><code>${escapeHtml(path)}</code></dd></div>` : '',
    identifier ? `<div><dt>오류 식별자</dt><dd><code>${escapeHtml(identifier)}</code></dd></div>` : '',
  ].filter(Boolean).join('');
  return `<!doctype html><html lang="ko" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="data:,"><title>${model.code} · RAIBIT SERVER</title><style>${HOSTED_ERROR_CSS}</style></head><body><main><header><a class="brand" href="/" aria-label="RAIBIT SERVER 홈"><span aria-hidden="true" class="brand-mark">R</span><span>RAIBIT SERVER</span></a><span class="status">HOSTED ERROR</span></header><section aria-labelledby="error-title"><div class="signal-wrap" aria-hidden="true"><div class="signal">${model.code}</div></div><div class="copy"><p class="eyebrow">${escapeHtml(model.eyebrow)}</p><h1 id="error-title">${escapeHtml(model.title)}</h1><p class="description">${escapeHtml(model.description)}</p>${details ? `<dl class="details">${details}</dl>` : ''}<div class="actions"><a href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a></div></div></section></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character);
}

const HOSTED_ERROR_CSS = `:root{color-scheme:light;--canvas:#fff;--canvas-soft:#fafafa;--ink:#171717;--ink-mute:#707070;--hairline:#dfdfdf;--hairline-cool:#ededed;--primary:#091936;--primary-deep:#071229;--on-primary:#fff}*{box-sizing:border-box}html,body{min-width:320px;min-height:100%;margin:0}body{background:var(--canvas);color:var(--ink);font-family:"Wanted Sans","Noto Sans KR",system-ui,sans-serif}main{width:min(100%,1440px);min-height:100dvh;margin:0 auto;padding:clamp(20px,3.4vw,56px) clamp(20px,5vw,80px)}header{display:flex;align-items:center;justify-content:space-between;min-height:36px;color:var(--ink);font-size:11px;font-weight:500;letter-spacing:.08em}.brand{display:inline-flex;align-items:center;gap:8px;color:inherit;font-size:13px;font-weight:500;letter-spacing:-.01em;text-decoration:none}.brand-mark{display:inline-grid;width:22px;height:22px;place-items:center;background:var(--primary);color:var(--on-primary);font:500 12px/1 ui-monospace,monospace}.status{color:var(--ink-mute);font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;font-size:10px;letter-spacing:.1em}section{display:grid;grid-template-columns:minmax(260px,.82fr) minmax(0,1fr);align-items:center;min-height:calc(100dvh - clamp(76px,8vw,148px));padding:clamp(40px,7vw,112px) 0}.signal-wrap{min-width:0;padding-right:clamp(32px,5vw,88px);border-right:1px solid var(--hairline);text-align:right}.signal{color:var(--primary);font:500 clamp(132px,20vw,300px)/.78 ui-monospace,Menlo,Monaco,Consolas,monospace;letter-spacing:-.13em}.copy{min-width:0;max-width:720px;padding:clamp(28px,4vw,56px) 0 clamp(28px,4vw,56px) clamp(32px,6vw,96px)}.eyebrow{margin:0 0 16px;color:var(--ink-mute);font-size:12px;font-weight:500;letter-spacing:.02em}h1{max-width:13ch;margin:0;font-size:clamp(36px,4.2vw,64px);font-weight:500;line-height:1.12;letter-spacing:-.055em;overflow-wrap:break-word;word-break:keep-all}.description{max-width:560px;margin:20px 0 0;color:var(--ink-mute);font-size:16px;line-height:1.65;overflow-wrap:break-word;word-break:keep-all}.details{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 18px;max-width:560px;margin:32px 0 0;padding-top:20px;border-top:1px solid var(--hairline-cool);color:var(--ink-mute);font-size:12px}.details>div{display:contents}.details dt,.details dd{min-width:0;margin:0}.details code{display:block;overflow:hidden;color:var(--ink);font:12px/1.5 ui-monospace,Menlo,Monaco,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.actions{margin-top:32px}.actions a{display:inline-flex;min-height:40px;align-items:center;justify-content:center;padding:0 16px;background:var(--primary);color:var(--on-primary);font-size:14px;font-weight:500;text-decoration:none}.actions a:hover{background:var(--primary-deep)}a:focus-visible{outline:2px solid var(--primary);outline-offset:3px}@media(max-width:820px){main{padding:24px clamp(20px,5vw,44px)}section{grid-template-columns:1fr;min-height:auto;padding:clamp(56px,10vw,88px) 0}.signal-wrap{padding:0 0 28px;border-right:0;border-bottom:1px solid var(--hairline);text-align:left}.signal{font-size:clamp(104px,20vw,168px);text-align:left}.copy{max-width:640px;padding:28px 0 0}h1{max-width:16ch}}@media(max-width:520px){main{min-height:100svh;padding:20px}.status{display:none}section{min-height:calc(100svh - 76px);padding:44px 0 28px}.signal-wrap{padding-bottom:22px}.signal{font-size:clamp(96px,30vw,132px);line-height:.8}.copy{display:flex;min-height:0;flex-direction:column;padding-top:24px}.eyebrow{margin-bottom:12px;font-size:11px}h1{max-width:100%;font-size:clamp(30px,8.5vw,36px);line-height:1.16}.description{margin-top:16px;font-size:15px;line-height:1.65}.details{grid-template-columns:1fr;gap:5px;margin-top:24px;padding-top:18px}.details>div{display:grid;gap:5px}.details dd{margin-bottom:10px}.actions{margin-top:auto;padding-top:28px}.actions a{width:100%;min-height:48px}}`;

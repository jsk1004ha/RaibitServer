'use client';

import { useSearchParams } from 'next/navigation';

const NOTICE_MESSAGES: Record<string, string> = {
  saved: '변경 사항을 저장했습니다.',
};

const ERROR_MESSAGES: Record<string, string> = {
  authentication_required: '로그인이 필요하거나 세션이 만료되었습니다.',
  confirmation_required: '대상과 작업 내용을 확인한 뒤 다시 시도하세요.',
  control_plane_unavailable: '제어 영역에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
  invalid_credentials: '이메일 또는 비밀번호를 확인하세요.',
  invalid_json_body: '요청 형식이 올바르지 않습니다.',
  invalid_request_body: '입력 내용을 확인한 뒤 다시 시도하세요.',
  invalid_request_origin: '보안을 위해 다른 출처에서 보낸 요청을 차단했습니다.',
  request_too_large: '요청 크기가 허용 범위를 초과했습니다.',
};

function errorMessage(code: string | null) {
  if (!code) return null;
  if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (code.startsWith('request_failed_')) return '요청을 처리하지 못했습니다. 입력과 권한을 확인하세요.';
  return '요청을 처리하지 못했습니다. 입력과 권한을 확인하세요.';
}

export function FlashBanner() {
  const searchParams = useSearchParams();
  const error = errorMessage(searchParams.get('error'));
  const noticeCode = searchParams.get('notice');
  const notice = noticeCode ? NOTICE_MESSAGES[noticeCode] || null : null;

  if (error) {
    return <p className="flash-message flash-error" role="alert" aria-live="assertive">{error}</p>;
  }
  if (notice) {
    return <p className="flash-message flash-notice" role="status" aria-live="polite">{notice}</p>;
  }
  return null;
}

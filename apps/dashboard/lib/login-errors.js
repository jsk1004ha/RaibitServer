const unavailableCodes = new Set([
  'control_plane_unavailable',
  'control_plane_timeout',
  'control_plane_response_timeout',
  'invalid_control_plane_response',
]);

export function loginServerErrorMessage(code) {
  return /^request_failed_5\d{2}$/.test(code) || unavailableCodes.has(code)
    ? '서버에서 로그인 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    : null;
}

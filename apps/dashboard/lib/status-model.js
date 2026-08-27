export const SYSTEM_STATUS_REFRESH_SECONDS = 30;

const healthyStates = new Set(['ok', 'healthy', 'ready', 'operational']);

export function healthResultIsOperational(result) {
  if (!result?.ok) return false;
  const status = String(result.body?.status || '').trim().toLowerCase();
  return healthyStates.has(status);
}

/**
 * @param {{
 *   apiResult: any;
 *   dataResult: any;
 *   apiLatencyMs?: number | null;
 *   dataLatencyMs?: number | null;
 *   checkedAt?: string;
 * }} input
 */
export function createSystemStatusSnapshot({
  apiResult,
  dataResult,
  apiLatencyMs = null,
  dataLatencyMs = null,
  checkedAt = new Date().toISOString(),
}) {
  const apiOperational = healthResultIsOperational(apiResult);
  const dataOperational = Boolean(dataResult?.ok);
  const status = apiOperational && dataOperational
    ? 'operational'
    : !apiOperational && !dataOperational
      ? 'outage'
      : 'degraded';

  return {
    schemaVersion: 1,
    status,
    checkedAt,
    refreshIntervalSeconds: SYSTEM_STATUS_REFRESH_SECONDS,
    components: [
      {
        id: 'dashboard',
        name: '웹 콘솔',
        detail: '화면 및 로그인',
        status: 'operational',
        latencyMs: null,
      },
      {
        id: 'control-plane',
        name: '제어 서버',
        detail: 'API 요청',
        status: apiOperational ? 'operational' : 'outage',
        latencyMs: normalizedLatency(apiLatencyMs),
      },
      {
        id: 'data-store',
        name: '데이터 저장소',
        detail: '프로젝트 데이터',
        status: dataOperational ? 'operational' : apiOperational ? 'degraded' : 'outage',
        latencyMs: normalizedLatency(dataLatencyMs),
      },
    ],
  };
}

/** @param {number | null | undefined} value */
function normalizedLatency(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

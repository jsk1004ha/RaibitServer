export const SYSTEM_STATUS_REFRESH_SECONDS = 30;
const DEFAULT_GITHUB_REPOSITORY = 'jsk1004ha/RaibitServer';

const healthyStates = new Set(['ok', 'healthy', 'ready', 'operational']);
const fullGitShaPattern = /^[0-9a-f]{40}$/i;
const githubRepositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

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
 *   gitSha?: string;
 *   githubRepository?: string;
 * }} input
 */
export function createSystemStatusSnapshot({
  apiResult,
  dataResult,
  apiLatencyMs = null,
  dataLatencyMs = null,
  checkedAt = new Date().toISOString(),
  gitSha = '',
  githubRepository = DEFAULT_GITHUB_REPOSITORY,
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
    deployment: deploymentVersion(gitSha, githubRepository),
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

/** @param {string | undefined} gitSha @param {string | undefined} githubRepository */
function deploymentVersion(gitSha, githubRepository) {
  const commitSha = String(gitSha || '').trim().toLowerCase();
  const repository = String(githubRepository || '').trim();
  const validCommitSha = fullGitShaPattern.test(commitSha) ? commitSha : null;
  const validRepository = githubRepositoryPattern.test(repository) ? repository : null;

  return {
    repository: validRepository,
    commitSha: validCommitSha,
    shortCommitSha: validCommitSha?.slice(0, 12) || null,
    commitUrl: validCommitSha && validRepository
      ? `https://github.com/${validRepository}/commit/${validCommitSha}`
      : null,
  };
}

/** @param {number | null | undefined} value */
function normalizedLatency(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

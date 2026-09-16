export function controlPlaneErrorCode(payload, status) {
  const candidates = [payload?.code, payload?.message, payload?.error];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) return candidate;
  }
  return `request_failed_${status}`;
}

const githubConflictCodes = new Set([
  'GITHUB_DUPLICATE_IMPORT',
  'GITHUB_PROJECT_SLUG_COLLISION',
  'GITHUB_SERVICE_ALREADY_BOUND',
  'GITHUB_INSTALLATION_MISMATCH',
  'GITHUB_DEFAULT_BRANCH_MISSING',
  'GITHUB_DEFAULT_BRANCH_CHANGED',
  'GITHUB_SOURCE_ACCESS_REVOKED',
  'GITHUB_CATALOG_STALE',
  'GITHUB_SOURCE_DISCONNECTED',
  'GITHUB_IDEMPOTENCY_CONFLICT',
]);

const recoveryActions = new Set([
  'OPEN_EXISTING_PROJECT',
  'OPEN_EXISTING_SERVICE',
  'CHOOSE_NEW_SLUG',
  'REFRESH_CATALOG',
  'REATTACH_INSTALLATION',
  'SELECT_BRANCH',
  'CANCEL',
]);

export function githubConflictRecovery(payload, status) {
  if (status !== 409 || !isRecord(payload) || !githubConflictCodes.has(payload.code) || !isRecord(payload.recovery) || !recoveryActions.has(payload.recovery.action)) return null;
  const action = payload.recovery.action;
  if (action === 'CANCEL') return githubConflictError(payload.code, { action });
  const recovery = { action };
  if (action === 'OPEN_EXISTING_PROJECT') copyId(payload.recovery, recovery, 'projectId');
  if (action === 'OPEN_EXISTING_SERVICE') {
    copyId(payload.recovery, recovery, 'projectId');
    copyId(payload.recovery, recovery, 'serviceId');
  }
  if (action === 'CHOOSE_NEW_SLUG') copySlug(payload.recovery, recovery);
  if (action === 'REFRESH_CATALOG' || action === 'REATTACH_INSTALLATION') copyId(payload.recovery, recovery, 'installationId');
  if (action === 'SELECT_BRANCH') {
    copyId(payload.recovery, recovery, 'repositoryId');
    copyBranch(payload.recovery, recovery, 'currentDefaultBranch');
    copyBranch(payload.recovery, recovery, 'requestedBranch');
  }
  return githubConflictError(payload.code, recovery);
}

function githubConflictError(code, recovery) {
  return { statusCode: 409, message: code, error: code, code, retryable: false, terminal: true, permission: false, recovery };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyId(source, target, key) {
  if (typeof source[key] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(source[key])) target[key] = source[key];
}

function copySlug(source, target) {
  if (typeof source.suggestedSlug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62})?$/.test(source.suggestedSlug)) target.suggestedSlug = source.suggestedSlug;
}

function copyBranch(source, target, key) {
  if (typeof source[key] === 'string' && /^[A-Za-z0-9._/-]{1,255}$/.test(source[key])) target[key] = source[key];
}

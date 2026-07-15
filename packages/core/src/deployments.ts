export const DEPLOYMENT_STATUSES = Object.freeze({
  QUEUED: 'queued',
  BUILDING: 'BUILDING',
  IMAGE_READY: 'IMAGE_READY',
  DEPLOYING: 'DEPLOYING',
  READY: 'READY',
  BUILD_FAILED: 'BUILD_FAILED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PREVIEW_CLEANUP_REQUESTED: 'PREVIEW_CLEANUP_REQUESTED',
});

const STATUS_ALIASES: Record<string, string> = Object.freeze({
  queued: DEPLOYMENT_STATUSES.QUEUED,
  pending: DEPLOYMENT_STATUSES.QUEUED,
  build_queued: DEPLOYMENT_STATUSES.QUEUED,
  building: DEPLOYMENT_STATUSES.BUILDING,
  build: DEPLOYMENT_STATUSES.BUILDING,
  image_ready: DEPLOYMENT_STATUSES.IMAGE_READY,
  imageready: DEPLOYMENT_STATUSES.IMAGE_READY,
  deploy_ready: DEPLOYMENT_STATUSES.IMAGE_READY,
  deploying: DEPLOYMENT_STATUSES.DEPLOYING,
  rollout: DEPLOYMENT_STATUSES.DEPLOYING,
  ready: DEPLOYMENT_STATUSES.READY,
  succeeded: DEPLOYMENT_STATUSES.READY,
  success: DEPLOYMENT_STATUSES.READY,
  build_failed: DEPLOYMENT_STATUSES.BUILD_FAILED,
  buildfailed: DEPLOYMENT_STATUSES.BUILD_FAILED,
  failed: DEPLOYMENT_STATUSES.FAILED,
  error: DEPLOYMENT_STATUSES.FAILED,
  cancelled: DEPLOYMENT_STATUSES.CANCELLED,
  canceled: DEPLOYMENT_STATUSES.CANCELLED,
  preview_cleanup_requested: DEPLOYMENT_STATUSES.PREVIEW_CLEANUP_REQUESTED,
});

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = Object.freeze({
  [DEPLOYMENT_STATUSES.QUEUED]: new Set([DEPLOYMENT_STATUSES.BUILDING, DEPLOYMENT_STATUSES.CANCELLED, DEPLOYMENT_STATUSES.FAILED]),
  [DEPLOYMENT_STATUSES.BUILDING]: new Set([DEPLOYMENT_STATUSES.IMAGE_READY, DEPLOYMENT_STATUSES.BUILD_FAILED, DEPLOYMENT_STATUSES.FAILED, DEPLOYMENT_STATUSES.CANCELLED]),
  [DEPLOYMENT_STATUSES.IMAGE_READY]: new Set([DEPLOYMENT_STATUSES.DEPLOYING, DEPLOYMENT_STATUSES.READY, DEPLOYMENT_STATUSES.FAILED, DEPLOYMENT_STATUSES.CANCELLED]),
  [DEPLOYMENT_STATUSES.DEPLOYING]: new Set([DEPLOYMENT_STATUSES.READY, DEPLOYMENT_STATUSES.FAILED]),
  [DEPLOYMENT_STATUSES.READY]: new Set([DEPLOYMENT_STATUSES.PREVIEW_CLEANUP_REQUESTED]),
  [DEPLOYMENT_STATUSES.BUILD_FAILED]: new Set([DEPLOYMENT_STATUSES.BUILDING]),
  [DEPLOYMENT_STATUSES.FAILED]: new Set([DEPLOYMENT_STATUSES.BUILDING]),
  [DEPLOYMENT_STATUSES.PREVIEW_CLEANUP_REQUESTED]: new Set([]),
  [DEPLOYMENT_STATUSES.CANCELLED]: new Set([]),
});

const CANCELLABLE_STATUSES = new Set<string>([
  DEPLOYMENT_STATUSES.QUEUED,
  DEPLOYMENT_STATUSES.BUILDING,
  DEPLOYMENT_STATUSES.IMAGE_READY,
]);

export function normalizeDeploymentStatus(status: any) {
  const raw = String(status || DEPLOYMENT_STATUSES.QUEUED).trim();
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_ALIASES[key] || raw;
}

export function canTransitionDeployment(from: any, to: any) {
  const current = normalizeDeploymentStatus(from);
  const next = normalizeDeploymentStatus(to);
  if (current === next) return true;
  return ALLOWED_TRANSITIONS[current]?.has(next) === true;
}

export function assertDeploymentTransition(from: any, to: any) {
  if (canTransitionDeployment(from, to)) return true;
  throw new Error(`invalid deployment status transition: ${normalizeDeploymentStatus(from)} -> ${normalizeDeploymentStatus(to)}`);
}

export function canCancelDeployment(status: any) {
  return CANCELLABLE_STATUSES.has(normalizeDeploymentStatus(status));
}

export function isDeploymentTerminal(status: any) {
  const normalized = normalizeDeploymentStatus(status);
  return normalized === DEPLOYMENT_STATUSES.READY
    || normalized === DEPLOYMENT_STATUSES.BUILD_FAILED
    || normalized === DEPLOYMENT_STATUSES.FAILED
    || normalized === DEPLOYMENT_STATUSES.CANCELLED;
}

import { deepClone, nowIso, stableId } from './ids.ts';
import { isSecretKey, maskSecretValue } from './secrets.ts';
import { sanitizeLogRecord } from './security.ts';
import { normalizeInfrastructureError } from './error-spec.ts';
import { LIFECYCLE_CONTRACT, parseWorkflowStatus } from './lifecycle.ts';

export const WORKFLOW_TYPES = Object.freeze({
  BUILD_AND_DEPLOY: 'build-and-deploy',
  PREVIEW_DEPLOY: 'preview-deploy',
  KUBERNETES_APPLY: 'kubernetes-apply',
  PROVISION_RESOURCE: 'provision-resource',
  PUBLIC_HEALTH_OBSERVE: 'public-health-observe',
  RESOURCE_BACKUP: 'resource.backup',
  RESOURCE_RESTORE: 'resource.restore',
});

export const WORKFLOW_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const READY_STATUSES = new Set<string>([WORKFLOW_STATUSES.QUEUED]);

export function createWorkflowJobRecord(input: Record<string, any>) {
  const type = input.type || WORKFLOW_TYPES.BUILD_AND_DEPLOY;
  const targetType = input.targetType || 'deployment';
  const targetId = input.targetId || input.deploymentId || input.serviceId;
  if (!targetId) throw new Error('workflow job targetId is required');
  const createdAt = input.createdAt || nowIso();
  return {
    id: input.id || stableId('job', type, targetType, targetId, createdAt || Date.now()),
    type,
    status: normalizeWorkflowStatus(input.status || WORKFLOW_STATUSES.QUEUED),
    targetType,
    targetId,
    payload: sanitizeWorkflowValue(input.payload || {}),
    attempts: Math.max(0, Number(input.attempts || 0)),
    maxAttempts: Math.max(1, Number(input.maxAttempts || 3)),
    runAfter: input.runAfter ? isoTimestamp(input.runAfter) : nowIso(),
    lockedBy: input.lockedBy || null,
    lockedAt: input.lockedAt ? isoTimestamp(input.lockedAt) : null,
    createdAt,
    updatedAt: input.updatedAt || nowIso(),
  };
}

export const normalizeWorkflowStatus = parseWorkflowStatus;

export function isWorkflowTerminal(job: Record<string, any>) {
  return LIFECYCLE_CONTRACT.machines.workflow.states[normalizeWorkflowStatus(job.status)].terminal;
}

export function isWorkflowJobReady(job: Record<string, any>, options: Record<string, any> = {}) {
  if ([WORKFLOW_TYPES.PUBLIC_HEALTH_OBSERVE, WORKFLOW_TYPES.RESOURCE_BACKUP, WORKFLOW_TYPES.RESOURCE_RESTORE].includes(job.type)) return false;
  const now = dateMillis(options.now || Date.now());
  const runAfter = dateMillis(job.runAfter || 0);
  if (!READY_STATUSES.has(normalizeWorkflowStatus(job.status))) return false;
  if (runAfter > now) return false;
  if (!job.lockedAt) return true;
  return isWorkflowLockExpired(job, options);
}

export function isWorkflowLockExpired(job: Record<string, any>, options: Record<string, any> = {}) {
  if (!job.lockedAt) return true;
  const leaseMs = Number(options.leaseMs ?? (Number(options.leaseSeconds || 300) * 1000));
  return dateMillis(job.lockedAt) + leaseMs <= dateMillis(options.now || Date.now());
}

export function claimWorkflowJobRecord(job: Record<string, any>, options: Record<string, any> = {}) {
  if (!isWorkflowJobReady(job, options)) return null;
  const now = isoTimestamp(options.now || Date.now());
  return {
    ...job,
    status: WORKFLOW_STATUSES.RUNNING,
    attempts: Math.max(0, Number(job.attempts || 0)) + 1,
    maxAttempts: Math.max(1, Number(job.maxAttempts || 3)),
    lockedBy: options.workerId || options.worker || 'workflow-worker',
    lockedAt: now,
    updatedAt: now,
  };
}

export function completeWorkflowJobRecord(job: Record<string, any>, result: any = {}, options: Record<string, any> = {}) {
  const now = isoTimestamp(options.now || Date.now());
  return {
    ...job,
    status: WORKFLOW_STATUSES.SUCCEEDED,
    payload: {
      ...(job.payload || {}),
      lastResult: sanitizeWorkflowValue(result),
      completedAt: now,
    },
    lockedBy: null,
    lockedAt: null,
    updatedAt: now,
  };
}

export function failWorkflowJobRecord(job: Record<string, any>, error: any, options: Record<string, any> = {}) {
  const now = dateMillis(options.now || Date.now());
  const attempts = Math.max(0, Number(job.attempts || 0));
  const maxAttempts = Math.max(1, Number(job.maxAttempts || 3));
  const retryable = options.retryable !== false && attempts < maxAttempts;
  const nextRunAt = retryable ? new Date(now + retryDelayMs(attempts, options)).toISOString() : isoTimestamp(now);
  const safeError = workflowErrorMessage(error);
  const errorSpec = normalizeInfrastructureError(error, options.errorCode || (safeError.includes('no workflow handler registered') ? 'WORKFLOW_HANDLER_MISSING' : 'UNKNOWN_INFRA_ERROR'));
  return {
    ...job,
    status: retryable ? WORKFLOW_STATUSES.QUEUED : WORKFLOW_STATUSES.FAILED,
    payload: {
      ...(job.payload || {}),
      lastError: safeError,
      lastErrorSpec: errorSpec,
      failedAt: isoTimestamp(now),
    },
    runAfter: nextRunAt,
    lockedBy: null,
    lockedAt: null,
    updatedAt: isoTimestamp(now),
  };
}

export function claimNextWorkflowJobFromList(jobs: Record<string, any>[], options: Record<string, any> = {}) {
  const ordered = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => isWorkflowJobReady(job, options))
    .sort((left, right) => dateMillis(left.job.runAfter || left.job.createdAt || 0) - dateMillis(right.job.runAfter || right.job.createdAt || 0));
  const next = ordered[0];
  if (!next) return null;
  const claimed = claimWorkflowJobRecord(next.job, options);
  if (!claimed) return null;
  jobs[next.index] = claimed;
  return deepClone(claimed);
}

export async function processNextWorkflowJob(queue: any, handlers: Record<string, any> = {}, options: Record<string, any> = {}) {
  const claim = await claimFromQueue(queue, options);
  if (!claim) return { processed: false, ok: true, reason: 'no_ready_workflow_jobs' };
  const handler = handlers[claim.type] || handlers.default;
  if (typeof handler !== 'function') {
    const failed = failWorkflowJobRecord(claim, new Error(`no workflow handler registered for ${claim.type}`), { ...options, retryable: false });
    await failInQueue(queue, claim, failed, options);
    return { processed: true, ok: false, job: deepClone(failed), error: failed.payload.lastError };
  }

  try {
    const result = await handler(deepClone(claim), { workerId: options.workerId || options.worker || claim.lockedBy, signal: options.signal });
    const completed = completeWorkflowJobRecord(claim, result, options);
    await completeInQueue(queue, claim, completed, options);
    return { processed: true, ok: true, job: deepClone(completed), result: sanitizeWorkflowValue(result) };
  } catch (error) {
    const failed = failWorkflowJobRecord(claim, error, options);
    await failInQueue(queue, claim, failed, options);
    return { processed: true, ok: false, job: deepClone(failed), error: failed.payload.lastError };
  }
}

export const processWorkflowQueue = processNextWorkflowJob;

export async function drainWorkflowQueue(queue: any, handlers: Record<string, any> = {}, options: Record<string, any> = {}) {
  const maxJobs = boundedInteger(options.maxJobs, 25, 1, 100);
  const concurrency = boundedInteger(options.concurrency, 4, 1, 16);
  const results: any[] = [];
  let reservations = 0;
  let exhausted = false;

  const workers = Array.from({ length: Math.min(concurrency, maxJobs) }, async () => {
    while (!exhausted && !options.signal?.aborted) {
      if (reservations >= maxJobs) return;
      reservations += 1;
      const result = await processNextWorkflowJob(queue, handlers, options);
      if (!result.processed) {
        exhausted = true;
        return;
      }
      results.push(result);
    }
  });
  await Promise.all(workers);
  return {
    processed: results.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    exhausted,
    aborted: Boolean(options.signal?.aborted),
    results,
  };
}

export function sanitizeWorkflowValue(input: any): any {
  if (typeof input === 'string') return sanitizeLogRecord(input);
  if (Array.isArray(input)) return input.map((item) => sanitizeWorkflowValue(item));
  if (!input || typeof input !== 'object') return input;
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = isSecretKey(key) && value !== null && value !== undefined && typeof value !== 'object'
      ? maskSecretValue(value)
      : sanitizeWorkflowValue(value);
  }
  return output;
}

export function workflowErrorMessage(error: any) {
  if (!error) return 'workflow failed';
  if (typeof error === 'string') return sanitizeLogRecord(error);
  const message = error?.message || String(error);
  return sanitizeLogRecord(message);
}

function retryDelayMs(attempts: number, options: Record<string, any>) {
  const base = Number(options.retryDelayMs ?? 1000);
  const max = Number(options.maxRetryDelayMs ?? 60_000);
  return Math.min(max, base * Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

async function claimFromQueue(queue: any, options: Record<string, any>) {
  if (Array.isArray(queue)) return claimNextWorkflowJobFromList(queue, options);
  if (typeof queue.claimNextWorkflowJob === 'function') return queue.claimNextWorkflowJob(options);
  if (Array.isArray(queue.workflowJobs)) return claimNextWorkflowJobFromList(queue.workflowJobs, options);
  throw new Error('workflow queue must be an array or implement claimNextWorkflowJob');
}

async function completeInQueue(queue: any, claimed: Record<string, any>, completed: Record<string, any>, options: Record<string, any>) {
  if (Array.isArray(queue)) return replaceWorkflowJob(queue, completed);
  if (typeof queue.completeWorkflowJob === 'function') return queue.completeWorkflowJob(claimed.id, completed.payload.lastResult, { ...options, record: completed });
  if (Array.isArray(queue.workflowJobs)) return replaceWorkflowJob(queue.workflowJobs, completed);
  return completed;
}

async function failInQueue(queue: any, claimed: Record<string, any>, failed: Record<string, any>, options: Record<string, any>) {
  if (Array.isArray(queue)) return replaceWorkflowJob(queue, failed);
  if (typeof queue.failWorkflowJob === 'function') return queue.failWorkflowJob(claimed.id, failed.payload.lastError, { ...options, record: failed });
  if (Array.isArray(queue.workflowJobs)) return replaceWorkflowJob(queue.workflowJobs, failed);
  return failed;
}

export function replaceWorkflowJob(jobs: Record<string, any>[], next: Record<string, any>) {
  const index = jobs.findIndex((job) => String(job.id) === String(next.id));
  if (index === -1) throw new Error(`workflow job not found: ${next.id}`);
  jobs[index] = next;
  return deepClone(next);
}

function dateMillis(value: any) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isoTimestamp(value: any) {
  return new Date(dateMillis(value)).toISOString();
}

function boundedInteger(value: any, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

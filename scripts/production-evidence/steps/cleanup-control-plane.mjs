import { CleanupError, CleanupNotRunError, callTimeout, controlPath, exactKeys, isRecord, nowMs } from './cleanup-helpers.mjs';

const INITIAL_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 1_000;

function controlNotFound(result) { return isRecord(result) && result.statusCode === 404; }
function matchingControlItem(item, proof) {
  if (!proof?.binding || !proof?.project) throw new CleanupError('cleanup_identity_mismatch');
  if ((item.resourceType === 'project' && proof.binding.payload.projectId !== item.id)
    || ((item.resourceType === 'resource' || item.resourceType === 'restore-target') && proof.binding.payload.resourceId !== item.id)
    || (item.resourceType === 'backup' && proof.binding.payload.backupId !== item.id)
    || (item.resourceType === 'preview' && proof.binding.payload.deploymentId !== item.id)) throw new CleanupError('cleanup_identity_mismatch');
}
function confirmedDelete(body, id, idKey) { return exactKeys(body, ['deleted', idKey]) && body.deleted === true && body[idKey] === id; }
function requestedDelete(body, id) { return exactKeys(body, ['deletionRequested', 'status', 'resourceId']) && body.deletionRequested === true && body.status === 'DELETING' && body.resourceId === id; }
function requestedProjectDelete(result, id) { return isRecord(result) && result.statusCode === 202 && exactKeys(result.body, ['deletionRequested', 'projectId']) && result.body.deletionRequested === true && result.body.projectId === id; }
function backupDeleteAccepted(body, item, proof) {
  return exactKeys(body, ['id', 'organizationId', 'projectId', 'resourceId', 'engine', 'status', 'createdAt', 'readyAt', 'errorCode', 'size', 'expiresAt', 'recoverable'])
    && body.id === item.id && body.organizationId === proof.project.organizationId && body.projectId === proof.project.projectId
    && body.resourceId === proof.binding.payload.sourceResourceId && body.engine === proof.binding.payload.engine && body.status === 'DELETING'
    && typeof body.createdAt === 'string' && (typeof body.readyAt === 'string' || body.readyAt === null)
    && (typeof body.errorCode === 'string' || body.errorCode === null) && (typeof body.size === 'string' || body.size === null)
    && (typeof body.expiresAt === 'string' || body.expiresAt === null) && typeof body.recoverable === 'boolean';
}
function previewAccepted(body, id) {
  return exactKeys(body, ['operationId', 'status', 'streamHref', 'lineageId', 'deploymentIds'])
    && typeof body.lineageId === 'string' && body.lineageId.length > 0 && body.operationId === `preview-cleanup:${body.lineageId}`
    && body.status === 'PREVIEW_CLEANUP_REQUESTED' && typeof body.streamHref === 'string'
    && Array.isArray(body.deploymentIds) && body.deploymentIds.includes(id);
}
function validBackupView(body) {
  return isRecord(body) && exactKeys(body, ['id', 'organizationId', 'projectId', 'resourceId', 'engine', 'status', 'createdAt', 'readyAt', 'errorCode', 'size', 'expiresAt', 'recoverable'])
    && typeof body.id === 'string' && typeof body.organizationId === 'string' && typeof body.projectId === 'string' && typeof body.resourceId === 'string'
    && typeof body.engine === 'string' && typeof body.status === 'string' && typeof body.createdAt === 'string'
    && (typeof body.readyAt === 'string' || body.readyAt === null) && (typeof body.errorCode === 'string' || body.errorCode === null)
    && (typeof body.size === 'string' || body.size === null) && (typeof body.expiresAt === 'string' || body.expiresAt === null) && typeof body.recoverable === 'boolean';
}
function controlJson(context, request, operation) { return context.controlPlaneJson({ ...operation, timeoutMs: callTimeout(request, context) }); }
async function waitForPoll(context, request, attempt) {
  const remaining = Date.parse(request.deadlineAt) - nowMs(context);
  if (!Number.isFinite(remaining) || remaining <= 0) throw new CleanupError('cleanup_timeout');
  const delayMs = Math.min(INITIAL_BACKOFF_MS * 2 ** Math.min(attempt, 10), MAX_BACKOFF_MS, remaining);
  if (await context.waitForCleanup({ delayMs, deadlineAt: request.deadlineAt }) !== true) throw new CleanupError('cleanup_command_failure');
}
async function pollNotFound(context, request, pathName) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await controlJson(context, request, { method: 'GET', path: pathName });
    if (controlNotFound(result)) return;
    if (!isRecord(result) || result.statusCode !== 200) throw new CleanupError('cleanup_command_failure');
    await waitForPoll(context, request, attempt);
  }
}
async function pollBackupAbsent(context, request, item, proof) {
  const { sourceResourceId, engine } = proof.binding.payload;
  const basePath = `/api/resources/${encodeURIComponent(sourceResourceId)}/backups`;
  for (let attempt = 0; ; attempt += 1) {
    let cursor = null; const cursors = new Set(); let targetPresent = false;
    for (let page = 0; ; page += 1) {
      if (page >= 256) throw new CleanupError('cleanup_timeout');
      const pathName = cursor === null ? basePath : `${basePath}?cursor=${encodeURIComponent(cursor)}`;
      const result = await controlJson(context, request, { method: 'GET', path: pathName });
      if (!isRecord(result) || result.statusCode !== 200 || !exactKeys(result.body, ['backups', 'nextCursor']) || !Array.isArray(result.body.backups)
        || !result.body.backups.every((backup) => validBackupView(backup) && backup.organizationId === proof.project.organizationId
          && backup.projectId === proof.project.projectId && backup.resourceId === sourceResourceId && backup.engine === engine)) throw new CleanupError('cleanup_command_failure');
      targetPresent ||= result.body.backups.some((backup) => backup.id === item.id);
      if (result.body.nextCursor === null) break;
      if (typeof result.body.nextCursor !== 'string' || !/^[A-Za-z0-9._~-]{1,256}$/.test(result.body.nextCursor) || cursors.has(result.body.nextCursor)) throw new CleanupError('cleanup_command_failure');
      cursors.add(result.body.nextCursor); cursor = result.body.nextCursor;
    }
    if (!targetPresent) return;
    await waitForPoll(context, request, attempt);
  }
}
async function absentFromProject(context, request, item, proof) {
  const result = await controlJson(context, request, { method: 'GET', path: `/api/projects/${encodeURIComponent(proof.project.projectId)}/resources` });
  if (!isRecord(result) || result.statusCode !== 200 || !isRecord(result.body) || !Array.isArray(result.body.resources)
    || result.body.resources.some((resource) => !isRecord(resource) || resource.id === item.id)) throw new CleanupError('cleanup_command_failure');
}

export function requireControlPlaneCapabilities(context) {
  if (typeof context.controlPlaneJson !== 'function') throw new CleanupNotRunError('cleanup_authenticated_client_missing');
  if (typeof context.waitForCleanup !== 'function') throw new CleanupNotRunError('cleanup_wait_capability_missing');
}
export async function cleanupControlPlane(item, request, context, proof) {
  matchingControlItem(item, proof);
  const pathName = controlPath(item);
  if (proof.deleteResolved !== null) {
    if (item.resourceType === 'backup') { await pollBackupAbsent(context, request, item, proof); return proof.deleteResolved.outcome.responseSha256; }
    if (item.resourceType === 'preview') {
      for (let attempt = 0; ; attempt += 1) {
        const deployment = await controlJson(context, request, { method: 'GET', path: pathName });
        if (!isRecord(deployment) || deployment.statusCode !== 200 || !isRecord(deployment.body)) throw new CleanupError('cleanup_command_failure');
        if (deployment.body.id === item.id && deployment.body.projectId === proof.project.projectId && deployment.body.status === 'CLEANED_UP') return proof.deleteResolved.outcome.responseSha256;
        await waitForPoll(context, request, attempt);
      }
    }
    await pollNotFound(context, request, pathName);
    return proof.deleteResolved.outcome.responseSha256;
  }
  if (item.resourceType === 'preview') {
    const requested = await controlJson(context, request, { method: 'POST', path: `${pathName}/preview-cleanup`, body: { confirmed: true } });
    if (!isRecord(requested) || requested.statusCode !== 202 || !previewAccepted(requested.body, item.id)) throw new CleanupError('cleanup_command_failure');
    for (let attempt = 0; ; attempt += 1) {
      const deployment = await controlJson(context, request, { method: 'GET', path: pathName });
      if (!isRecord(deployment) || deployment.statusCode !== 200 || !isRecord(deployment.body)) throw new CleanupError('cleanup_command_failure');
      if (deployment.body.id === item.id && deployment.body.projectId === proof.project.projectId && deployment.body.status === 'CLEANED_UP') return requested.body;
      await waitForPoll(context, request, attempt);
    }
    return;
  }
  const deleted = await controlJson(context, request, { method: 'DELETE', path: pathName, ...(item.resourceType === 'backup' ? { body: { confirmed: true } } : {}) });
  if (item.resourceType === 'backup') {
    if (!isRecord(deleted) || deleted.statusCode !== 200 || !backupDeleteAccepted(deleted.body, item, proof)) throw new CleanupError('cleanup_command_failure');
    await pollBackupAbsent(context, request, item, proof);
    return deleted.body;
  }
  if (controlNotFound(deleted) && (item.resourceType === 'resource' || item.resourceType === 'restore-target')) { await absentFromProject(context, request, item, proof); return deleted.body; }
  const idKey = item.resourceType === 'project' ? 'projectId' : 'resourceId';
  if (!isRecord(deleted) || !((deleted.statusCode === 200 && (confirmedDelete(deleted.body, item.id, idKey)
    || (item.resourceType !== 'project' && requestedDelete(deleted.body, item.id))))
    || (item.resourceType === 'project' && requestedProjectDelete(deleted, item.id)))) throw new CleanupError('cleanup_command_failure');
  await pollNotFound(context, request, pathName);
  return deleted.body;
}

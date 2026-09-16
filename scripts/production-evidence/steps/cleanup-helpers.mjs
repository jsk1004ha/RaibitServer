import { EvidenceError } from '../lib/operator-inputs.mjs';
import { parseStepRequest } from '../lib/step-contract.mjs';

export const RUN_LABEL = 'raibitserver.io/run-id';
export const CLEANUP_TIMEOUT_MS = 30_000;
export const CONTROL_TYPES = new Set(['preview', 'resource', 'restore-target', 'backup', 'attachment', 'project']);

export class CleanupError extends EvidenceError {
  constructor(reason) { super(reason); this.name = 'CleanupError'; }
}
export class CleanupNotRunError extends CleanupError {
  constructor(reason) { super(reason); this.name = 'CleanupNotRunError'; }
}

export function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exactKeys(value, keys) { return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
export function nowMs(context) {
  const value = context.now();
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : value);
  if (!Number.isFinite(parsed)) throw new CleanupError('cleanup_invalid_state');
  return parsed;
}
export function nowIso(context) { return new Date(nowMs(context)).toISOString(); }
export function callTimeout(request, context) {
  const remaining = Date.parse(request.deadlineAt) - nowMs(context);
  if (!Number.isFinite(remaining) || remaining <= 0) throw new CleanupError('cleanup_timeout');
  return Math.min(remaining, CLEANUP_TIMEOUT_MS);
}
export function isNotFound(result) { return result.exitCode !== 0 && /(?:notfound|not found|404)/i.test(`${result.stdout}\n${result.stderr}`); }
export function parseJson(text, reason) {
  try { return JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) throw new CleanupError(reason); throw error; }
}
export function assertRunLabels(labels, identity) {
  if (!exactKeys(labels, [RUN_LABEL]) || labels[RUN_LABEL] !== identity.runId) throw new CleanupError('cleanup_identity_mismatch');
}
export function itemKey(item) {
  switch (item.type) {
    case 'kubernetes': return `kubernetes:${item.namespace}:${item.kind}:${item.name}:${item.uid}`;
    case 'control-plane': return `control-plane:${item.resourceType}:${item.id}`;
    case 'process': return `process:${item.pid}:${item.startedAt}:${item.commandSha256}`;
    case 'file': return `file:${item.path}`;
    default: throw new CleanupError('cleanup_invalid_state');
  }
}
export function parseBaseRequest(value) {
  if (!isRecord(value) || !isRecord(value.state)) return { request: parseStepRequest(value, 'cleanup'), rawInventory: [] };
  const rawInventory = Object.hasOwn(value.state, 'cleanupInventory') ? value.state.cleanupInventory : [];
  const request = parseStepRequest({ ...value, state: { ...value.state, cleanupInventory: [] } }, 'cleanup');
  return { request, rawInventory };
}
function parseInventoryItem(item, request) {
  if (isRecord(item) && item.type === 'control-plane') {
    if (!exactKeys(item, ['type', 'resourceType', 'id', 'organizationId', 'projectId']) || !CONTROL_TYPES.has(item.resourceType)
      || ![item.id, item.organizationId, item.projectId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value))) throw new CleanupError('cleanup_invalid_state');
    return item;
  }
  return parseStepRequest({ ...request, state: { ...request.state, cleanupInventory: [item] } }, 'cleanup').state.cleanupInventory[0];
}
export function parseInventoryItems(rawInventory, request) {
  const candidates = Array.isArray(rawInventory) ? rawInventory : [rawInventory];
  const inventory = [];
  const failures = [];
  const known = new Set();
  for (const [index, item] of candidates.entries()) {
    try {
      const parsed = parseInventoryItem(item, request);
      const key = itemKey(parsed);
      if (known.has(key)) throw new CleanupError('cleanup_identity_mismatch');
      known.add(key); inventory.push(parsed);
    } catch (error) {
      failures.push({ target: `inventory:${index}`, status: 'FAIL', reason: error instanceof EvidenceError ? error.reason : 'cleanup_invalid_state' });
    }
  }
  return { inventory, failures };
}
export function authenticatedClient(item, state) {
  const client = state.authenticatedClient;
  if (!isRecord(client) || typeof client.namespace !== 'string' || typeof client.podName !== 'string' || typeof client.podUid !== 'string') return false;
  if (item.type !== 'kubernetes' || item.namespace !== client.namespace) return false;
  if (item.kind === 'Pod') return item.name === client.podName && item.uid === client.podUid;
  return item.kind === 'NetworkPolicy' && item.name === `${client.podName}-egress`
    && typeof client.networkPolicyUid === 'string' && item.uid === client.networkPolicyUid;
}
export function cleanupOrder(items, state) {
  const priority = (item) => {
    if (item.type === 'control-plane') {
      switch (item.resourceType) {
        case 'preview': return 0;
        case 'attachment': return 1;
        case 'restore-target': return 2;
        case 'backup': return 3;
        case 'resource': return 4;
        case 'project': return 5;
        default: throw new CleanupError('cleanup_invalid_state');
      }
    }
    if (!authenticatedClient(item, state)) return 6;
    return item.kind === 'Pod' ? 7 : 8;
  };
  return [...items].sort((left, right) => priority(left) - priority(right) || itemKey(left).localeCompare(itemKey(right)));
}
export function controlPath(item) {
  if (item.type !== 'control-plane' || !CONTROL_TYPES.has(item.resourceType) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(item.id)) throw new CleanupError('cleanup_invalid_state');
  switch (item.resourceType) {
    case 'preview': return `/api/deployments/${encodeURIComponent(item.id)}`;
    case 'resource': case 'restore-target': return `/api/resources/${encodeURIComponent(item.id)}`;
    case 'backup': return `/api/backups/${encodeURIComponent(item.id)}`;
    case 'project': return `/api/projects/${encodeURIComponent(item.id)}`;
    case 'attachment': throw new CleanupError('cleanup_unsupported');
    default: throw new CleanupError('cleanup_invalid_state');
  }
}

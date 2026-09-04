import { encodeKeysetCursor } from './store-helpers.ts';
import { OBSERVABILITY_RESPONSE_BYTES, sanitizeObservationLine, sanitizeObservationRecord, type RedactionState } from './observability-redaction.ts';

type PublicRow = Record<string, unknown>;
type ContinuationData = { readonly sources: Map<string, RedactionState> };
export type ObservationLogContext = { readonly source: string; readonly rows: readonly PublicRow[]; readonly complete: boolean };
type ProjectionOptions = {
  readonly continuation?: ObservationProjectionContinuation;
  readonly unknownLogState?: boolean;
  // Context is request-local only.  The continuation retains only {v,pem} after a row is sent.
  readonly logContexts?: readonly ObservationLogContext[];
};

const MAX_LOG_SOURCES = 128;
const marker = '****';
const continuationData = new WeakMap<object, ContinuationData>();

// The public token is opaque; its only mutable data is retained in this module.
export type ObservationProjectionContinuation = { readonly v: 1 };

export function createObservationProjectionContinuation(): ObservationProjectionContinuation {
  const continuation: ObservationProjectionContinuation = { v: 1 };
  continuationData.set(continuation, { sources: new Map() });
  return continuation;
}

export function clearObservationProjectionContinuation(continuation: ObservationProjectionContinuation): void {
  continuationData.get(continuation)?.sources.clear();
}

export function maskedObservationRows(rows: readonly PublicRow[], options: ProjectionOptions = {}): PublicRow[] {
  const state = projectionState(options.continuation);
  const result: PublicRow[] = [];
  let bytes = 2;
  for (const row of rows.slice(0, 1000)) {
    const before = snapshotSources(state.sources);
    const clean = sanitizeLogRow(row, state, options.unknownLogState === true);
    if (!clean) continue;
    const size = Buffer.byteLength(JSON.stringify(clean)) + 1;
    if (bytes + size > OBSERVABILITY_RESPONSE_BYTES - 4096) {
      restoreSources(state.sources, before);
      break;
    }
    result.push(clean);
    bytes += size;
  }
  return result;
}

// Reserve framing bytes and make the state transition only for the complete-row prefix.
export function projectObservationPayload(payload: PublicRow, options: ProjectionOptions = {}): PublicRow {
  const result: PublicRow = {};
  const rowKeys = ['logs', 'events'] as const;
  const state = projectionState(options.continuation);
  const unknownLogState = options.unknownLogState === true || payload.logContinuationUnknown === true || Boolean(payload.logCursor);
  const contextStates = logContextStates(options.logContexts);
  for (const [key, value] of Object.entries(payload).slice(0, 64)) {
    if (key === 'logContinuationUnknown') continue;
    result[key] = rowKeys.some(rowKey => rowKey === key) ? [] : sanitizeObservationRecord(value);
  }
  const limit = OBSERVABILITY_RESPONSE_BYTES - 1024;
  for (const key of ['service', 'deployment']) {
    if (Buffer.byteLength(JSON.stringify(result)) > limit) result[key] = null;
  }
  for (const key of rowKeys) {
    const source = payload[key];
    if (!Array.isArray(source)) continue;
    const rows: PublicRow[] = [];
    result[key] = rows;
    const cursorKey = key === 'logs' ? 'logCursor' : 'eventCursor';
    const paginated = Object.hasOwn(payload, 'nextCursor');
    result[paginated ? 'nextCursor' : cursorKey] = paginated ? null : payload[cursorKey] ?? null;
    for (const value of source.slice(0, 1000)) {
      const before = key === 'logs' ? snapshotSources(state.sources) : null;
      const clean = key === 'logs' ? sanitizeLogRow(value, state, unknownLogState, contextStates) : publicRecord(value);
      if (!clean) continue;
      const cursor = encodeKeysetCursor(clean);
      rows.push(clean);
      const previous = result[paginated ? 'nextCursor' : cursorKey];
      result[paginated ? 'nextCursor' : cursorKey] = cursor;
      if (Buffer.byteLength(JSON.stringify(result)) > limit) {
        rows.pop();
        result[paginated ? 'nextCursor' : cursorKey] = previous;
        if (before) restoreSources(state.sources, before);
        break;
      }
    }
  }
  return result;
}

function projectionState(continuation: ObservationProjectionContinuation | undefined): ContinuationData {
  if (!continuation) return { sources: new Map() };
  const existing = continuationData.get(continuation);
  if (existing) return existing;
  const created: ContinuationData = { sources: new Map() };
  continuationData.set(continuation, created);
  return created;
}

function sanitizeLogRow(value: unknown, state: ContinuationData, unknownLogState: boolean, contextStates: ReadonlyMap<string, RedactionState> = new Map()): PublicRow | null {
  const clean = publicRecord(value);
  if (!clean) return null;
  if (!isPublicRow(value) || typeof value.line !== 'string') return clean;
  const source = observationLogSource(value);
  if (!source) return { ...clean, line: marker };
  const current = state.sources.get(source) || contextStates.get(source);
  if (!current && state.sources.size >= MAX_LOG_SOURCES) return { ...clean, line: marker };
  const line = sanitizeObservationLine(value.line, current || { v: 1, pem: unknownLogState });
  state.sources.set(source, line.state);
  return { ...clean, line: line.line };
}

function publicRecord(value: unknown): PublicRow | null {
  const clean = sanitizeObservationRecord(value);
  return isPublicRow(clean) ? clean : null;
}

function isPublicRow(value: unknown): value is PublicRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function observationLogSource(row: PublicRow): string | null {
  const serviceId = boundedIdentity(row.serviceId);
  if (serviceId) {
    const deploymentId = boundedIdentity(row.deploymentId);
    const podUid = boundedIdentity(row.podUid);
    const containerName = boundedIdentity(row.containerName);
    return deploymentId && podUid && containerName ? `runtime:${serviceId}:${deploymentId}:${podUid}:${containerName}` : null;
  }
  const deploymentId = boundedIdentity(row.deploymentId);
  const step = boundedIdentity(row.step);
  return deploymentId && step ? `build:${deploymentId}:${step}` : null;
}

export function persistedRuntimePodUid(row: PublicRow): string {
  const podUid = boundedIdentity(row.podUid);
  const sourceInstanceId = boundedIdentity(row.sourceInstanceId);
  if (podUid && sourceInstanceId && podUid !== sourceInstanceId) throw new Error('runtime log immutable source instance is ambiguous');
  const identity = sourceInstanceId || podUid;
  if (!identity) throw new Error('runtime log writer requires an immutable source instance ID');
  return identity;
}

function logContextStates(contexts: readonly ObservationLogContext[] | undefined): Map<string, RedactionState> {
  const states = new Map<string, RedactionState>();
  for (const context of contexts?.slice(0, MAX_LOG_SOURCES) || []) {
    if (!context || !Array.isArray(context.rows)) continue;
    const source = typeof context.source === 'string' && context.source.length <= 1200 ? context.source : null;
    if (!source || states.has(source)) continue;
    if (!context.complete) {
      states.set(source, { v: 1, pem: true });
      continue;
    }
    let state: RedactionState = { v: 1, pem: false };
    for (const row of context.rows.slice(0, 1000)) {
      if (typeof row.line !== 'string') continue;
      state = sanitizeObservationLine(row.line, state).state;
    }
    states.set(source, state);
  }
  return states;
}

function boundedIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const identity = value.trim();
  return identity.length > 0 && identity.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(identity) ? identity : null;
}

function snapshotSources(sources: Map<string, RedactionState>): Map<string, RedactionState> {
  return new Map(sources);
}

function restoreSources(sources: Map<string, RedactionState>, snapshot: Map<string, RedactionState>): void {
  sources.clear();
  for (const [source, state] of snapshot) sources.set(source, state);
}

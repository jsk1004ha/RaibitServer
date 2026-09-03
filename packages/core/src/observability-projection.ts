import { encodeKeysetCursor } from './store-helpers.ts';
import { OBSERVABILITY_RESPONSE_BYTES, sanitizeObservationRecord } from './observability-redaction.ts';

type PublicRow = Record<string, unknown>;

export function maskedObservationRows(rows: readonly PublicRow[]): PublicRow[] {
  const result: PublicRow[] = [];
  let bytes = 2;
  for (const row of rows.slice(0, 1000)) {
    const clean = sanitizeObservationRecord(row);
    if (!clean || typeof clean !== 'object' || Array.isArray(clean)) continue;
    const size = Buffer.byteLength(JSON.stringify(clean)) + 1;
    if (bytes + size > OBSERVABILITY_RESPONSE_BYTES - 4096) break;
    result.push(clean);
    bytes += size;
  }
  return result;
}

// Reserve framing bytes as well as serializing only a complete-row prefix.
// The source cursor is never derived from rows that did not reach the caller.
export function projectObservationPayload(payload: PublicRow): PublicRow {
  const result: PublicRow = {};
  const rowKeys = ['logs', 'events'] as const;
  for (const [key, value] of Object.entries(payload).slice(0, 64)) {
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
      const clean = sanitizeObservationRecord(value);
      if (!clean || typeof clean !== 'object' || Array.isArray(clean)) continue;
      const cursor = encodeKeysetCursor(clean);
      rows.push(clean);
      const previous = result[paginated ? 'nextCursor' : cursorKey];
      result[paginated ? 'nextCursor' : cursorKey] = cursor;
      if (Buffer.byteLength(JSON.stringify(result)) > limit) {
        rows.pop();
        result[paginated ? 'nextCursor' : cursorKey] = previous;
        break;
      }
    }
  }
  return result;
}

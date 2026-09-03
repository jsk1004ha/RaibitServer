export const OBSERVABILITY_LINE_BYTES = 16_384;
export const OBSERVABILITY_RESPONSE_BYTES = 524_288;
export type RedactionState = { readonly v: 1; readonly pem: boolean };
export type ObservationValue = null | boolean | number | string | ObservationValue[] | { [key: string]: ObservationValue };

const marker = '****';
const secretName = '(?:[a-z0-9_-]*(?:password|passwd|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|database[_-]?url|mongodb[_-]?uri|redis[_-]?url)|key)';
const assignment = new RegExp('((?:\\\\?["\\x27])?\\b' + secretName + '(?:\\\\?["\\x27])?\\s*[:=]\\s*)(\\\\?"|\\x27)', 'gi');
const bareAssignment = new RegExp('(\\b' + secretName + '\\s*=\\s*)([^\\s"\\x27,;&]+)', 'gi');

// State contains no source bytes and can be atomically persisted beside the source watermark.
export function sanitizeObservationLine(value: string, state: RedactionState = { v: 1, pem: false }) {
  let pem = state.pem;
  const fragments: string[] = [];
  let remaining = value;
  while (remaining) {
    if (pem) {
      const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(remaining);
      fragments.push(marker);
      if (!end) break;
      remaining = remaining.slice(end.index + end[0].length);
      pem = false;
    } else {
      const begin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.exec(remaining);
      if (!begin) { fragments.push(remaining); break; }
      fragments.push(remaining.slice(0, begin.index));
      remaining = remaining.slice(begin.index + begin[0].length);
      pem = true;
      if (!remaining) fragments.push(marker);
    }
  }
  const masked = redactQuotedAssignments(fragments.join(''))
    .replace(/(^|\n)((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi, '$1$2****')
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 ****')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, marker)
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, marker)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s"'<>]*@)/gi, (_match, scheme: string, authority: string) =>
      scheme + (authority.startsWith(':') ? ':****@' : '****:****@'))
    .replace(/([?&](?:[a-z0-9_-]*(?:token|password|passwd|secret|credential|api[_-]?key|access[_-]?key)|key)=)[^&#\s"'<>]*/gi, '$1****')
    .replace(bareAssignment, '$1****');
  return { line: truncateObservationText(masked), state: { v: 1, pem } satisfies RedactionState };
}

function redactQuotedAssignments(value: string): string {
  const fragments: string[] = [];
  let consumed = 0;
  for (const match of value.matchAll(assignment)) {
    if (match.index < consumed) continue;
    const quote = match[2];
    let end = match.index + match[0].length;
    while (true) {
      end = value.indexOf(quote, end);
      if (end < 0) break;
      let slashes = 0;
      for (let index = end - 1; index >= 0 && value[index] === '\\'; index--) slashes++;
      const escaped = quote.length === 1 ? slashes % 2 === 1 : slashes % 4 === 2;
      if (!escaped) break;
      end += quote.length;
    }
    fragments.push(value.slice(consumed, match.index), match[1], quote, marker, quote);
    consumed = end < 0 ? value.length : end + quote.length;
  }
  return fragments.join('') + value.slice(consumed);
}

export function truncateObservationText(value: string, limit = OBSERVABILITY_LINE_BYTES): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return value;
  const suffix = ' [truncated]';
  const prefix = bytes.subarray(0, Math.max(0, limit - Buffer.byteLength(suffix))).toString('utf8').replace(/\uFFFD$/, '');
  return prefix + suffix;
}

export function sanitizeObservationRecord(value: unknown): ObservationValue {
  // Includes object keys/structural overhead, so even a wide row fits one response page.
  let remainingNodes = 512;
  let remainingBytes = 65_536;
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): ObservationValue {
    if (--remainingNodes < 0 || remainingBytes <= 0 || depth > 8) return marker;
    if (typeof input === 'string') {
      const result = truncateObservationText(sanitizeObservationLine(input).line, Math.min(OBSERVABILITY_LINE_BYTES, remainingBytes));
      remainingBytes -= Buffer.byteLength(result);
      return result;
    }
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'boolean') return input;
    if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : null;
    if (typeof input !== 'object' || seen.has(input)) return marker;
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 1000).map(item => visit(item, depth + 1));
    const entries = Object.entries(input).slice(0, 64).map(([key, item]) => {
      const cleanKey = truncateObservationText(sanitizeObservationLine(key).line, 256);
      const secret = /(?:password|passwd|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie|authorization)/i.test(key);
      return [cleanKey, secret && item !== null && item !== undefined ? marker : visit(item, depth + 1)] as const;
    });
    return Object.fromEntries(entries);
  }
  return visit(value, 0);
}

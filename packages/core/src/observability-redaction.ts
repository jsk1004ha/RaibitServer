export const OBSERVABILITY_LINE_BYTES = 16_384;
export const OBSERVABILITY_RESPONSE_BYTES = 524_288;
type SecretQuote = '"' | "'" | '\\"' | "\\'";
export type RedactionState = { readonly v: 1; readonly pem: boolean; readonly quote?: SecretQuote; readonly uncertain?: true };
export type ObservationValue = null | boolean | number | string | ObservationValue[] | { [key: string]: ObservationValue };

const marker = '****';
const truncationSuffix = ' [truncated]';
const secretKeyFragments = ['password', 'passwd', 'secret', 'token', 'credential', 'apikey', 'api_key', 'api-key', 'accesskey', 'access_key', 'access-key', 'privatekey', 'private_key', 'private-key', 'databaseurl', 'database_url', 'database-url', 'mongodburi', 'mongodb_uri', 'mongodb-uri', 'redisurl', 'redis_url', 'redis-url'] as const;
const pemBoundary = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g;

// State contains no source bytes and can be atomically persisted beside the source watermark.
export function sanitizeObservationLine(value: string, state: RedactionState = { v: 1, pem: false }) {
  if (state.uncertain) return { line: marker, state };
  const input = boundedObservationInput(value);
  let pem = state.pem;
  const fragments: string[] = [];
  let remaining = input.text;
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
  const assignment = redactAssignments(redactUrlCredentials(fragments.join(''), input.truncated), state.quote);
  let masked = assignment.line
    .replace(/(^|\n)((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi, '$1$2****')
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 ****')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, marker);
  masked = redactJwt(masked, input.truncated);
  for (const boundary of value.matchAll(pemBoundary)) pem = boundary[1] === 'BEGIN';
  const next: RedactionState = { v: 1, pem, ...assignment.state, ...(input.truncated ? { uncertain: true } as const : {}) };
  return { line: truncateObservationText(masked + (input.truncated ? truncationSuffix : '')), state: next };
}

function boundedObservationInput(value: string): { readonly text: string; readonly truncated: boolean } {
  const probe = value.slice(0, OBSERVABILITY_LINE_BYTES + 1);
  const bytes = Buffer.from(probe, 'utf8');
  if (bytes.length <= OBSERVABILITY_LINE_BYTES && probe.length === value.length) return { text: value, truncated: false };
  return {
    text: bytes.subarray(0, OBSERVABILITY_LINE_BYTES).toString('utf8').replace(/\uFFFD$/, ''),
    truncated: true,
  };
}

function isKeyCharacter(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code === 45 || code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSecretKey(value: string): boolean {
  const key = value.toLowerCase();
  return /^(?:--?)?key$/.test(key) || secretKeyFragments.some(fragment => key.includes(fragment));
}

function closingQuoteLength(value: string, index: number): number {
  if (value[index] === '\\' && (value[index + 1] === '"' || value[index + 1] === "'")) return 2;
  return value[index] === '"' || value[index] === "'" ? 1 : 0;
}

function secretQuoteAt(value: string, index: number): SecretQuote | undefined {
  const pair = value.slice(index, index + 2);
  if (pair === '\\"' || pair === "\\'") return pair;
  const single = value[index];
  return single === '"' || single === "'" ? single : undefined;
}

function findClosingQuote(value: string, start: number, quote: SecretQuote): number {
  let end = start;
  while (true) {
    end = value.indexOf(quote, end);
    if (end < 0) return end;
    let slashes = 0;
    for (let slash = end - 1; slash >= start && value[slash] === '\\'; slash--) slashes++;
    const escaped = quote.length === 1 ? slashes % 2 === 1 : slashes % 4 === 2;
    if (!escaped) return end;
    end += quote.length;
  }
}

function redactAssignments(value: string, pending?: SecretQuote): { readonly line: string; readonly state: { readonly quote?: SecretQuote } } {
  const fragments: string[] = [];
  let consumed = 0;
  let index = 0;
  if (pending) {
    const end = findClosingQuote(value, 0, pending);
    if (end < 0) return { line: marker, state: { quote: pending } };
    fragments.push(marker, pending);
    consumed = end + pending.length;
    index = consumed;
  }
  while (index < value.length) {
    if (!isKeyCharacter(value, index)) { index++; continue; }
    const keyStart = index;
    while (index < value.length && isKeyCharacter(value, index)) index++;
    const keyEnd = index;
    if (!isSecretKey(value.slice(keyStart, keyEnd))) continue;
    index += closingQuoteLength(value, index);
    while (index < value.length && /\s/u.test(value[index])) index++;
    const delimiter = value[index];
    if (delimiter !== '=' && delimiter !== ':') { index = keyEnd; continue; }
    index++;
    while (index < value.length && /\s/u.test(value[index])) index++;
    const quote = secretQuoteAt(value, index);
    if (quote) {
      const end = findClosingQuote(value, index + quote.length, quote);
      fragments.push(value.slice(consumed, index), quote, marker, quote);
      if (end < 0) return { line: fragments.join(''), state: { quote } };
      consumed = end + quote.length;
      index = consumed;
      continue;
    }
    if (delimiter === ':') { index = keyEnd; continue; }
    const valueStart = index;
    const queryKey = value[keyStart - 1] === '?' || value[keyStart - 1] === '&';
    const terminator = queryKey ? /[\s"'&]/u : /[\s"',;&]/u;
    while (index < value.length && !terminator.test(value[index])) index++;
    if (index === valueStart && !queryKey) { index = keyEnd; continue; }
    fragments.push(value.slice(consumed, valueStart), marker);
    consumed = index;
  }
  return { line: fragments.join('') + value.slice(consumed), state: {} };
}

function isWordCharacter(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function redactJwt(value: string, sourceTruncated: boolean): string {
  const fragments: string[] = [];
  let consumed = 0;
  let search = 0;
  while (search < value.length) {
    const start = value.indexOf('eyJ', search);
    if (start < 0) break;
    if (start > 0 && isWordCharacter(value, start - 1)) { search = start + 3; continue; }
    let end = start + 3;
    while (end < value.length && isKeyCharacter(value, end)) end++;
    if (end === start + 3 || value[end] !== '.') {
      if (sourceTruncated && end === value.length) {
        fragments.push(value.slice(consumed, start), marker);
        consumed = value.length;
      }
      search = Math.max(end, start + 3);
      continue;
    }
    end++;
    const second = end;
    while (end < value.length && isKeyCharacter(value, end)) end++;
    if (end === second || value[end] !== '.') {
      if (sourceTruncated && end === value.length) {
        fragments.push(value.slice(consumed, start), marker);
        consumed = value.length;
      }
      search = Math.max(end, start + 3);
      continue;
    }
    end++;
    const third = end;
    while (end < value.length && isKeyCharacter(value, end)) end++;
    if (end === third) { search = start + 3; continue; }
    fragments.push(value.slice(consumed, start), marker);
    consumed = end;
    search = end;
  }
  return fragments.join('') + value.slice(consumed);
}

function isSchemeCharacter(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code === 43 || code === 45 || code === 46 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function redactUrlCredentials(value: string, sourceTruncated: boolean): string {
  const fragments: string[] = [];
  let consumed = 0;
  let search = 0;
  while (search < value.length) {
    const delimiter = value.indexOf('://', search);
    if (delimiter < 0) break;
    let schemeStart = delimiter;
    while (schemeStart > 0 && isSchemeCharacter(value, schemeStart - 1)) schemeStart--;
    while (schemeStart < delimiter && !/[A-Za-z]/u.test(value[schemeStart])) schemeStart++;
    if (schemeStart === delimiter || (schemeStart > 0 && isWordCharacter(value, schemeStart - 1))) {
      search = delimiter + 3;
      continue;
    }
    const authorityStart = delimiter + 3;
    let authorityEnd = authorityStart;
    let at = -1;
    while (authorityEnd < value.length && !/[/\s"'<>]/u.test(value[authorityEnd])) {
      if (value[authorityEnd] === '@') at = authorityEnd;
      authorityEnd++;
    }
    if (at >= authorityStart) {
      fragments.push(value.slice(consumed, authorityStart), value[authorityStart] === ':' ? ':****@' : '****:****@');
      consumed = at + 1;
    } else if (sourceTruncated && authorityEnd === value.length) {
      fragments.push(value.slice(consumed, authorityStart), marker);
      consumed = value.length;
    }
    search = Math.max(authorityEnd, delimiter + 3);
  }
  return fragments.join('') + value.slice(consumed);
}

export function truncateObservationText(value: string, limit = OBSERVABILITY_LINE_BYTES): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return value;
  const prefix = bytes.subarray(0, Math.max(0, limit - Buffer.byteLength(truncationSuffix))).toString('utf8').replace(/\uFFFD$/, '');
  return prefix + truncationSuffix;
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

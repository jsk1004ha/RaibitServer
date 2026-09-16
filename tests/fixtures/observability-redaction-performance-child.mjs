import { sanitizeObservationLine } from '../../packages/core/src/observability-redaction.ts';

const size = Number.parseInt(process.argv[2] ?? '', 10);
const mode = process.argv[3] ?? 'assignment';
const prefix = mode === 'query' ? 'https://example.test/?' : '';
const repeated = mode === 'jwt' ? 'eyJ-'.repeat(size) : 'PASSWORD-'.repeat(size);
const suffix = mode === 'uri' ? '! https://example.test/path' : '!';
const input = `${prefix}${repeated}${suffix}`;
const iterations = mode === 'uri' || mode === 'jwt' ? 128 : 1;
const startedAt = performance.now();
let result = sanitizeObservationLine(input);
for (let iteration = 1; iteration < iterations; iteration++) result = sanitizeObservationLine(input);

process.stdout.write(`${JSON.stringify({
  size,
  elapsedMs: performance.now() - startedAt,
  inputBytes: Buffer.byteLength(input),
  iterations,
  outputMatches: result.line === input,
  state: result.state,
  execPath: process.execPath,
})}\n`);

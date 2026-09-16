import crypto from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { sanitizeObservationLine, type RedactionState } from './observability-redaction.ts';

const unknownState: RedactionState = { v: 1, pem: false, uncertain: true };
const initialState: RedactionState = { v: 1, pem: false };
const memoryStates = new WeakMap<object, Map<string, RedactionState>>();

// Core remains importable without database-only dependencies in CLI/isolated builds.
function parseObservationState(raw: string): RedactionState {
  const input: unknown = JSON.parse(raw);
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || !('v' in input) || input.v !== 1 || !('pem' in input) || typeof input.pem !== 'boolean'
    || Object.keys(input).some(key => !['v', 'pem', 'quote', 'uncertain'].includes(key))) return unknownState;
  const quote = 'quote' in input ? input.quote : undefined;
  const uncertain = 'uncertain' in input ? input.uncertain : undefined;
  if (quote !== undefined && quote !== '"' && quote !== "'" && quote !== '\\"' && quote !== "\\'") return unknownState;
  if (uncertain !== undefined && uncertain !== true) return unknownState;
  return { v: 1, pem: input.pem, ...(quote === '"' || quote === "'" || quote === '\\"' || quote === "\\'" ? { quote } : {}), ...(uncertain ? { uncertain: true } as const : {}) };
}

export function maskMemoryObservationLine(owner: object, identity: readonly (string | null)[], value: string): string {
  const key = JSON.stringify(identity);
  const sources = memoryStates.get(owner) ?? new Map<string, RedactionState>();
  if (!memoryStates.has(owner)) memoryStates.set(owner, sources);
  if (!sources.has(key) && sources.size >= 1024) return '****';
  const result = sanitizeObservationLine(value, sources.get(key) ?? initialState);
  sources.set(key, result.state);
  return result.line;
}

type ObservationWrite =
  | { readonly kind: 'runtime'; readonly data: Prisma.RuntimeLogUncheckedCreateInput }
  | { readonly kind: 'build'; readonly data: Prisma.BuildLogUncheckedCreateInput };

// Lock, insert, and finite continuation checkpoint share one database transaction.
export async function appendPrismaObservationLog(prisma: PrismaClient, input: ObservationWrite) {
  const scope = input.kind === 'runtime'
    ? [input.kind, input.data.serviceId, input.data.deploymentId ?? null, input.data.podUid, input.data.containerName]
    : [input.kind, input.data.deploymentId, input.data.step];
  const key = 'ts-log-state:' + crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`INSERT INTO "IngestionCursor" (key,cursor,"updatedAt") VALUES (${key},'',CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING`;
    const cursors = await transaction.$queryRaw<{ readonly cursor: string }[]>`SELECT cursor FROM "IngestionCursor" WHERE key=${key} FOR UPDATE`;
    let state = unknownState;
    const cursor = cursors[0]?.cursor;
    if (cursor === '') {
      const existing = input.kind === 'runtime'
        ? await transaction.runtimeLog.findFirst({ where: { serviceId: input.data.serviceId, deploymentId: input.data.deploymentId ?? null, podUid: input.data.podUid, containerName: input.data.containerName }, select: { id: true } })
        : await transaction.buildLog.findFirst({ where: { deploymentId: input.data.deploymentId, step: input.data.step }, select: { id: true } });
      if (!existing) state = initialState;
    } else if (cursor && cursor.length <= 256) {
      try {
        state = parseObservationState(cursor);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const result = sanitizeObservationLine(input.data.line, state);
    const row = input.kind === 'runtime'
      ? await transaction.runtimeLog.create({ data: { ...input.data, line: result.line } })
      : await transaction.buildLog.create({ data: { ...input.data, line: result.line } });
    await transaction.ingestionCursor.update({ where: { key }, data: { cursor: JSON.stringify(result.state) } });
    return row;
  });
}

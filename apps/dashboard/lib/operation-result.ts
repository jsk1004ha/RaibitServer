import { ResourceProvisionResultSchema } from '@raibitserver/schemas';

export type OperationResult = Readonly<{
  operationId: string;
  deploymentId?: string;
  status?: string;
  streamHref?: string;
}>;

type ResourcePlanResult = Extract<ReturnType<typeof ResourceProvisionResultSchema.parse>, Readonly<{ intent: 'preview-plan' }>>;

export type OperationSuccess =
  | Readonly<{ kind: 'operation'; result: OperationResult }>
  | Readonly<{ kind: 'resource-plan'; result: ResourcePlanResult }>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function safeText(value: unknown, fallback: string, limit = 280): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, limit) : fallback;
}

export function operationResult(payload: unknown, successKind: OperationSuccess['kind'] = 'operation'): OperationSuccess | null {
  const record = asRecord(payload);
  const operationId = safeText(record?.operationId, '', 200);
  if (operationId) {
    const statusValue = record?.status ?? record?.state;
    const status = typeof statusValue === 'string' ? safeText(statusValue, '', 80) : undefined;
    const streamHref = typeof record?.streamHref === 'string' ? record.streamHref : undefined;
    const deployment = asRecord(record?.deployment);
    const deploymentId = safeText(deployment?.id, '', 200);
    return { kind: 'operation', result: { operationId, ...(deploymentId ? { deploymentId } : {}), ...(status ? { status } : {}), ...(streamHref ? { streamHref } : {}) } };
  }
  if (successKind !== 'resource-plan') return null;
  const parsed = ResourceProvisionResultSchema.safeParse(record?.result);
  return parsed.success && parsed.data.intent === 'preview-plan' ? { kind: 'resource-plan', result: parsed.data } : null;
}

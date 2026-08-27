import { getJson, publicDashboardApiContext, type DashboardApiContext, type DashboardApiResult } from './api';
import { createSystemStatusSnapshot } from './status-model.js';

export type SystemStatusTone = 'operational' | 'degraded' | 'outage';

export type SystemStatusComponent = {
  id: string;
  name: string;
  detail: string;
  status: SystemStatusTone;
  latencyMs: number | null;
};

export type SystemStatusSnapshot = {
  schemaVersion: 1;
  status: SystemStatusTone;
  checkedAt: string;
  refreshIntervalSeconds: number;
  components: SystemStatusComponent[];
};

export async function loadSystemStatus(): Promise<SystemStatusSnapshot> {
  const context = publicDashboardApiContext();
  const [api, data] = await Promise.all([
    timedGet('/health', { status: 'offline' }, context),
    timedGet('/public/sites?limit=1', { sites: [] }, context),
  ]);

  return createSystemStatusSnapshot({
    apiResult: api.result,
    dataResult: data.result,
    apiLatencyMs: api.latencyMs,
    dataLatencyMs: data.latencyMs,
    checkedAt: new Date().toISOString(),
  }) as SystemStatusSnapshot;
}

async function timedGet(path: string, fallback: unknown, context: DashboardApiContext): Promise<{ result: DashboardApiResult; latencyMs: number }> {
  const startedAt = performance.now();
  const result = await getJson(path, fallback, context);
  return { result, latencyMs: performance.now() - startedAt };
}

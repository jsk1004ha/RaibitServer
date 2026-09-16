import { LIFECYCLE_CONTRACT } from './lifecycle.ts';
import { parseHealthPaths } from '@raibitserver/schemas/deployment-health-contract';

export { HEALTH_FAILURE_CODES, HEALTH_PATH_FIELDS, HealthPathError, isSafeHealthPath, parseHealthPaths, serviceHealthInput } from '@raibitserver/schemas/deployment-health-contract';
export const INITIAL_DEPLOYMENT_HEALTH = Object.freeze({ publicHealthStatus: LIFECYCLE_CONTRACT.machines.health.initial, healthCheckedAt: null, healthFailureCode: null, observedGeneration: null });
export function publicDeploymentHealth<T extends Readonly<Record<string, unknown>>>(row: T) {
  return { ...INITIAL_DEPLOYMENT_HEALTH, ...row, publicHealthStatus: row.publicHealthStatus ?? INITIAL_DEPLOYMENT_HEALTH.publicHealthStatus };
}

export function servingDeploymentForHealth<T extends Readonly<Record<string, unknown>>>(deployments: readonly T[], lineage?: Readonly<Record<string, unknown>> | null): T | null {
  if (lineage?.currentDeploymentId) return deployments.find(deployment => deployment.id === lineage.currentDeploymentId && deployment.previewLineageId === lineage.id && deployment.previewGeneration === lineage.currentGeneration) ?? null;
  return deployments.find(deployment => String(deployment.deploymentType || '').toLowerCase() !== 'preview' && String(deployment.status || '').toUpperCase() === 'READY') ?? null;
}

export function serviceHealthProbes(service: Readonly<Record<string, unknown>>, port: number) {
  if (String(service.type || 'web').toLowerCase() !== 'web') return {};
  const paths = parseHealthPaths(service);
  const common = paths.healthCheckPath;
  const probe = (path: unknown, failureThreshold: number) => ({ ...(typeof path === 'string' ? { httpGet: { path, port } } : { tcpSocket: { port } }), initialDelaySeconds: 5, periodSeconds: 10, timeoutSeconds: 2, failureThreshold });
  return { startupProbe: probe(common || paths.readinessPath, 30), readinessProbe: probe(paths.readinessPath || common, 3), livenessProbe: probe(paths.livenessPath || common, 3) };
}

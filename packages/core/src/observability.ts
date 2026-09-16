import { nowIso, stableId } from './ids.ts';
import { sanitizeLogRecord } from './security.ts';
export { sanitizeObservationLine, sanitizeObservationRecord, OBSERVABILITY_LINE_BYTES, OBSERVABILITY_RESPONSE_BYTES } from './observability-redaction.ts';

export function deploymentEvent({ organizationId, projectId, serviceId, deploymentId, type, message, metadata = {} }) {
  return {
    id: stableId('evt', organizationId, projectId, serviceId, deploymentId, type, Date.now()),
    organizationId,
    projectId,
    serviceId,
    deploymentId,
    type,
    message,
    metadata: sanitizeLogRecord(metadata),
    createdAt: nowIso(),
  };
}

export function metricSeries(service) {
  return [
    { name: 'cpu_usage', unit: 'cores', target: service.name },
    { name: 'memory_usage', unit: 'bytes', target: service.name },
    { name: 'network_in', unit: 'bytes', target: service.name },
    { name: 'network_out', unit: 'bytes', target: service.name },
    { name: 'request_count', unit: 'requests', target: service.name },
    { name: 'error_rate', unit: 'ratio', target: service.name },
    { name: 'response_time_p95', unit: 'ms', target: service.name },
  ];
}

export function alertPolicies() {
  return [
    { code: 'deploy_failed', channelDefaults: ['email', 'discord', 'slack'], severity: 'high' },
    { code: 'app_crash_loop', channelDefaults: ['email', 'discord', 'slack'], severity: 'high' },
    { code: 'db_storage_exceeded', channelDefaults: ['email'], severity: 'critical' },
    { code: 'memory_limit_exceeded', channelDefaults: ['email', 'discord'], severity: 'medium' },
    { code: 'domain_verification_failed', channelDefaults: ['email'], severity: 'medium' },
    { code: 'tls_renewal_failed', channelDefaults: ['email'], severity: 'critical' },
    { code: 'backup_failed', channelDefaults: ['email', 'slack'], severity: 'high' },
  ];
}

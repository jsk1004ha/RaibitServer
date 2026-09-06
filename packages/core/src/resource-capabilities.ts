// Generated package-local snapshot; canonical authority is test-fixtures/contracts.
import contract from './resource-capabilities-v1.json' with { type: 'json' };

export type ResourceEnvironment = 'local' | 'release';
export type ResourceOperation = keyof (typeof contract.engines)[number]['local'];
export const RESOURCE_CAPABILITIES = Object.freeze(contract.engines.map((entry) => Object.freeze({
  ...entry,
  aliases: Object.freeze(entry.aliases),
  local: Object.freeze(entry.local),
  release: Object.freeze(entry.release),
  planOnly: Object.freeze(entry.planOnly),
  liveEvidence: Object.freeze(entry.liveEvidence),
})));

export function resourceCapability(engine: string) {
  const normalized = engine.trim().toLowerCase().replaceAll('_', '-');
  return RESOURCE_CAPABILITIES.find((entry) => entry.engine === normalized || entry.aliases.some((alias) => alias === normalized));
}

export class ResourceCapabilityUnavailable extends Error {
  readonly statusCode = 400;
  readonly code = 'RESOURCE_CAPABILITY_UNAVAILABLE';
  readonly reasonCode: string;

  constructor(engine: string, operation: ResourceOperation, environment: ResourceEnvironment, reason?: string) {
    const capability = resourceCapability(engine);
    const reasonCode = reason ?? capability?.reasonCode ?? 'ENGINE_NOT_IMPLEMENTED';
    super(`RESOURCE_CAPABILITY_UNAVAILABLE: ${engine}/${environment}/${operation}: ${reasonCode} — ${capability?.reasonKo ?? '준비 중 · 지원하지 않는 엔진'}`);
    this.reasonCode = reasonCode;
  }
}

export function requireResourceCapability(engine: string, operation: ResourceOperation, environment: ResourceEnvironment = 'local') {
  const capability = resourceCapability(engine);
  if (!capability?.[environment][operation]) throw new ResourceCapabilityUnavailable(engine, operation, environment);
  return capability;
}

export function resourceCapabilityHelp() {
  return RESOURCE_CAPABILITIES.map((entry) => `  ${entry.engine}: ${entry.reasonKo}`).join('\n');
}

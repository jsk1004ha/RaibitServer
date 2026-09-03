import { requireResourceCapability, ResourceCapabilityUnavailable, resourceCapability, type ResourceEnvironment } from './resource-capabilities.ts';

type OperatorEnvironment = Readonly<Record<string, string | undefined>>;
export type ResourceIntent = 'preview-plan' | 'live-provision';
export type ResourceExecution = Readonly<{ intent: 'live-provision'; environment: ResourceEnvironment; image?: string }>;

export class ResourceIntentInvalid extends Error {
  readonly statusCode = 400;
  readonly code = 'RESOURCE_INTENT_INVALID';
  constructor() { super('Select exactly one resource intent: preview-plan or live-provision.'); }
}

export function resourceEnvironment(env: OperatorEnvironment = process.env): ResourceEnvironment {
  const environment = env.RAIBITSERVER_RESOURCE_ENVIRONMENT;
  if (environment !== 'local' && environment !== 'release') {
    throw new ResourceCapabilityUnavailable('configuration', 'provision', 'release', 'RESOURCE_ENVIRONMENT_UNAVAILABLE');
  }
  return environment;
}

export function requireResourceExecution(engine: string, env: OperatorEnvironment = process.env): ResourceExecution {
  const environment = resourceEnvironment(env);
  const capability = requireResourceCapability(engine, 'provision', environment);
  if (capability.runtime === 'sqlite-local') return { intent: 'live-provision', environment };
  const image = env[`RAIBITSERVER_PROVIDER_${capability.engine.toUpperCase()}_IMAGE`];
  if (!image || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new ResourceCapabilityUnavailable(engine, 'provision', environment, 'PROVIDER_IMAGE_UNAVAILABLE');
  }
  return { intent: 'live-provision', environment, image };
}

export function parseResourceIntent(input: Readonly<Record<string, unknown>>): ResourceIntent {
  if (Object.keys(input).some(key => key !== 'intent')) throw new ResourceIntentInvalid();
  switch (input.intent) {
    case 'preview-plan': return 'preview-plan';
    case 'live-provision': return 'live-provision';
    default: throw new ResourceIntentInvalid();
  }
}

export function resourceAvailability(engine: string, env: OperatorEnvironment = process.env) {
  const capability = resourceCapability(engine);
  try {
    const execution = requireResourceExecution(engine, env);
    return { environment: execution.environment, live: true, preview: capability?.local.provision === true, reasonCode: capability?.reasonCode ?? 'LOCAL_ONLY' };
  } catch (error) {
    if (!(error instanceof ResourceCapabilityUnavailable)) throw error;
    return { environment: env.RAIBITSERVER_RESOURCE_ENVIRONMENT ?? 'unconfigured', live: false, preview: capability?.local.provision === true, reasonCode: error.reasonCode };
  }
}

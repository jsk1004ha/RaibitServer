/** Only a server-side caller can hold this token; JSON cannot opt into runtime writes. */
export const INTERNAL_SERVICE_MUTATION = Symbol('internal-service-mutation');
export { SERVICE_SETTINGS_LIMITS, DesiredStateMutationError, assertServiceReplacement, parseProjectMutation, parseResourceMutation, parseServiceMutation, serviceMutationState } from '@raibitserver/schemas/desired-state-validation';

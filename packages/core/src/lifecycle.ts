import fixture from './lifecycle-v1.json' with { type: 'json' };

// Generated data is checked byte-for-byte against the canonical contract by
// scripts/sync-lifecycle-contract.mjs; core intentionally has no schema dependency.
for (const machine of Object.values(fixture.machines)) {
  for (const state of Object.values(machine.states)) {
    Object.freeze(state.next);
    Object.freeze(state);
  }
  Object.freeze(machine.states);
  Object.freeze(machine.aliases);
  Object.freeze(machine);
}
export const LIFECYCLE_CONTRACT = fixture;
export type DeploymentStatus = keyof typeof fixture.machines.deployment.states;
export type WorkflowStatus = keyof typeof fixture.machines.workflow.states;

export class LifecycleStatusError extends Error {
  constructor(machine: string, value: string) {
    super(`Invalid ${machine} status: ${value}`);
    this.name = 'LifecycleStatusError';
  }
}

function isDeploymentStatus(value: string): value is DeploymentStatus {
  return Object.hasOwn(fixture.machines.deployment.states, value);
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return Object.hasOwn(fixture.machines.workflow.states, value);
}

export function parseDeploymentStatus(input: unknown): DeploymentStatus {
  const key = String(input ?? fixture.machines.deployment.initial).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Readonly<Record<string, string>> = fixture.machines.deployment.aliases;
  const value = Object.hasOwn(aliases, key) ? aliases[key] : key === 'queued' || key === '' ? 'queued' : key.toUpperCase();
  if (!isDeploymentStatus(value)) throw new LifecycleStatusError('deployment', value);
  return value;
}

export function parseWorkflowStatus(input: unknown): WorkflowStatus {
  const key = String(input ?? fixture.machines.workflow.initial).trim().toLowerCase();
  const aliases: Readonly<Record<string, string>> = fixture.machines.workflow.aliases;
  const value = Object.hasOwn(aliases, key) ? aliases[key] : key || 'queued';
  if (!isWorkflowStatus(value)) throw new LifecycleStatusError('workflow', value);
  return value;
}

export function terminalLifecycleInputs(
  states: Readonly<Record<string, Readonly<{ terminal: boolean }>>>,
  aliases: Readonly<Record<string, string>>,
): readonly string[] {
  const canonical = Object.entries(states).filter(([, state]) => state.terminal).map(([status]) => status);
  const legacy = Object.entries(aliases).filter(([, status]) => states[status].terminal).map(([alias]) => alias);
  return [...new Set([...canonical, ...legacy].flatMap(status => [status, status.toLowerCase(), status.toUpperCase()]))];
}

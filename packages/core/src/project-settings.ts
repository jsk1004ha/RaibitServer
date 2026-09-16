export type ProjectSettingsMutation = {
  readonly projectId: string;
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly expectedUpdatedAt: string;
  readonly name?: string;
  readonly description?: string;
};

export type ProjectDeletionRequest = {
  readonly projectId: string;
  readonly organizationId: string;
  readonly actorUserId: string | null;
};

export class ProjectSettingsError extends Error {
  readonly name = 'ProjectSettingsError';
  readonly statusCode = 409;
  readonly code = 'STALE_PROJECT';

  constructor() {
    super('STALE_PROJECT');
  }
}

export function parseProjectSettingsUpdate(value: unknown): Omit<ProjectSettingsMutation, 'projectId' | 'organizationId' | 'actorUserId'> {
  const input = strictRecord(value, ['name', 'description', 'expectedUpdatedAt']);
  const expectedUpdatedAt = input.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt))) throw new ProjectSettingsInputError();
  if (input.name !== undefined && typeof input.name !== 'string') throw new ProjectSettingsInputError();
  if (input.description !== undefined && typeof input.description !== 'string') throw new ProjectSettingsInputError();
  if (input.name === undefined && input.description === undefined) throw new ProjectSettingsInputError();
  return {
    expectedUpdatedAt,
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  };
}

export function parseProjectDeletionConfirmation(value: unknown): void {
  const input = strictRecord(value, ['confirmed']);
  if (input.confirmed !== true) throw new ProjectSettingsInputError();
}

export function nextProjectUpdatedAt(current: string): string {
  return new Date(Math.max(Date.now(), Date.parse(current) + 1)).toISOString();
}

export function projectSettingsView(
  project: Record<string, unknown>,
  impact: { readonly services: number; readonly resources: number; readonly previews: number },
) {
  const updatedAt = isoTimestamp(project.updatedAt);
  return {
    project: {
      id: String(project.id),
      organizationId: String(project.organizationId),
      name: String(project.name),
      slug: String(project.slug),
      description: String(project.description ?? ''),
      status: String(project.status),
      updatedAt,
      deletionRequestedAt: project.deletionRequestedAt ? isoTimestamp(project.deletionRequestedAt) : null,
    },
    snapshot: { updatedAt },
    deletionImpact: impact,
  };
}

export function scheduledProjectDeletion(project: Record<string, unknown>): {
  readonly projectId: string;
  readonly status: 'DELETE_REQUESTED' | 'DELETING';
  readonly deletionRequestedAt: string;
  readonly scheduled: true;
} {
  const status = String(project.status).toUpperCase();
  switch (status) {
    case 'DELETE_REQUESTED':
    case 'DELETING':
      return {
        projectId: String(project.id),
        status,
        deletionRequestedAt: isoTimestamp(project.deletionRequestedAt),
        scheduled: true,
      };
    default:
      throw new ProjectSettingsInputError();
  }
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

class ProjectSettingsInputError extends Error {
  readonly name = 'ProjectSettingsInputError';
  readonly statusCode = 400;

  constructor() {
    super('INVALID_PROJECT_SETTINGS');
  }
}

function strictRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectSettingsInputError();
  const input = Object.fromEntries(Object.entries(value));
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ProjectSettingsInputError();
  return input;
}

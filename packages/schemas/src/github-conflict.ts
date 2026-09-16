import { z } from 'zod';

export const GitHubSourceConflictCode = z.enum([
  'GITHUB_DUPLICATE_IMPORT',
  'GITHUB_PROJECT_SLUG_COLLISION',
  'GITHUB_SERVICE_ALREADY_BOUND',
  'GITHUB_INSTALLATION_MISMATCH',
  'GITHUB_DEFAULT_BRANCH_MISSING',
  'GITHUB_DEFAULT_BRANCH_CHANGED',
  'GITHUB_SOURCE_ACCESS_REVOKED',
  'GITHUB_CATALOG_STALE',
  'GITHUB_SOURCE_DISCONNECTED',
  'GITHUB_IDEMPOTENCY_CONFLICT',
]);

export const GitHubSourceRecoveryAction = z.enum([
  'OPEN_EXISTING_PROJECT',
  'OPEN_EXISTING_SERVICE',
  'CHOOSE_NEW_SLUG',
  'REFRESH_CATALOG',
  'REATTACH_INSTALLATION',
  'SELECT_BRANCH',
  'CANCEL',
]);

export const GitHubSourceRecovery = z.object({
  action: GitHubSourceRecoveryAction,
  projectId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  installationId: z.string().min(1).optional(),
  repositoryId: z.string().min(1).optional(),
  currentDefaultBranch: z.string().min(1).optional(),
  requestedBranch: z.string().min(1).optional(),
  suggestedSlug: z.string().min(1).optional(),
}).strict();

export const GitHubIdempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const GitHubSourceConflictBody = z.object({
  statusCode: z.literal(409),
  message: GitHubSourceConflictCode,
  error: GitHubSourceConflictCode,
  code: GitHubSourceConflictCode,
  retryable: z.literal(false),
  terminal: z.literal(true),
  permission: z.literal(false),
  recovery: GitHubSourceRecovery,
}).strict();
export type GitHubSourceConflictCodeValue = z.infer<typeof GitHubSourceConflictCode>;
export type GitHubSourceRecoveryValue = z.infer<typeof GitHubSourceRecovery>;

import crypto from 'node:crypto';
import type { GitHubSourceConflictCodeValue, GitHubSourceRecoveryValue } from '@raibitserver/schemas';

export class GitHubSourceConflict extends Error {
  readonly statusCode = 409;
  readonly retryable = false;
  readonly terminal = true;
  readonly permission = false;
  readonly code: GitHubSourceConflictCodeValue;
  readonly recovery: GitHubSourceRecoveryValue;

  constructor(code: GitHubSourceConflictCodeValue, recovery: GitHubSourceRecoveryValue) {
    super(code);
    this.name = 'GitHubSourceConflict';
    this.code = code;
    this.recovery = recovery;
  }
}

export function githubSourceConflict(code: GitHubSourceConflictCodeValue, recovery: GitHubSourceRecoveryValue): never {
  throw new GitHubSourceConflict(code, recovery);
}

export function githubMutationHash(payload: Readonly<Record<string, unknown>>) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(payload))).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

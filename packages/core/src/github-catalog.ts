import crypto from 'node:crypto';
import { parseGitHubRepository } from './github-integration.ts';

export const GITHUB_CATALOG_PAGE_SIZE = 50;
export const GITHUB_CATALOG_STATUS = Object.freeze({ IDLE: 'IDLE', REFRESHING: 'REFRESHING', STALE: 'STALE' } as const);
const configuredCursorSecret = process.env.RAIBITSERVER_CURSOR_SECRET || process.env.RAIBITSERVER_JWT_SECRET;
const cursorKey = configuredCursorSecret ? crypto.createHash('sha256').update(configuredCursorSecret).digest() : crypto.randomBytes(32);

export type GitHubCatalogPageFetcher = (input: Readonly<{ installationId: string; page: number; perPage: number }>) => Promise<Readonly<{ repositories: readonly Record<string, unknown>[]; hasNextPage: boolean }>>;

export function normalizeGitHubCatalogRepository(input: Record<string, any>, generation: number) {
  const githubRepoId = String(input.githubRepoId || input.id || '').trim();
  if (!/^\d+$/.test(githubRepoId)) throw catalogError('GITHUB_CATALOG_REPOSITORY_INVALID', 502);
  const parsed = parseGitHubRepository(String(input.fullName || input.full_name || ''));
  const defaultBranch = String(input.defaultBranch || input.default_branch || 'main').trim();
  if (!defaultBranch || defaultBranch.length > 255 || /[\u0000-\u001f\u007f]/.test(defaultBranch)) throw catalogError('GITHUB_CATALOG_REPOSITORY_INVALID', 502);
  return {
    installationId: String(input.installationId || ''),
    githubRepoId,
    owner: parsed.owner.toLowerCase(),
    name: parsed.repo.toLowerCase(),
    fullName: parsed.fullName.toLowerCase(),
    normalizedIdentity: parsed.fullName.toLowerCase(),
    defaultBranch,
    private: input.private === true,
    accessState: input.accessState === 'REVOKED' ? 'REVOKED' : 'ACCESSIBLE',
    generation,
  };
}

export async function fetchCompleteGitHubCatalog(installationId: string, fetchPage: GitHubCatalogPageFetcher) {
  const repositories: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page += 1) {
    let result: Awaited<ReturnType<GitHubCatalogPageFetcher>> | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { result = await fetchPage({ installationId, page, perPage: 100 }); break; }
      catch { if (attempt === 3) throw catalogError('GITHUB_CATALOG_REFRESH_FAILED', 502, true); }
    }
    if (!result || !Array.isArray(result.repositories)) throw catalogError('GITHUB_CATALOG_REFRESH_FAILED', 502, true);
    for (const repository of result.repositories) {
      const normalized = normalizeGitHubCatalogRepository({ ...repository, installationId }, 0);
      if (seen.has(normalized.githubRepoId)) continue;
      seen.add(normalized.githubRepoId);
      repositories.push(normalized);
    }
    if (!result.hasNextPage) return repositories;
  }
  throw catalogError('GITHUB_CATALOG_REFRESH_FAILED', 502, true);
}

export function pageGitHubCatalog(rows: readonly Record<string, any>[], input: Record<string, any>) {
  const query = String(input.q || '').trim().toLowerCase();
  if (query.length > 200 || (input.cursor && String(input.cursor).length > 2048)) throw catalogError('GITHUB_CATALOG_CURSOR_INVALID', 400);
  const generation = Number(input.generation || 0);
  const filtered = rows
    .filter(row => Number(row.generation || 0) === generation && (!query || String(row.normalizedIdentity || row.fullName).includes(query)))
    .sort((left, right) => String(left.normalizedIdentity || left.fullName).localeCompare(String(right.normalizedIdentity || right.fullName)) || String(left.githubRepoId).localeCompare(String(right.githubRepoId)));
  let offset = 0;
  if (input.cursor) {
    const cursor = decodeCursor(String(input.cursor));
    if (cursor.organizationId !== String(input.organizationId) || cursor.installationId !== String(input.installationId) || cursor.generation !== generation || cursor.q !== query) throw catalogError('GITHUB_CATALOG_CURSOR_INVALID', 400);
    offset = filtered.findIndex(row => String(row.normalizedIdentity || row.fullName) === cursor.identity && String(row.githubRepoId) === cursor.repositoryId) + 1;
    if (offset === 0) throw catalogError('GITHUB_CATALOG_CURSOR_INVALID', 400);
  }
  const repositories = filtered.slice(offset, offset + GITHUB_CATALOG_PAGE_SIZE);
  const last = repositories.at(-1);
  const nextCursor = offset + repositories.length < filtered.length && last ? encodeCursor({ organizationId: String(input.organizationId), installationId: String(input.installationId), generation, q: query, identity: String(last.normalizedIdentity || last.fullName), repositoryId: String(last.githubRepoId) }) : null;
  return { repositories, nextCursor };
}

export function catalogError(code: string, statusCode: number, retryable = false) {
  const error = new Error(code);
  Object.assign(error, { code, statusCode, retryable });
  return error;
}

function encodeCursor(payload: Record<string, unknown>) {
  const data = Buffer.from(JSON.stringify({ v: 1, ...payload })).toString('base64url');
  const signature = crypto.createHmac('sha256', cursorKey).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function decodeCursor(value: string): Record<string, any> {
  const [data, signature, extra] = value.split('.');
  if (!data || !signature || extra) throw catalogError('GITHUB_CATALOG_CURSOR_INVALID', 400);
  const expected = crypto.createHmac('sha256', cursorKey).update(data).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw catalogError('GITHUB_CATALOG_CURSOR_INVALID', 400);
  try {
    const decoded = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (decoded?.v !== 1) throw new Error();
    return decoded;
  } catch { throw catalogError('GITHUB_CATALOG_CURSOR_INVALID', 400); }
}

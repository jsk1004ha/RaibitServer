export function apiAction(path: string, _context?: unknown): string {
  return `/api/control${path.startsWith('/') ? path : `/${path}`}`;
}

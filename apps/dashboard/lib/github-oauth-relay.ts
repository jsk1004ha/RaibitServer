import type { NextRequest } from 'next/server';
import { OAUTH_BROWSER_COOKIE_NAME, OAUTH_RELAY_HEADER, issueOAuthBrowserCookie, parseOAuthBrowserCookie, signOAuthRelay } from '@raibitserver/core/oauth-source';
import { GITHUB_OAUTH_STATE_COOKIE_NAME, GITHUB_OAUTH_VERIFIER_COOKIE_NAME } from './request-security.js';

type BrowserBinding = { readonly browserId: string; readonly cookieValue: string };
type BrowserBindingFailure = 'github_oauth_relay_invalid' | 'github_oauth_state_invalid' | 'github_oauth_not_configured';
class BrowserBindingError extends Error {
  readonly code: BrowserBindingFailure;
  constructor(code: BrowserBindingFailure) { super(code); this.code = code; }
}

export function githubOAuthBrowserBinding(request: NextRequest, operation: 'login' | 'callback'): BrowserBinding {
  if (request.headers.has(OAUTH_RELAY_HEADER)) throw new BrowserBindingError('github_oauth_relay_invalid');
  const names = (request.headers.get('cookie') || '').split(';').map((entry) => entry.split('=', 1)[0]?.trim());
  for (const name of [OAUTH_BROWSER_COOKIE_NAME, GITHUB_OAUTH_STATE_COOKIE_NAME, GITHUB_OAUTH_VERIFIER_COOKIE_NAME]) {
    if (names.filter((candidate) => candidate === name).length > 1) throw new BrowserBindingError('github_oauth_state_invalid');
  }
  const secret = process.env.RAIBITSERVER_OAUTH_RELAY_SECRET;
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw new BrowserBindingError('github_oauth_not_configured');
  const current = request.cookies.get(OAUTH_BROWSER_COOKIE_NAME)?.value;
  const existingId = parseOAuthBrowserCookie(current, secret);
  if (existingId && current) return { browserId: existingId, cookieValue: current };
  if (operation === 'callback') throw new BrowserBindingError('github_oauth_state_invalid');
  const cookieValue = issueOAuthBrowserCookie(secret);
  const browserId = parseOAuthBrowserCookie(cookieValue, secret);
  if (!browserId) throw new BrowserBindingError('github_oauth_not_configured');
  return { browserId, cookieValue };
}

export function githubOAuthRelayHeaders(browserId: string, path: string, query: URLSearchParams) {
  const operation = path === '/auth/github/login' ? 'login' : 'callback';
  return { [OAUTH_RELAY_HEADER]: signOAuthRelay({ browserId, operation, query: Object.fromEntries(query) }, process.env.RAIBITSERVER_OAUTH_RELAY_SECRET) };
}

export const githubOAuthBrowserCookieOptions = {
  secure: true, httpOnly: true, sameSite: 'lax', path: '/',
} as const;

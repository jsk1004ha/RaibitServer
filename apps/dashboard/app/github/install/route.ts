import { NextRequest, NextResponse } from 'next/server';
import { getJson } from '../../../lib/api';
import {
  consoleOriginHref,
  dashboardRequestUrl,
  GITHUB_INSTALL_STATE_COOKIE_NAME,
  githubInstallStateCookieOptions,
} from '../../../lib/request-security.js';

export async function GET(request: NextRequest) {
  const result = await getJson('/github/install', {});
  if (!result.ok) return githubPageError(request, result.errorCode);
  const installUrl = safeGitHubRedirect(result.body?.installUrl);
  if (!installUrl) return githubPageError(request, 'github_install_url_invalid');
  const response = NextResponse.redirect(installUrl, 302);
  const cookieOptions = { ...githubInstallStateCookieOptions(), sameSite: 'lax' as const };
  response.cookies.set(
    GITHUB_INSTALL_STATE_COOKIE_NAME,
    installUrl.searchParams.get('state') as string,
    cookieOptions,
  );
  return response;
}

function githubPageError(request: NextRequest, code = 'github_install_failed') {
  const target = githubConsoleTarget(request);
  target.searchParams.set('step', 'connect');
  target.searchParams.set('error', code);
  return clearGitHubInstallState(NextResponse.redirect(target, 303));
}

function clearGitHubInstallState(response: NextResponse) {
  response.cookies.set(GITHUB_INSTALL_STATE_COOKIE_NAME, '', {
    ...githubInstallStateCookieOptions(),
    sameSite: 'lax' as const,
    maxAge: 0,
  });
  return response;
}

function githubConsoleTarget(request: NextRequest) {
  const browserRequestUrl = dashboardRequestUrl(request.url, {
    host: request.headers.get('host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
  });
  return new URL(
    consoleOriginHref(process.env.RAIBITSERVER_CONSOLE_URL, '/github', '/github'),
    browserRequestUrl,
  );
}

function safeGitHubRedirect(value: unknown) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && /^\/apps\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/installations\/new$/.test(url.pathname)
      && Boolean(url.searchParams.get('state'))
      ? url
      : null;
  } catch {
    return null;
  }
}

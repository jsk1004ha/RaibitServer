import { NextRequest, NextResponse } from 'next/server';
import { getJson } from '../../../lib/api';
import { consoleOriginHref, dashboardRequestUrl } from '../../../lib/request-security.js';

export async function GET(request: NextRequest) {
  const result = await getJson('/github/install', {});
  if (!result.ok) return githubPageError(request, result.errorCode);
  const installUrl = safeGitHubRedirect(result.body?.installUrl);
  if (!installUrl) return githubPageError(request, 'github_install_url_invalid');
  return NextResponse.redirect(installUrl, 302);
}

function githubPageError(request: NextRequest, code = 'github_install_failed') {
  const target = githubConsoleTarget(request);
  target.searchParams.set('step', 'connect');
  target.searchParams.set('error', code);
  return NextResponse.redirect(target, 303);
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

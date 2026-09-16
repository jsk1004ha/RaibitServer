export const SESSION_COOKIE_NAME = '__Host-raibitserver_session';
export const LEGACY_SESSION_COOKIE_NAME = 'raibitserver_session';

export function sessionCookieOptions(env = process.env) {
  const configuredMaxAge = Number.parseInt(env.RAIBITSERVER_SESSION_MAX_AGE_SECONDS || '', 10);
  const maxAge = Number.isFinite(configuredMaxAge)
    ? Math.min(Math.max(configuredMaxAge, 300), 604_800)
    : 28_800;
  const sameSite = /** @type {const} */ ('lax');
  return { httpOnly: true, sameSite, secure: true, path: '/', maxAge };
}

/** @param {string | null} cookieHeader */
export function readSessionToken(cookieHeader) {
  const entries = (cookieHeader || '').split(';').map((entry) => entry.trim());
  const matches = entries.filter((entry) => entry.split('=', 1)[0] === SESSION_COOKIE_NAME);
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(SESSION_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9._~-]{1,4096}$/.test(value) ? value : undefined;
}

/** @param {import('next/server').NextResponse} response */
export function expireLegacySessionCookie(response) {
  response.cookies.set(LEGACY_SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), maxAge: 0 });
}

/**
 * @param {import('next/server').NextResponse} response
 * @param {string} token
 */
export function setSessionCookie(response, token) {
  expireLegacySessionCookie(response);
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

/** @param {import('next/server').NextResponse} response */
export function clearSessionCookie(response) {
  expireLegacySessionCookie(response);
  response.cookies.set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(), maxAge: 0 });
}

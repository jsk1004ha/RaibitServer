export const THEME_COOKIE_NAME = 'raibit-theme';
export const THEME_STORAGE_KEY = 'raibit-theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const THEME_PREFERENCES = Object.freeze(['system', 'light', 'dark']);

export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : 'system';
}

export function themePreferenceFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (rawName !== THEME_COOKIE_NAME) continue;

    try {
      const value = decodeURIComponent(rawValueParts.join('='));
      return THEME_PREFERENCES.includes(value) ? value : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function serializeThemeCookie(value, { secure = false } = {}) {
  const preference = normalizeThemePreference(value);
  const attributes = [
    `${THEME_COOKIE_NAME}=${encodeURIComponent(preference)}`,
    'Path=/',
    `Max-Age=${THEME_COOKIE_MAX_AGE}`,
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

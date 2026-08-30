const SENSITIVE_KEY = /password|token|secret/i;
const OTP_PATHS = new Set(['/api/auth/email/verify']);

export function redactFixtureRequestBody(value, pathname = '') {
  if (Array.isArray(value)) return value.map((entry) => redactFixtureRequestBody(entry, pathname));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) || (key === 'code' && OTP_PATHS.has(pathname)) ? '[MASKED]' : redactFixtureRequestBody(entry, pathname),
  ]));
}

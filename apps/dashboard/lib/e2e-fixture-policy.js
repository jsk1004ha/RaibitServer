export const E2E_FIXTURE_ENVIRONMENT = 'RAIBITSERVER_E2E_FIXTURES';

function isLocalFixtureHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1'
    || normalized.endsWith('.localhost');
}

function isLocalFixtureRequestHost(value) {
  if (typeof value !== 'string' || !value || value.length > 300 || /[\s,\\/@?#]/.test(value)) return false;
  try {
    const candidate = new URL(`http://${value}`);
    return !candidate.username
      && !candidate.password
      && candidate.pathname === '/'
      && !candidate.search
      && !candidate.hash
      && isLocalFixtureHostname(candidate.hostname);
  } catch {
    return false;
  }
}

export function e2eFixturesEnabled(environment = process.env, requestHost) {
  if (environment[E2E_FIXTURE_ENVIRONMENT] !== '1') return false;
  if (!isLocalFixtureHostname(environment.RAIBITSERVER_BASE_DOMAIN)) return false;
  if (!isLocalFixtureRequestHost(requestHost)) return false;
  try {
    const origin = new URL(environment.RAIBITSERVER_DASHBOARD_ORIGIN || '');
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && !origin.username
      && !origin.password
      && origin.pathname === '/'
      && !origin.search
      && !origin.hash
      && isLocalFixtureHostname(origin.hostname);
  } catch {
    return false;
  }
}

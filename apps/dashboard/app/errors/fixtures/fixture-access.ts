import { notFound } from 'next/navigation';

export const E2E_FIXTURE_ENVIRONMENT = 'RAIBITSERVER_E2E_FIXTURES';

function isLocalFixtureHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1'
    || normalized.endsWith('.localhost');
}

export function e2eFixturesEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.RAIBITSERVER_E2E_FIXTURES !== '1') return false;
  const baseDomain = environment.RAIBITSERVER_BASE_DOMAIN?.trim().toLowerCase();
  if (!baseDomain || !isLocalFixtureHostname(baseDomain)) return false;
  try {
    const origin = new URL(environment.RAIBITSERVER_DASHBOARD_ORIGIN || '');
    return (origin.protocol === 'http:' || origin.protocol === 'https:') && isLocalFixtureHostname(origin.hostname);
  } catch {
    return false;
  }
}

export function assertE2eFixturesEnabled(): void {
  if (!e2eFixturesEnabled()) notFound();
}

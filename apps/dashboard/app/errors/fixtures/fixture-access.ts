import { notFound } from 'next/navigation';

export const E2E_FIXTURE_ENVIRONMENT = 'RAIBITSERVER_E2E_FIXTURES';

export function assertE2eFixturesEnabled(): void {
  if (process.env.RAIBITSERVER_E2E_FIXTURES !== '1') notFound();
}

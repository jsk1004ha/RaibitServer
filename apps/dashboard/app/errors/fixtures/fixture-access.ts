import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { e2eFixturesEnabled } from '@/lib/e2e-fixture-policy';

export { E2E_FIXTURE_ENVIRONMENT, e2eFixturesEnabled } from '@/lib/e2e-fixture-policy';

export async function assertE2eFixturesEnabled(): Promise<void> {
  const requestHeaders = await headers();
  if (!e2eFixturesEnabled(process.env, requestHeaders.get('host'))) notFound();
}

import { redirect } from 'next/navigation';
import { assertE2eFixturesEnabled } from '../fixture-access';

export default async function GlobalErrorFixturePage(): Promise<never> {
  await assertE2eFixturesEnabled();
  redirect('/errors/fixtures/global-error/arm');
}

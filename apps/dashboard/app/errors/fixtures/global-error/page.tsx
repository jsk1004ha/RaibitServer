import { redirect } from 'next/navigation';
import { assertE2eFixturesEnabled } from '../fixture-access';

export default function GlobalErrorFixturePage(): never {
  assertE2eFixturesEnabled();
  redirect('/errors/fixtures/global-error/arm');
}

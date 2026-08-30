import { assertE2eFixturesEnabled } from '../fixture-access';

export default async function LoadingFixture(): Promise<null> {
  assertE2eFixturesEnabled();
  await new Promise(() => undefined);
  return null;
}

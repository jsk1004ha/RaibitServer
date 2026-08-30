import { assertE2eFixturesEnabled } from '../fixture-access';

class T6RouteErrorFixture extends Error {
  constructor() {
    super('T6_E2E_SECRET_SHOULD_NOT_RENDER');
  }
}

export default function RouteErrorFixturePage(): never {
  assertE2eFixturesEnabled();
  throw new T6RouteErrorFixture();
}

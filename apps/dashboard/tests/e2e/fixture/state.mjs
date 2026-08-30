import {
  DEFAULT_PUBLIC_SITE_SCENARIO,
  isPublicSiteScenario,
} from './data.mjs';

export function createFixtureState() {
  let publicSiteScenario = DEFAULT_PUBLIC_SITE_SCENARIO;

  return Object.freeze({
    reset() {
      publicSiteScenario = DEFAULT_PUBLIC_SITE_SCENARIO;
      return snapshot();
    },
    selectPublicSiteScenario(value) {
      if (!isPublicSiteScenario(value)) return null;
      publicSiteScenario = value;
      return snapshot();
    },
    snapshot,
  });

  function snapshot() {
    return Object.freeze({ publicSiteScenario });
  }
}

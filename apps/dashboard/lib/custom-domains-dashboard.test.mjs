import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Given the project console, when custom domains are rendered, then the domain route, server BFF load, and one-time challenge safeguards are present', async () => {
  const [types, model, page, hub, domains] = await Promise.all([
    source('components/project-hub/types.ts'),
    source('components/project-hub/model.ts'),
    source('app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    source('components/project-hub/project-hub.tsx'),
    source('components/project-hub/domains.tsx'),
  ]);

  assert.match(types, /'domains'/);
  assert.match(model, /view=domains/);
  assert.match(page, /\/projects\/\$\{encodeURIComponent\(projectId\)\}\/domains/);
  assert.match(hub, /DomainsView/);
  assert.match(domains, /_raibit-challenge\.\$\{challenge\.hostname\}/);
  assert.match(domains, /raibit-verification=\$\{challenge\.token\}/);
  assert.match(domains, /domains-verify/);
  assert.match(domains, /MAX_STATUS_POLLS/);
  assert.doesNotMatch(domains, /localStorage|sessionStorage/);
});

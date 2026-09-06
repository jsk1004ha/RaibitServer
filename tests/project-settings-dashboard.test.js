import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const settingsUrl = new URL('../apps/dashboard/components/project-hub/settings.tsx', import.meta.url);
const projectPageUrl = new URL('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx', import.meta.url);

test('project settings dashboard uses a versioned settings snapshot and separately schedules deletion', async () => {
  const [settings, page] = await Promise.all([fs.readFile(settingsUrl, 'utf8'), fs.readFile(projectPageUrl, 'utf8')]);

  assert.match(page, /\/settings/);
  assert.match(settings, /expectedUpdatedAt/);
  assert.match(settings, /프로젝트 일반 설정/);
  assert.match(settings, /프로젝트 삭제/);
  assert.match(settings, /deletionImpact/);
});

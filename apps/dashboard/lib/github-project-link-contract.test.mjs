import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { scopedProjectHrefs } from './github-project-link-contract.mjs';

test('GitHub recovery opens only an authorized project and derives its known organization route slug', async () => {
  assert.deepEqual(scopedProjectHrefs({
    projects: [
      { id: 'prj_authorized', organizationId: 'org_authorized' },
      { id: 'prj_foreign', organizationId: 'org_foreign' },
    ],
    subject: { organizationId: 'org_authorized', organizationSlug: 'club' },
    memberships: [{ organizationId: 'org_authorized', role: 'ADMIN' }],
  }), { prj_authorized: '/org/club/projects/prj_authorized' });
  assert.deepEqual(scopedProjectHrefs({
    projects: [{ id: 'prj_member', organizationId: 'org_member', organizationSlug: 'member-club' }],
    subject: null,
    memberships: [{ organizationId: 'org_member', role: 'VIEWER' }],
  }), { prj_member: '/org/member-club/projects/prj_member' });
  const page = await readFile(new URL('../app/github/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /scopedProjectHrefs\(\{ memberships: state\.memberships, projects: state\.projects, subject: state\.subject \}\)/);
});

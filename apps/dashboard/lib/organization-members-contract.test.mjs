import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = (name) => readFile(new URL(`../components/${name}`, import.meta.url), 'utf8');
const page = (name) => readFile(new URL(`../app/${name}`, import.meta.url), 'utf8');

test('organization navigation is derived from authenticated memberships and uses a scoped management route', async () => {
  const [shell, switcher, mobile] = await Promise.all([
    component('console-ui.tsx'),
    component('organization-switcher.tsx'),
    component('console-mobile-nav.tsx'),
  ]);

  assert.doesNotMatch(shell, /^['"]use client['"]/);
  assert.match(shell, /const rawMemberships: unknown\[\] = Array\.isArray\(me\.body\?\.memberships\)/);
  assert.match(shell, /organizationMemberships\.find\(\(membership\) => membership\.organizationId === requestedOrganizationId\)/);
  assert.match(shell, /<OrganizationSwitcher currentOrganizationId=\{resolvedOrgRouteValue\} memberships=\{organizationMemberships\}/);
  assert.match(switcher, /^['"]use client['"]/);
  assert.match(switcher, /memberships\.filter/);
  assert.match(switcher, /\/org\/\$\{encodeURIComponent\(organizationId\)\}\/projects/);
  assert.match(switcher, /\/org\/\$\{encodeURIComponent\(currentOrganizationId\)\}\/members/);
  assert.match(switcher, /DropdownMenu/);
  assert.match(mobile, /<OrganizationSwitcher currentOrganizationId=\{organizationRouteValue\} memberships=\{organizationMemberships\}/);
});

test('member administration uses the authenticated BFF, concurrency versions, and safe avatar fallbacks', async () => {
  const [members, membersPage] = await Promise.all([
    component('organization-members.tsx'),
    page('org/[orgSlug]/members/page.tsx'),
  ]);

  for (const endpoint of [
    /\/members\/\$\{encodeURIComponent\(member\.id\)\}`, 'PATCH'/,
    /\/members\/\$\{encodeURIComponent\(\(target as OrganizationMember\)\.id\)\}`, 'DELETE'/,
    /\/leave`, 'POST'/,
    /\/invites`, 'POST'/,
    /\/invites\/\$\{encodeURIComponent\(\(target as OrganizationInvite\)\.id\)\}`, 'DELETE'/,
  ]) assert.match(members, endpoint);
  assert.match(members, /expectedVersion: member\.version/);
  assert.match(members, /expectedVersion: \(target as OrganizationMember\)\.version/);
  assert.match(members, /<UserAvatar avatarUrl=\{member\.user\.avatarUrl\} email=\{member\.user\.email\} name=\{member\.user\.name\}/);
  assert.match(members, /<Spinner data-icon="inline-start" \/>/);
  assert.match(members, /LAST_OWNER/);
  assert.match(membersPage, /getJson\(`\/organizations\/\$\{encodeURIComponent\(organizationId\)\}\/members`/);
  assert.match(membersPage, /getJson\(`\/organizations\/\$\{encodeURIComponent\(organizationId\)\}\/invites`/);
});

test('invite acceptance clears the token URL, refuses auth-token handoff, and sends the token only to the authenticated BFF endpoint', async () => {
  const [acceptance, acceptancePage] = await Promise.all([
    component('organization-invite-acceptance.tsx'),
    page('organization-invites/accept/page.tsx'),
  ]);

  assert.match(acceptancePage, /referrer: 'no-referrer'/);
  assert.match(acceptancePage, /\^\[A-Za-z0-9_-\]\{43\}\$/);
  assert.match(acceptance, /window\.history\.replaceState\(null, '', '\/organization-invites\/accept'\)/);
  assert.match(acceptance, /apiAction\('\/organization-invites\/accept'\)/);
  assert.match(acceptance, /body: JSON\.stringify\(\{ token \}\)/);
  assert.match(acceptance, /초대받은 이메일로 인증된 계정에 로그인한 뒤, 보안을 위해 초대 이메일을 다시 열어 주세요/);
  assert.doesNotMatch(`${acceptance}\n${acceptancePage}`, /localStorage|sessionStorage|returnTo|next=/);
});

test('approved console users can open the organization creation surface without choosing ownership or roles', async () => {
  const [switcher, form, pageSource, controlRoute] = await Promise.all([
    component('organization-switcher.tsx'),
    component('organization-create-form.tsx'),
    page('organizations/new/page.tsx'),
    page('api/control/[...path]/route.ts'),
  ]);

  assert.match(switcher, /href="\/organizations\/new"/);
  assert.doesNotMatch(switcher, /role === 'OWNER'|role === 'ADMIN'/);
  assert.match(form, /apiAction\('\/organizations'\)/);
  assert.match(form, /body: JSON\.stringify\(\{ name, slug \}\)/);
  assert.match(form, /organization-name/);
  assert.match(form, /organization-slug/);
  assert.match(form, /pattern="\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?"/);
  assert.match(form, /status === 409/);
  assert.match(form, /response\.status === 401 \? \{ kind: 'auth-required' \}/);
  assert.match(form, /kind: 'created-needs-reauthentication'/);
  assert.match(form, /새 조직이 만들어지지 않았습니다/);
  assert.match(form, /requiresReauthentication/);
  assert.doesNotMatch(form, /owner|membershipId|role:/i);
  assert.doesNotMatch(pageSource, /^['"]use client['"]/);
  assert.match(pageSource, /<ConsoleShell active="projects"/);
  assert.match(controlRoute, /path === '\/organizations' && payload\?\.reauthenticationRequired === true/);
  assert.match(controlRoute, /response\.cookies\.set\(SESSION_COOKIE_NAME, '', \{ \.\.\.sessionCookieOptions\(\), sameSite: 'lax', maxAge: 0 \}\)/);
});

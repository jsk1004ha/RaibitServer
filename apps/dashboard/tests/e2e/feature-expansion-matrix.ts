export const PLATFORM_EXPANSION_ROLES = ['anonymous', 'pending', 'OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER', 'GLOBAL_ADMIN'] as const;
export const PLATFORM_EXPANSION_STATES = ['empty', 'loading', 'pending', 'success', 'retryable', 'terminal', 'permission', 'conflict', 'degraded'] as const;
export const PLATFORM_EXPANSION_VIEWPORTS = [
  { width: 320, height: 720 }, { width: 375, height: 812 }, { width: 390, height: 844 },
  { width: 768, height: 1024 }, { width: 1024, height: 900 }, { width: 1280, height: 800 },
] as const;
export const PLATFORM_EXPANSION_THEMES = ['light', 'dark', 'system'] as const;
export const PLATFORM_EXPANSION_ACCESSIBILITY = ['keyboard', 'screen-reader-announcement', 'axe', 'reduced-motion', 'zoom-200', 'long-korean', 'long-id'] as const;

type Role = (typeof PLATFORM_EXPANSION_ROLES)[number];
type State = (typeof PLATFORM_EXPANSION_STATES)[number];
type Theme = (typeof PLATFORM_EXPANSION_THEMES)[number];
type Accessibility = (typeof PLATFORM_EXPANSION_ACCESSIBILITY)[number];
type FixtureActor = 'anonymous' | 'user' | 'admin';
type Driver = 'auth-login' | 'empty-projects' | 'github-disconnect' | 'github-conflict' | 'github-retryable' | 'project-save' | 'project-stale' | 'project-delete-denied' | 'service-preview' | 'deployment-retry' | 'stream-switch' | 'stream-degraded' | 'resource-restore' | 'custom-domain-create' | 'loading-boundary';
type Execution = 'fixture-driver' | 'delegated-task35' | 'delegated-task41';

export type PlatformExpansionRow = Readonly<{
  id: string;
  execution: Execution;
  driver: Driver | null;
  actor: FixtureActor | null;
  route: string;
  role: Role;
  state: State;
  viewport: (typeof PLATFORM_EXPANSION_VIEWPORTS)[number];
  theme: Theme;
  zoom: 100 | 200;
  accessibility: readonly Accessibility[];
  representativeVisual: boolean;
  action: string;
  observedOutcome: string;
  sourceRefs: readonly string[];
}>;

const project = '/org/raibit/projects/prj_fixture_001';
const delegatedTask35Rows = [
  { id: 'identity-anonymous-denied', role: 'anonymous', state: 'permission', source: 'anonymous-create' },
  { id: 'identity-pending-relogin', role: 'pending', state: 'terminal', source: 'expired-session-read' },
  { id: 'identity-owner-membership', role: 'OWNER', state: 'success', source: 'owner-member-mutate' },
  { id: 'identity-admin-membership', role: 'ADMIN', state: 'success', source: 'admin-member-mutate' },
  { id: 'identity-maintainer-denied', role: 'MAINTAINER', state: 'permission', source: 'maintainer-member-mutate' },
  { id: 'identity-developer-denied', role: 'DEVELOPER', state: 'permission', source: 'developer-member-mutate' },
  { id: 'identity-db-admin-denied', role: 'DB_ADMIN', state: 'permission', source: 'db_admin-member-mutate' },
  { id: 'identity-viewer-denied', role: 'VIEWER', state: 'permission', source: 'viewer-member-mutate' },
  { id: 'identity-global-admin-create', role: 'GLOBAL_ADMIN', state: 'success', source: 'global-admin-create' },
] as const;

type RoleBrowserJourney = Readonly<{
  id: string;
  kind: 'positive' | 'negative';
  title: string;
  role: Role;
  token: string | null;
  route: '/org/org_fixture_001/members' | '/organizations/new';
  intent: 'authentication-required' | 'member-mutation' | 'member-denied' | 'tenant-create';
  nextRole?: 'ADMIN' | 'MAINTAINER';
  viewport: (typeof PLATFORM_EXPANSION_VIEWPORTS)[number];
  theme: Theme;
}>;

export const TASK49_ROLE_BROWSER_JOURNEYS = [
  { id: 'task49-role-anonymous', kind: 'negative', title: 'identity-role-anonymous cannot mutate organization membership and is asked to sign in', role: 'anonymous', token: null, route: '/org/org_fixture_001/members', intent: 'authentication-required', viewport: PLATFORM_EXPANSION_VIEWPORTS[0], theme: 'light' },
  { id: 'task49-role-pending', kind: 'negative', title: 'identity-role-pending cannot mutate organization membership before account approval', role: 'pending', token: 'fixture-role-pending', route: '/org/org_fixture_001/members', intent: 'authentication-required', viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'dark' },
  { id: 'task49-role-owner', kind: 'positive', title: 'identity-role-OWNER changes a member role and reads back the persisted membership', role: 'OWNER', token: 'fixture-role-owner', route: '/org/org_fixture_001/members', intent: 'member-mutation', nextRole: 'ADMIN', viewport: PLATFORM_EXPANSION_VIEWPORTS[2], theme: 'system' },
  { id: 'task49-role-admin', kind: 'positive', title: 'identity-role-ADMIN changes a non-owner role and reads back the persisted membership', role: 'ADMIN', token: 'fixture-role-admin', route: '/org/org_fixture_001/members', intent: 'member-mutation', nextRole: 'MAINTAINER', viewport: PLATFORM_EXPANSION_VIEWPORTS[3], theme: 'light' },
  { id: 'task49-role-maintainer', kind: 'negative', title: 'identity-role-MAINTAINER receives 403, unchanged member readback, and no mutation controls', role: 'MAINTAINER', token: 'fixture-role-maintainer', route: '/org/org_fixture_001/members', intent: 'member-denied', viewport: PLATFORM_EXPANSION_VIEWPORTS[4], theme: 'dark' },
  { id: 'task49-role-developer', kind: 'negative', title: 'identity-role-DEVELOPER receives 403, unchanged member readback, and no mutation controls', role: 'DEVELOPER', token: 'fixture-role-developer', route: '/org/org_fixture_001/members', intent: 'member-denied', viewport: PLATFORM_EXPANSION_VIEWPORTS[5], theme: 'system' },
  { id: 'task49-role-db-admin', kind: 'negative', title: 'identity-role-DB_ADMIN receives 403, unchanged member readback, and no mutation controls', role: 'DB_ADMIN', token: 'fixture-role-db-admin', route: '/org/org_fixture_001/members', intent: 'member-denied', viewport: PLATFORM_EXPANSION_VIEWPORTS[0], theme: 'light' },
  { id: 'task49-role-viewer', kind: 'negative', title: 'identity-role-VIEWER receives 403, unchanged member readback, and no mutation controls', role: 'VIEWER', token: 'fixture-role-viewer', route: '/org/org_fixture_001/members', intent: 'member-denied', viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'dark' },
  { id: 'task49-role-global-admin', kind: 'positive', title: 'identity-role-GLOBAL_ADMIN creates a tenant without inheriting organization member authority', role: 'GLOBAL_ADMIN', token: 'fixture-role-global-admin', route: '/organizations/new', intent: 'tenant-create', viewport: PLATFORM_EXPANSION_VIEWPORTS[2], theme: 'system' },
] as const satisfies readonly RoleBrowserJourney[];

export const PLATFORM_EXPANSION_MATRIX: readonly PlatformExpansionRow[] = [
  ...delegatedTask35Rows.map((row, index) => ({
    ...row, execution: 'delegated-task35' as const, driver: null, actor: null, route: row.role === 'GLOBAL_ADMIN' ? '/organizations/new' : '/org/org_fixture_001/members',
    viewport: PLATFORM_EXPANSION_VIEWPORTS[index % PLATFORM_EXPANSION_VIEWPORTS.length], theme: 'system' as const, zoom: 100 as const,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe'] as const, representativeVisual: false,
    action: 'Run the authored identity and organization role journey.',
    observedOutcome: 'The browser fixture asserts the named role outcome and its API side effect or unchanged readback.',
    sourceRefs: [`apps/dashboard/tests/e2e/identity-organization-matrix.ts#${row.source}`, 'apps/dashboard/tests/e2e/specs/identity-organization-matrix.spec.ts'],
  })),
  { id: 'auth-login-success', execution: 'fixture-driver', driver: 'auth-login', actor: 'anonymous', route: '/login?next=%2Forg%2Fraibit%2Fprojects', role: 'anonymous', state: 'success', viewport: PLATFORM_EXPANSION_VIEWPORTS[0], theme: 'light', zoom: 200, accessibility: ['keyboard', 'axe', 'zoom-200', 'long-korean'], representativeVisual: true, action: 'Submit login with Enter.', observedOutcome: 'The allowlisted project route is reached after login.', sourceRefs: ['apps/dashboard/tests/e2e/specs/auth-flows.spec.ts'] },
  { id: 'loading-boundary', execution: 'fixture-driver', driver: 'loading-boundary', actor: 'anonymous', route: '/errors/fixtures/loading', role: 'anonymous', state: 'loading', viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'system', zoom: 100, accessibility: ['axe', 'screen-reader-announcement'], representativeVisual: false, action: 'Open the loading fixture.', observedOutcome: 'The main landmark is busy and announces loading.', sourceRefs: ['apps/dashboard/tests/e2e/specs/error-boundaries.spec.ts'] },
  { id: 'empty-project-list', execution: 'fixture-driver', driver: 'empty-projects', actor: 'user', route: '/org/raibit/projects', role: 'VIEWER', state: 'empty', viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'system', zoom: 100, accessibility: ['keyboard', 'axe'], representativeVisual: false, action: 'Open projects with the empty fixture session.', observedOutcome: 'The empty project state is rendered without a project mutation.', sourceRefs: ['apps/dashboard/tests/e2e/regression-matrix.ts'] },
  { id: 'github-disconnect-success', execution: 'fixture-driver', driver: 'github-disconnect', actor: 'admin', route: '/github?step=connect', role: 'ADMIN', state: 'success', viewport: PLATFORM_EXPANSION_VIEWPORTS[3], theme: 'dark', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'reduced-motion'], representativeVisual: true, action: 'Confirm integration disconnect.', observedOutcome: 'The expectedVersion POST returns a disconnected status.', sourceRefs: ['apps/dashboard/tests/e2e/specs/github-lifecycle.spec.ts'] },
  { id: 'github-disconnect-conflict', execution: 'fixture-driver', driver: 'github-conflict', actor: 'admin', route: '/github?step=connect', role: 'ADMIN', state: 'conflict', viewport: PLATFORM_EXPANSION_VIEWPORTS[4], theme: 'system', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-id'], representativeVisual: false, action: 'Submit a stale disconnect request.', observedOutcome: 'A typed 409 is announced and no disconnected state is rendered.', sourceRefs: ['apps/dashboard/tests/e2e/specs/github-lifecycle.spec.ts'] },
  { id: 'github-disconnect-retryable', execution: 'fixture-driver', driver: 'github-retryable', actor: 'admin', route: '/github?step=connect', role: 'ADMIN', state: 'retryable', viewport: PLATFORM_EXPANSION_VIEWPORTS[4], theme: 'system', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe'], representativeVisual: false, action: 'Submit a temporarily unavailable disconnect request.', observedOutcome: 'A typed 503 is announced and no disconnected state is rendered.', sourceRefs: ['apps/dashboard/tests/e2e/specs/github-lifecycle.spec.ts'] },
  { id: 'project-settings-save', execution: 'fixture-driver', driver: 'project-save', actor: 'admin', route: `${project}?view=settings`, role: 'ADMIN', state: 'success', viewport: PLATFORM_EXPANSION_VIEWPORTS[5], theme: 'light', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-korean'], representativeVisual: true, action: 'Save a dirty project name.', observedOutcome: 'PATCH returns the changed field and saved timestamp.', sourceRefs: ['apps/dashboard/tests/e2e/specs/project-settings.spec.ts'] },
  { id: 'project-settings-stale', execution: 'fixture-driver', driver: 'project-stale', actor: 'admin', route: `${project}?view=settings`, role: 'ADMIN', state: 'conflict', viewport: PLATFORM_EXPANSION_VIEWPORTS[2], theme: 'light', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe'], representativeVisual: false, action: 'Save after a concurrent update.', observedOutcome: 'The stale PATCH yields a reload prompt and preserves the local draft.', sourceRefs: ['apps/dashboard/tests/e2e/specs/project-settings.spec.ts'] },
  { id: 'project-delete-denied', execution: 'fixture-driver', driver: 'project-delete-denied', actor: 'user', route: `${project}?view=settings`, role: 'VIEWER', state: 'permission', viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'system', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe'], representativeVisual: false, action: 'Request project deletion as a viewer.', observedOutcome: 'Permission denial is announced and no deletion confirmation state is rendered.', sourceRefs: ['apps/dashboard/tests/e2e/specs/project-settings.spec.ts'] },
  { id: 'service-preview-terminal-validation', execution: 'fixture-driver', driver: 'service-preview', actor: 'admin', route: `${project}?view=edit-service&serviceId=svc_fixture_web`, role: 'ADMIN', state: 'terminal', viewport: PLATFORM_EXPANSION_VIEWPORTS[0], theme: 'system', zoom: 200, accessibility: ['keyboard', 'axe', 'zoom-200', 'long-id'], representativeVisual: false, action: 'Submit invalid service health and CPU values.', observedOutcome: 'Validation blocks preview and no deployment request is emitted.', sourceRefs: ['apps/dashboard/tests/e2e/specs/service-settings.spec.ts'] },
  { id: 'deployment-retry-pending', execution: 'fixture-driver', driver: 'deployment-retry', actor: 'admin', route: `${project}?view=deployments&serviceId=svc_fixture_web&environment=production&status=FAILED`, role: 'ADMIN', state: 'pending', viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'dark', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-id'], representativeVisual: false, action: 'Confirm failed deployment retry.', observedOutcome: 'The idempotent POST creates and links the server successor.', sourceRefs: ['apps/dashboard/tests/e2e/specs/deployment-history.spec.ts'] },
  { id: 'runtime-stream-switch', execution: 'fixture-driver', driver: 'stream-switch', actor: 'user', route: `${project}?view=logs&serviceId=svc_fixture_worker&retained=1`, role: 'VIEWER', state: 'success', viewport: PLATFORM_EXPANSION_VIEWPORTS[2], theme: 'light', zoom: 100, accessibility: ['keyboard', 'axe', 'reduced-motion', 'long-id'], representativeVisual: false, action: 'Switch the selected log service.', observedOutcome: 'The old stream closes before the selected-service stream is observed.', sourceRefs: ['apps/dashboard/tests/e2e/specs/task-20-runtime-logs.spec.ts'] },
  { id: 'runtime-stream-degraded', execution: 'fixture-driver', driver: 'stream-degraded', actor: 'user', route: `${project}?view=logs&serviceId=svc_fixture_worker`, role: 'VIEWER', state: 'degraded', viewport: PLATFORM_EXPANSION_VIEWPORTS[3], theme: 'light', zoom: 100, accessibility: ['keyboard', 'axe', 'reduced-motion'], representativeVisual: false, action: 'Abort the worker stream.', observedOutcome: 'Repeated stream failures enter the bounded fallback state.', sourceRefs: ['apps/dashboard/tests/e2e/specs/task-20-runtime-logs.spec.ts'] },
  { id: 'resource-restore-success', execution: 'fixture-driver', driver: 'resource-restore', actor: 'admin', route: `${project}/resources/res_fixture_pg/console?view=backups`, role: 'ADMIN', state: 'success', viewport: PLATFORM_EXPANSION_VIEWPORTS[5], theme: 'dark', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-korean'], representativeVisual: true, action: 'Request restore from the ready backup.', observedOutcome: 'The restore POST carries the selected name and its accepted outcome.', sourceRefs: ['apps/dashboard/tests/e2e/specs/task-26-resource-recovery.spec.ts'] },
  { id: 'custom-domain-create-pending', execution: 'fixture-driver', driver: 'custom-domain-create', actor: 'admin', route: `${project}?view=domains`, role: 'ADMIN', state: 'pending', viewport: PLATFORM_EXPANSION_VIEWPORTS[5], theme: 'dark', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-korean', 'long-id'], representativeVisual: true, action: 'Create and acknowledge a custom-domain TXT proof.', observedOutcome: 'The one-time proof disappears while the generated route remains visible.', sourceRefs: ['apps/dashboard/tests/e2e/specs/project-domains.spec.ts'] },
  { id: 'github-conflict-recovery-contract', execution: 'delegated-task41', driver: null, actor: null, route: '/github?step=import', role: 'MAINTAINER', state: 'conflict', viewport: PLATFORM_EXPANSION_VIEWPORTS[4], theme: 'system', zoom: 100, accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-id'], representativeVisual: false, action: 'Run the corrected Task41 typed-409 recovery driver.', observedOutcome: 'The Task41 fixture asserts recovery actions, idempotency, and safe branch-recovery fields.', sourceRefs: ['apps/dashboard/tests/e2e/specs/github-conflicts.spec.ts', 'apps/dashboard/lib/github-source-mutation-contract.test.mjs', 'apps/dashboard/lib/github-project-link-contract.test.mjs'] },
];

export const PLATFORM_EXPANSION_EXECUTABLE_ROWS = PLATFORM_EXPANSION_MATRIX.filter((row) => row.execution === 'fixture-driver');
export const PLATFORM_EXPANSION_NEGATIVE_ROWS = PLATFORM_EXPANSION_EXECUTABLE_ROWS.filter((row) => ['conflict', 'retryable', 'terminal', 'permission', 'degraded'].includes(row.state));
export const PLATFORM_EXPANSION_DELEGATED_TASK35_ROWS = PLATFORM_EXPANSION_MATRIX.filter((row) => row.execution === 'delegated-task35');
export const PLATFORM_EXPANSION_DELEGATED_TASK41_ROWS = PLATFORM_EXPANSION_MATRIX.filter((row) => row.execution === 'delegated-task41');

export const PLATFORM_EXPANSION_DELEGATED_PLAYWRIGHT_SCENARIOS = [
  { id: 'task35-invite-acceptance', kind: 'positive', title: 'identity-owner-membership trusted invite link completes with keyboard, announcement, redaction, motion, and reflow outcomes' },
  { id: 'task35-account-logout', kind: 'positive', title: 'identity-pending-relogin account identity and logout remain synchronized across desktop and mobile shells' },
  ...TASK49_ROLE_BROWSER_JOURNEYS.map(({ id, kind, title }) => ({ id, kind, title })),
  { id: 'task41-import-conflict-recovery', kind: 'negative', title: 'github-conflict-recovery-contract import preserves an idempotency key across retry and asks for an explicit new slug' },
  { id: 'task41-attach-conflict-recovery', kind: 'negative', title: 'github-conflict-recovery-contract-attach attach and opaque collisions offer only their typed recovery action' },
] as const;

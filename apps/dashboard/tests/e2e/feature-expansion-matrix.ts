export const PLATFORM_EXPANSION_ROLES = [
  'anonymous', 'pending', 'OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER', 'GLOBAL_ADMIN',
] as const;

export const PLATFORM_EXPANSION_STATES = [
  'empty', 'loading', 'pending', 'success', 'retryable', 'terminal', 'permission', 'conflict', 'degraded',
] as const;

export const PLATFORM_EXPANSION_VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 900 },
  { width: 1280, height: 800 },
] as const;

export const PLATFORM_EXPANSION_THEMES = ['light', 'dark', 'system'] as const;

export const PLATFORM_EXPANSION_ACCESSIBILITY = [
  'keyboard', 'screen-reader-announcement', 'axe', 'reduced-motion', 'zoom-200', 'long-korean', 'long-id',
] as const;

type PlatformExpansionRole = (typeof PLATFORM_EXPANSION_ROLES)[number];
type PlatformExpansionState = (typeof PLATFORM_EXPANSION_STATES)[number];
type PlatformExpansionTheme = (typeof PLATFORM_EXPANSION_THEMES)[number];
type PlatformExpansionAccessibility = (typeof PLATFORM_EXPANSION_ACCESSIBILITY)[number];
type Journey = 'auth-login' | 'identity-organization' | 'github-disconnect' | 'github-recovery-contract' | 'project-settings-save' | 'service-settings-preview' | 'deployment-retry' | 'runtime-stream' | 'resource-recovery' | 'custom-domain-create';
type Execution = 'fixture-driver' | 'delegated-task35' | 'contract-pending-task41';

export type PlatformExpansionRow = Readonly<{
  id: string;
  journey: Journey;
  execution: Execution;
  route: string;
  roles: readonly PlatformExpansionRole[];
  states: readonly PlatformExpansionState[];
  viewport: (typeof PLATFORM_EXPANSION_VIEWPORTS)[number];
  theme: PlatformExpansionTheme;
  zoom: 100 | 200;
  accessibility: readonly PlatformExpansionAccessibility[];
  action: string;
  observedOutcome: string;
  sourceRefs: readonly string[];
}>;

export const PLATFORM_EXPANSION_MATRIX = [
  {
    id: 'auth-login-keyboard-success', journey: 'auth-login', execution: 'fixture-driver', route: '/login?next=%2Forg%2Fraibit%2Fprojects',
    roles: ['anonymous'], states: ['success'], viewport: PLATFORM_EXPANSION_VIEWPORTS[0], theme: 'light', zoom: 200,
    accessibility: ['keyboard', 'axe', 'zoom-200', 'long-korean'], action: 'Submit the login form with Enter.',
    observedOutcome: 'The browser reaches the allowlisted project route after the login mutation completes.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/auth-flows.spec.ts'],
  },
  {
    id: 'auth-pending-session-relogin', journey: 'auth-login', execution: 'delegated-task35', route: '/login?error=session_expired',
    roles: ['pending'], states: ['permission', 'terminal'], viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'system', zoom: 100,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe'], action: 'Open the expired-session login recovery surface.',
    observedOutcome: 'The re-login reason is announced without disclosing a token or upstream guard message.',
    sourceRefs: ['apps/dashboard/tests/e2e/identity-organization-matrix.ts#expired-session-read', 'apps/dashboard/tests/e2e/specs/auth-flows.spec.ts'],
  },
  {
    id: 'organization-role-outcomes', journey: 'identity-organization', execution: 'delegated-task35', route: '/org/raibit/members',
    roles: ['OWNER', 'ADMIN', 'MAINTAINER', 'DEVELOPER', 'DB_ADMIN', 'VIEWER', 'GLOBAL_ADMIN'], states: ['success', 'permission', 'conflict'], viewport: PLATFORM_EXPANSION_VIEWPORTS[2], theme: 'dark', zoom: 200,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'zoom-200', 'long-korean', 'long-id'], action: 'Run the owned Task35 invitation, membership, ownership, and session-revocation journeys.',
    observedOutcome: 'Each mutation observes its API result and changes only the target organization membership state.',
    sourceRefs: ['apps/dashboard/tests/e2e/identity-organization-matrix.ts#IDENTITY_ORGANIZATION_MATRIX', 'apps/dashboard/tests/e2e/specs/identity-organization-matrix.spec.ts'],
  },
  {
    id: 'github-disconnect-retryable', journey: 'github-disconnect', execution: 'fixture-driver', route: '/github?step=connect',
    roles: ['ADMIN'], states: ['pending', 'retryable', 'conflict', 'success'], viewport: PLATFORM_EXPANSION_VIEWPORTS[3], theme: 'dark', zoom: 100,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe'], action: 'Confirm disconnect and retry typed stale and availability failures.',
    observedOutcome: 'The request carries expectedVersion; the final status confirms the integration is disconnected.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/github-lifecycle.spec.ts'],
  },
  {
    id: 'github-conflict-recovery-contract', journey: 'github-recovery-contract', execution: 'contract-pending-task41', route: '/github?step=import',
    roles: ['ADMIN', 'MAINTAINER'], states: ['conflict', 'retryable', 'permission'], viewport: PLATFORM_EXPANSION_VIEWPORTS[4], theme: 'system', zoom: 100,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-id'], action: 'Await Task41 published recovery selectors and idempotency assertions.',
    observedOutcome: 'No Task41 browser claim is made until its fixture contract is composed.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/github-lifecycle.spec.ts'],
  },
  {
    id: 'project-settings-stale-save', journey: 'project-settings-save', execution: 'fixture-driver', route: '/org/raibit/projects/prj_fixture_001?view=settings',
    roles: ['MAINTAINER'], states: ['loading', 'pending', 'success', 'conflict', 'permission'], viewport: PLATFORM_EXPANSION_VIEWPORTS[5], theme: 'light', zoom: 100,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-korean'], action: 'Save a dirty name with the rendered expectedUpdatedAt and attempt stale reload.',
    observedOutcome: 'PATCH uses the rendered version; stale local state receives a reload prompt and deletion remains server-denied.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/project-settings.spec.ts'],
  },
  {
    id: 'service-settings-preview-validation', journey: 'service-settings-preview', execution: 'fixture-driver', route: '/org/raibit/projects/prj_fixture_001?view=edit-service&serviceId=svc_fixture_web',
    roles: ['DEVELOPER'], states: ['empty', 'loading', 'success', 'permission'], viewport: PLATFORM_EXPANSION_VIEWPORTS[0], theme: 'system', zoom: 200,
    accessibility: ['keyboard', 'axe', 'zoom-200', 'long-id'], action: 'Preview valid settings and block invalid health and resource inputs before mutation.',
    observedOutcome: 'The preview is visible only for valid input and saving does not create a deployment.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/service-settings.spec.ts'],
  },
  {
    id: 'deployment-retry-successor', journey: 'deployment-retry', execution: 'fixture-driver', route: '/org/raibit/projects/prj_fixture_001?view=deployments&serviceId=svc_fixture_web',
    roles: ['ADMIN'], states: ['pending', 'success', 'permission', 'terminal'], viewport: PLATFORM_EXPANSION_VIEWPORTS[1], theme: 'dark', zoom: 100,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'long-id'], action: 'Confirm a failed deployment retry.',
    observedOutcome: 'POST sends an idempotency key and snapshot version, then links the server-created successor.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/deployment-history.spec.ts'],
  },
  {
    id: 'runtime-stream-degraded', journey: 'runtime-stream', execution: 'fixture-driver', route: '/org/raibit/projects/prj_fixture_001?view=logs&serviceId=svc_fixture_worker',
    roles: ['VIEWER'], states: ['loading', 'success', 'degraded'], viewport: PLATFORM_EXPANSION_VIEWPORTS[2], theme: 'light', zoom: 100,
    accessibility: ['keyboard', 'axe', 'reduced-motion', 'long-id'], action: 'Change the selected service and force stream failure.',
    observedOutcome: 'The old stream closes, selected-service logs replace it, and repeated SSE failures enter bounded fallback.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/task-20-runtime-logs.spec.ts'],
  },
  {
    id: 'resource-backup-restore', journey: 'resource-recovery', execution: 'fixture-driver', route: '/org/raibit/projects/prj_fixture_001/resources/res_fixture_pg/console?view=backups',
    roles: ['DB_ADMIN'], states: ['empty', 'pending', 'success', 'terminal', 'permission'], viewport: PLATFORM_EXPANSION_VIEWPORTS[3], theme: 'system', zoom: 200,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'zoom-200', 'long-korean'], action: 'Create a backup, request restore, and confirm deletion.',
    observedOutcome: 'Each request uses its public payload and only the selected backup state changes.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/task-26-resource-recovery.spec.ts'],
  },
  {
    id: 'custom-domain-one-time-challenge', journey: 'custom-domain-create', execution: 'fixture-driver', route: '/org/raibit/projects/prj_fixture_001?view=domains',
    roles: ['OWNER'], states: ['loading', 'pending', 'success', 'terminal', 'permission'], viewport: PLATFORM_EXPANSION_VIEWPORTS[5], theme: 'dark', zoom: 100,
    accessibility: ['keyboard', 'screen-reader-announcement', 'axe', 'reduced-motion', 'long-korean', 'long-id'], action: 'Create a custom domain and acknowledge its one-time TXT proof.',
    observedOutcome: 'The generated URL remains first; raw TXT proof disappears after acknowledgement and non-READY hosts remain unopened.',
    sourceRefs: ['apps/dashboard/tests/e2e/specs/project-domains.spec.ts'],
  },
] as const satisfies readonly PlatformExpansionRow[];

export const PLATFORM_EXPANSION_EXECUTABLE_ROWS = PLATFORM_EXPANSION_MATRIX.filter((row) => row.execution === 'fixture-driver');
export const PLATFORM_EXPANSION_CONTRACT_PENDING_ROWS = PLATFORM_EXPANSION_MATRIX.filter((row) => row.execution === 'contract-pending-task41');
